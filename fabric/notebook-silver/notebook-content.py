# Fabric notebook source

# METADATA ********************

# META {
# META   "kernel_info": {
# META     "name": "synapse_pyspark"
# META   },
# META   "dependencies": {}
# META }

# MARKDOWN ********************

# ## Silver: type and clean the static GTFS tables
#
# Parses GTFS clock times into seconds past midnight. GTFS allows values beyond
# `24:00:00` for trips crossing midnight, so the components are parsed directly
# rather than cast to a timestamp.

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

from pyspark.sql.functions import col, split
from pyspark.sql.types import IntegerType

summary = {"ok": False, "stage": "start", "layer": "silver"}

try:
    if not lakehouse_abfss:
        raise ValueError("lakehouse_abfss parameter is required.")

    summary["stage"] = "read-bronze"
    bronze = spark.read.format("delta").load(f"{lakehouse_abfss}/Tables/bronze_stop_times")

    summary["stage"] = "transform"
    parts = bronze.select(
        col("trip_id").alias("TripId"),
        col("stop_id").alias("StopId"),
        col("stop_sequence").cast(IntegerType()).alias("StopSequence"),
        split(col("arrival_time"), ":").alias("arrival"),
        split(col("departure_time"), ":").alias("departure"),
    )

    def clock_to_seconds(column):
        return (
            column[0].cast(IntegerType()) * 3600
            + column[1].cast(IntegerType()) * 60
            + column[2].cast(IntegerType())
        )

    silver = (
        parts.select(
            "TripId",
            "StopId",
            "StopSequence",
            clock_to_seconds(parts.arrival).alias("ArrivalSeconds"),
            clock_to_seconds(parts.departure).alias("DepartureSeconds"),
        )
        .where(col("TripId").isNotNull())
        .where(col("StopSequence").isNotNull())
        .where(col("ArrivalSeconds").isNotNull() | col("DepartureSeconds").isNotNull())
        .dropDuplicates(["TripId", "StopSequence"])
    )

    summary["stage"] = "write"
    target = f"{lakehouse_abfss}/Tables/silver_stop_times"
    silver.write.mode("overwrite").option("overwriteSchema", "true").format("delta").save(target)
    summary["rows"] = spark.read.format("delta").load(target).count()
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
