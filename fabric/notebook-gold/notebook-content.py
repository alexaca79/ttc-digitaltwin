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

from pyspark.sql.functions import coalesce, col, lit, regexp_replace, trim

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

    # Rapid transit stations come from static GTFS only. The realtime feed
    # does not publish vehicles for these routes, so this is infrastructure
    # context for the map, never a live position.
    summary["stage"] = "stations"
    routes = spark.read.format("delta").load(f"{lakehouse_abfss}/Tables/bronze_routes")
    trips = spark.read.format("delta").load(f"{lakehouse_abfss}/Tables/bronze_trips")
    stop_times = spark.read.format("delta").load(f"{lakehouse_abfss}/Tables/bronze_stop_times")
    stops = spark.read.format("delta").load(f"{lakehouse_abfss}/Tables/bronze_stops")

    # Route type 0 covers streetcars and LRT. TTC names only its rapid transit
    # lines "<name> Line", which excludes streetcar loops that happen to stop
    # at a subway station.
    rapid = routes.where(
        (col("route_type") == "0") & col("route_long_name").endswith(" Line")
    ).select(
        col("route_id"),
        col("route_short_name").alias("RouteId"),
        col("route_long_name").alias("RouteName"),
    )

    def stations_for(routes_df, trips_df, times_df, stops_df, agency):
        """Collapse per-direction platform rows into one row per station."""
        return (
            routes_df.join(trips_df.select("route_id", "trip_id"), "route_id")
            .join(times_df.select("trip_id", "stop_id"), "trip_id")
            .join(
                stops_df.select("stop_id", "stop_name", "stop_lat", "stop_lon"),
                "stop_id",
            )
            .select(
                lit(agency).alias("Agency"),
                col("RouteId"),
                col("RouteName"),
                trim(regexp_replace(col("stop_name"), r" - .*$", "")).alias("StationName"),
                col("stop_lat").cast("double").alias("Latitude"),
                col("stop_lon").cast("double").alias("Longitude"),
            )
            .where(col("Latitude").isNotNull() & col("Longitude").isNotNull())
            .distinct()
        )

    ttc_stations = stations_for(rapid, trips, stop_times, stops, "TTC")

    # GO Transit rail corridors extend the view across the region. Route type 2
    # is heavy rail, which excludes the GO bus network.
    go_routes = spark.read.format("delta").load(f"{lakehouse_abfss}/Tables/bronze_go_routes")
    go_trips = spark.read.format("delta").load(f"{lakehouse_abfss}/Tables/bronze_go_trips")
    go_times = spark.read.format("delta").load(f"{lakehouse_abfss}/Tables/bronze_go_stop_times")
    go_stops = spark.read.format("delta").load(f"{lakehouse_abfss}/Tables/bronze_go_stops")

    go_rail = go_routes.where(col("route_type") == "2").select(
        col("route_id"),
        col("route_short_name").alias("RouteId"),
        col("route_long_name").alias("RouteName"),
    )
    go_stations = stations_for(go_rail, go_trips, go_times, go_stops, "GO Transit")

    stations = ttc_stations.unionByName(go_stations)

    station_target = f"{lakehouse_abfss}/Tables/gold_rapid_transit_stations"
    (
        stations.write.mode("overwrite")
        .option("overwriteSchema", "true")
        .format("delta")
        .save(station_target)
    )
    summary["stations"] = spark.read.format("delta").load(station_target).count()

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
