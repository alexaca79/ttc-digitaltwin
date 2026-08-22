# Fabric notebook source

# METADATA ********************

# META {
# META   "kernel_info": {
# META     "name": "synapse_pyspark"
# META   },
# META   "dependencies": {}
# META }

# MARKDOWN ********************

# ## Bronze: land the TTC static GTFS archive
#
# Downloads the City of Toronto GTFS zip and lands `stop_times` and `trips`
# exactly as published, with no typing or filtering. Chains silver and gold so a
# single daily schedule refreshes the whole medallion.

# PARAMETERS CELL ********************

lakehouse_abfss = "{{LAKEHOUSE_ABFSS}}"
gtfs_zip_url = "https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/b811ead4-6eaf-4adb-8408-d389fb5a069c/resource/c920e221-7a1c-488b-8c5b-6d8cd4e85eaf/download/Complete%20GTFS.zip"
go_gtfs_zip_url = "https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/GO-GTFS.zip"
chain_downstream = True

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

import json
import os
import tempfile
import traceback
import zipfile
from datetime import datetime, timezone

import requests
from pyspark.sql.functions import lit

MEMBERS = {
    "stop_times": "stop_times.txt",
    "trips": "trips.txt",
    "routes": "routes.txt",
    "stops": "stops.txt",
}

# Two agencies, landed side by side. TTC keeps the unprefixed table names so
# the existing silver and gold contracts are unchanged.
SOURCES = [
    {"prefix": "", "url": gtfs_zip_url},
    {"prefix": "go_", "url": go_gtfs_zip_url},
]

summary = {"ok": False, "stage": "start", "layer": "bronze"}

try:
    if not lakehouse_abfss:
        raise ValueError("lakehouse_abfss parameter is required.")

    ingested_at = datetime.now(tz=timezone.utc).isoformat()
    counts = {}

    for source in SOURCES:
        prefix = source["prefix"]
        url = source["url"]
        label = prefix or "ttc_"

        summary["stage"] = f"download:{label}"
        work_dir = tempfile.mkdtemp()
        archive_path = os.path.join(work_dir, "gtfs.zip")
        with requests.get(url, stream=True, timeout=1800) as response:
            response.raise_for_status()
            with open(archive_path, "wb") as handle:
                for chunk in response.iter_content(chunk_size=4 * 1024 * 1024):
                    handle.write(chunk)
        summary[f"archiveBytes:{label}"] = os.path.getsize(archive_path)

        with zipfile.ZipFile(archive_path) as archive:
            names = archive.namelist()
            for table, filename in MEMBERS.items():
                summary["stage"] = f"extract:{prefix}{table}"
                member = next(n for n in names if n.endswith(filename))
                extracted = archive.extract(member, work_dir)

                staged = f"{lakehouse_abfss}/Files/gtfs/{prefix}{filename}"
                notebookutils.fs.cp(f"file://{extracted}", staged, True)

                summary["stage"] = f"land:{prefix}{table}"
                # Bronze keeps every column as published; only provenance is added.
                frame = (
                    spark.read.csv(staged, header=True)
                    .withColumn("IngestedAt", lit(ingested_at))
                    .withColumn("SourceUrl", lit(url))
                )
                target = f"{lakehouse_abfss}/Tables/bronze_{prefix}{table}"
                frame.write.mode("overwrite").option("overwriteSchema", "true").format("delta").save(target)
                counts[f"{prefix}{table}"] = spark.read.format("delta").load(target).count()

    summary["rows"] = counts
    summary.update({"ok": True, "stage": "done"})

except Exception as error:  # noqa: BLE001 - surfaced through the job exit value
    summary["error"] = f"{type(error).__name__}: {error}"
    summary["trace"] = traceback.format_exc()[-1200:]

print(json.dumps(summary))

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

if summary.get("ok") and chain_downstream:
    for stage in ("TTCScheduleSilver", "TTCScheduleGold"):
        summary["stage"] = f"chain:{stage}"
        result = notebookutils.notebook.run(stage, 1800, {"lakehouse_abfss": lakehouse_abfss})
        summary[stage] = json.loads(result) if result else None
        if not summary[stage] or not summary[stage].get("ok"):
            summary["ok"] = False
            break

print(json.dumps(summary))
notebookutils.notebook.exit(json.dumps(summary))

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
