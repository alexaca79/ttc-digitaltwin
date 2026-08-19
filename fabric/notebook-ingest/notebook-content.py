# Fabric notebook source

# METADATA ********************

# META {
# META   "kernel_info": {
# META     "name": "synapse_pyspark"
# META   },
# META   "dependencies": {}
# META }

# MARKDOWN ********************

# ## TTC native ingest
#
# Fetches TTC GTFS-realtime directly, decodes the protobuf, derives schedule
# adherence from the gold Lakehouse table, and writes into the `TTCOperations`
# Eventhouse where KQL serves the live application.
#
# One run polls for `run_duration_seconds`, sleeping `poll_seconds` between
# cycles. Schedule it to match the duration for continuous coverage.

# CELL ********************

# Job runs do not reliably honour %pip, so install into the live interpreter.
import importlib
import subprocess
import sys

if importlib.util.find_spec("google.transit") is None:
    subprocess.check_call(
        [sys.executable, "-m", "pip", "install", "--quiet", "gtfs-realtime-bindings==1.0.0"]
    )
    importlib.invalidate_caches()

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# PARAMETERS CELL ********************

kql_cluster_uri = "{{KQL_CLUSTER_URI}}"
kql_database = "TTCOperations"
lakehouse_abfss = "{{LAKEHOUSE_ABFSS}}"
feed_base_url = "https://bustime.ttc.ca/gtfsrt"
poll_seconds = 15
run_duration_seconds = 60

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

import time
from datetime import datetime, timezone

import requests
from google.transit import gtfs_realtime_pb2
from pyspark.sql import functions as F
from pyspark.sql.types import (
    ArrayType,
    LongType,
    DoubleType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)

KUSTO_FORMAT = "com.microsoft.kusto.spark.synapse.datasource"
SUBWAY_ROUTES = {"1", "2", "3", "4"}
SECONDS_PER_DAY = 24 * 60 * 60
HALF_DAY_SECONDS = SECONDS_PER_DAY // 2

# GTFS-realtime VehicleStopStatus, named to match the existing publisher output.
STOP_STATUS = {0: "INCOMING_AT", 1: "STOPPED_AT", 2: "IN_TRANSIT_TO"}

VEHICLE_SCHEMA = StructType(
    [
        StructField("EventId", StringType()),
        StructField("ObservedAt", TimestampType()),
        StructField("VehicleId", StringType()),
        StructField("VehicleLabel", StringType()),
        StructField("TripId", StringType()),
        StructField("RouteId", StringType()),
        StructField("Mode", StringType()),
        StructField("Latitude", DoubleType()),
        StructField("Longitude", DoubleType()),
        StructField("Bearing", DoubleType()),
        StructField("SpeedKph", DoubleType()),
        StructField("Occupancy", StringType()),
        StructField("StopId", StringType()),
        StructField("CurrentStatus", StringType()),
        StructField("Source", StringType()),
    ]
)

TRIP_SCHEMA = StructType(
    [
        StructField("EventId", StringType()),
        StructField("ObservedAt", TimestampType()),
        StructField("TripId", StringType()),
        StructField("RouteId", StringType()),
        StructField("VehicleId", StringType()),
        StructField("StopId", StringType()),
        StructField("StopSequence", LongType()),
        StructField("ArrivalEpochSeconds", LongType()),
        StructField("DepartureEpochSeconds", LongType()),
        StructField("DelaySeconds", LongType()),
        StructField("Source", StringType()),
    ]
)

ALERT_SCHEMA = StructType(
    [
        StructField("EventId", StringType()),
        StructField("ObservedAt", TimestampType()),
        StructField("AlertId", StringType()),
        StructField("Severity", StringType()),
        StructField("Title", StringType()),
        StructField("Description", StringType()),
        StructField("RouteIds", ArrayType(StringType())),
        StructField("Cause", StringType()),
        StructField("Effect", StringType()),
        StructField("ActiveStartEpochSeconds", LongType()),
        StructField("ActiveEndEpochSeconds", LongType()),
        StructField("Source", StringType()),
    ]
)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

def fetch_feed(name):
    response = requests.get(
        f"{feed_base_url}/{name}",
        headers={
            "Accept": "application/x-protobuf, application/octet-stream",
            "User-Agent": "ttc-digital-twin-open-data/1.0",
        },
        timeout=15,
    )
    response.raise_for_status()
    content_type = response.headers.get("content-type", "")
    if "protobuf" not in content_type and "octet-stream" not in content_type:
        raise ValueError(f"{name} returned '{content_type}' instead of protobuf")
    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(response.content)
    return feed


def transit_mode(route_id):
    if route_id in SUBWAY_ROUTES:
        return "subway"
    if route_id.startswith("5") and len(route_id) == 3:
        return "streetcar"
    return "bus"


def occupancy_label(value):
    if value is None:
        return "unknown"
    if value <= 1:
        return "low"
    if value <= 4:
        return "medium"
    return "high"


def as_datetime(epoch_seconds, fallback):
    if not epoch_seconds:
        return fallback
    return datetime.fromtimestamp(int(epoch_seconds), tz=timezone.utc)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

def build_trip_rows(feed, observed_at):
    rows = []
    for entity in feed.entity:
        if not entity.HasField("trip_update"):
            continue
        update = entity.trip_update
        stamp = as_datetime(update.timestamp, observed_at)
        for stop_time in update.stop_time_update:
            delay = None
            if stop_time.HasField("arrival") and stop_time.arrival.HasField("delay"):
                delay = int(stop_time.arrival.delay)
            elif stop_time.HasField("departure") and stop_time.departure.HasField("delay"):
                delay = int(stop_time.departure.delay)
            rows.append(
                (
                    f"{entity.id}:{stop_time.stop_sequence}",
                    stamp,
                    update.trip.trip_id or "",
                    update.trip.route_id or "",
                    update.vehicle.id or "",
                    stop_time.stop_id or "",
                    int(stop_time.stop_sequence),
                    int(stop_time.arrival.time) if stop_time.HasField("arrival") else 0,
                    int(stop_time.departure.time) if stop_time.HasField("departure") else 0,
                    delay,
                    "ttc-gtfs-rt",
                )
            )
    return rows


def build_vehicle_rows(feed, observed_at):
    rows = []
    for entity in feed.entity:
        if not entity.HasField("vehicle"):
            continue
        vehicle = entity.vehicle
        route_id = vehicle.trip.route_id or ""
        rows.append(
            (
                entity.id,
                as_datetime(vehicle.timestamp, observed_at),
                vehicle.vehicle.id or entity.id,
                vehicle.vehicle.label or vehicle.vehicle.id or entity.id,
                vehicle.trip.trip_id or "",
                route_id,
                transit_mode(route_id),
                float(vehicle.position.latitude),
                float(vehicle.position.longitude),
                float(vehicle.position.bearing),
                float(vehicle.position.speed) * 3.6,
                occupancy_label(
                    vehicle.occupancy_status if vehicle.HasField("occupancy_status") else None
                ),
                vehicle.stop_id or "",
                STOP_STATUS.get(vehicle.current_status, "UNKNOWN"),
                "ttc-gtfs-rt",
            )
        )
    return rows


def build_alert_rows(feed, observed_at):
    rows = []
    for entity in feed.entity:
        if not entity.HasField("alert"):
            continue
        alert = entity.alert
        header = alert.header_text.translation[0].text if alert.header_text.translation else ""
        body = alert.description_text.translation[0].text if alert.description_text.translation else ""
        route_ids = [s.route_id for s in alert.informed_entity if s.route_id]
        active = alert.active_period[0] if alert.active_period else None
        rows.append(
            (
                entity.id,
                observed_at,
                entity.id,
                "warning",
                header,
                body,
                route_ids,
                str(alert.cause),
                str(alert.effect),
                int(active.start) if active and active.start else 0,
                int(active.end) if active and active.end else 0,
                "ttc-gtfs-rt",
            )
        )
    return rows

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

def load_schedule():
    """Gold lookup produced by the medallion notebooks. Absence is tolerated."""
    if not lakehouse_abfss:
        return None
    try:
        return spark.read.format("delta").load(f"{lakehouse_abfss}/Tables/gold_schedule_lookup")
    except Exception as error:  # noqa: BLE001 - reported through the run summary
        print(f"gold_schedule_lookup unavailable: {error}")
        return None


def deviation_by_trip(trip_df, schedule_df):
    """
    Compares each predicted stop time against the published schedule and wraps
    the difference into +/- 12 hours, matching the publisher's calculation.
    """
    predicted = trip_df.select(
        "TripId",
        "StopSequence",
        F.coalesce(
            F.when(F.col("ArrivalEpochSeconds") > 0, F.col("ArrivalEpochSeconds")),
            F.when(F.col("DepartureEpochSeconds") > 0, F.col("DepartureEpochSeconds")),
        ).alias("PredictedEpochSeconds"),
    ).where(F.col("PredictedEpochSeconds").isNotNull())

    local = F.from_utc_timestamp(
        F.to_timestamp(F.col("PredictedEpochSeconds")), "America/Toronto"
    )
    predicted = predicted.withColumn(
        "PredictedSecondOfDay",
        F.hour(local) * 3600 + F.minute(local) * 60 + F.second(local),
    )

    joined = predicted.join(schedule_df, ["TripId", "StopSequence"], "inner").withColumn(
        "RawDifference",
        F.col("PredictedSecondOfDay") - (F.col("ScheduledSeconds") % F.lit(SECONDS_PER_DAY)),
    )

    wrapped = joined.withColumn(
        "Deviation",
        (
            (
                (F.col("RawDifference") + F.lit(HALF_DAY_SECONDS)) % F.lit(SECONDS_PER_DAY)
                + F.lit(SECONDS_PER_DAY)
            )
            % F.lit(SECONDS_PER_DAY)
        )
        - F.lit(HALF_DAY_SECONDS),
    )

    # The earliest upcoming stop best represents how the vehicle is running now.
    earliest = wrapped.groupBy("TripId").agg(
        F.min(F.struct("StopSequence", "Deviation")).alias("earliest")
    )
    return earliest.select(
        "TripId",
        F.col("earliest.Deviation").cast(LongType()).alias("ScheduleDeviationSeconds"),
    )


def classify(frame):
    return frame.withColumn(
        "State",
        F.when(F.col("ScheduleDeviationSeconds").isNull(), F.lit("unknown"))
        .when(F.col("ScheduleDeviationSeconds") > 180, F.lit("delayed"))
        .when(F.col("ScheduleDeviationSeconds") < -120, F.lit("early"))
        .otherwise(F.lit("on-time")),
    )


def kusto_token():
    for audience in (kql_cluster_uri, "kusto"):
        try:
            return notebookutils.credentials.getToken(audience)
        except Exception:  # noqa: BLE001 - fall through to the next audience
            continue
    raise RuntimeError("Could not acquire a Kusto access token.")


def write_to_eventhouse(frame, table):
    (
        frame.write.format(KUSTO_FORMAT)
        .option("kustoCluster", kql_cluster_uri)
        .option("kustoDatabase", kql_database)
        .option("kustoTable", table)
        .option("accessToken", kusto_token())
        .mode("Append")
        .save()
    )

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

import json
import traceback

VEHICLE_OUTPUT_COLUMNS = [
    "EventId",
    "ObservedAt",
    "VehicleId",
    "VehicleLabel",
    "TripId",
    "RouteId",
    "Mode",
    "Latitude",
    "Longitude",
    "Bearing",
    "SpeedKph",
    "ScheduleDeviationSeconds",
    "Occupancy",
    "State",
    "StopId",
    "CurrentStatus",
    "Source",
]

summary = {"ok": False, "stage": "start"}

try:
    summary["stage"] = "parameters"
    if not kql_cluster_uri:
        raise ValueError("kql_cluster_uri parameter is required.")

    summary["stage"] = "schedule"
    schedule = load_schedule()
    summary["scheduleAvailable"] = schedule is not None
    if schedule is not None:
        schedule = schedule.select("TripId", "StopSequence", "ScheduledSeconds").cache()
        summary["scheduleRows"] = schedule.count()

    deadline = time.monotonic() + float(run_duration_seconds)
    totals = {"vehicles": 0, "trips": 0, "alerts": 0, "enriched": 0}
    cycle = 0

    while True:
        started = time.monotonic()
        cycle += 1
        observed_at = datetime.now(tz=timezone.utc)

        summary["stage"] = f"fetch:{cycle}"
        trip_rows = build_trip_rows(fetch_feed("trips"), observed_at)
        vehicle_rows = build_vehicle_rows(fetch_feed("vehicles"), observed_at)
        alert_rows = build_alert_rows(fetch_feed("alerts"), observed_at)

        summary["stage"] = f"enrich:{cycle}"
        trip_df = spark.createDataFrame(trip_rows, schema=TRIP_SCHEMA)
        vehicle_df = spark.createDataFrame(vehicle_rows, schema=VEHICLE_SCHEMA)

        if schedule is not None:
            deviations = deviation_by_trip(trip_df, schedule)
            vehicle_df = vehicle_df.join(F.broadcast(deviations), ["TripId"], "left")
        else:
            vehicle_df = vehicle_df.withColumn(
                "ScheduleDeviationSeconds", F.lit(None).cast(LongType())
            )

        vehicle_df = classify(vehicle_df).select(*VEHICLE_OUTPUT_COLUMNS).cache()
        enriched = vehicle_df.where(F.col("ScheduleDeviationSeconds").isNotNull()).count()

        summary["stage"] = f"write:{cycle}"
        write_to_eventhouse(vehicle_df, "VehiclePositions")
        if trip_rows:
            write_to_eventhouse(trip_df, "TripUpdates")
        if alert_rows:
            write_to_eventhouse(
                spark.createDataFrame(alert_rows, schema=ALERT_SCHEMA), "ServiceAlerts"
            )

        totals["vehicles"] += len(vehicle_rows)
        totals["trips"] += len(trip_rows)
        totals["alerts"] += len(alert_rows)
        totals["enriched"] += enriched
        vehicle_df.unpersist()

        print(f"cycle {cycle}: {totals}")
        if time.monotonic() >= deadline:
            break
        time.sleep(max(0.0, poll_seconds - (time.monotonic() - started)))

    summary.update({"ok": True, "stage": "done", "cycles": cycle, "totals": totals})

except Exception as error:  # noqa: BLE001 - surfaced through the job exit value
    summary["error"] = f"{type(error).__name__}: {error}"
    summary["trace"] = traceback.format_exc()[-1500:]

print(json.dumps(summary))
notebookutils.notebook.exit(json.dumps(summary))

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
