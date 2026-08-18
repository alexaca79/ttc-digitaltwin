# Fabric notebook source

# METADATA ********************

# META {
# META   "kernel_info": {
# META     "name": "synapse_pyspark"
# META   },
# META   "dependencies": {}
# META }

# MARKDOWN ********************

# ## Gold: schedule lookup for real-time adherence
#
# Serves one row per trip and stop sequence, which is the exact grain the live
# ingest notebook joins against when deriving `ScheduleDeviationSeconds`.

# PARAMETERS CELL ********************

lakehouse_abfss = "{{LAKEHOUSE_ABFSS}}"

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

import json
import traceback

from pyspark.sql.functions import coalesce, col

summary = {"ok": False, "stage": "start", "layer": "gold"}

try:
    if not lakehouse_abfss:
        raise ValueError("lakehouse_abfss parameter is required.")

    summary["stage"] = "read-silver"
    silver = spark.read.format("delta").load(f"{lakehouse_abfss}/Tables/silver_stop_times")

    summary["stage"] = "transform"
    gold = silver.select(
        col("TripId"),
        col("StopSequence"),
        col("StopId"),
        # Arrival drives adherence; departure covers the first stop of a trip.
        coalesce(col("ArrivalSeconds"), col("DepartureSeconds")).alias("ScheduledSeconds"),
    ).where(col("ScheduledSeconds").isNotNull())

    summary["stage"] = "write"
    target = f"{lakehouse_abfss}/Tables/gold_schedule_lookup"
    (
        gold.repartition("TripId")
        .write.mode("overwrite")
        .option("overwriteSchema", "true")
        .format("delta")
        .save(target)
    )

    written = spark.read.format("delta").load(target)
    summary["rows"] = written.count()
    summary["trips"] = written.select("TripId").distinct().count()
    summary.update({"ok": True, "stage": "done"})

except Exception as error:  # noqa: BLE001 - surfaced through the job exit value
    summary["error"] = f"{type(error).__name__}: {error}"
    summary["trace"] = traceback.format_exc()[-1200:]

print(json.dumps(summary))
notebookutils.notebook.exit(json.dumps(summary))

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
