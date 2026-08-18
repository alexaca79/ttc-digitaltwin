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
# adherence, and writes into the `TTCOperations` Eventhouse. No container, no
# Eventstream, no Kafka hop.
#
# One run polls for `run_duration_seconds`, sleeping `poll_seconds` between
# cycles. Schedule it every minute with a matching duration for continuous
# coverage.

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

kql_cluster_uri = ""
kql_database = "TTCOperations"
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
FEED_PATHS = {"vehicles": "vehicles", "trips": "trips", "alerts": "alerts"}
SUBWAY_ROUTES = {"1", "2", "3", "4"}

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
        StructField("ScheduleDeviationSeconds", LongType()),
        StructField("Occupancy", StringType()),
        StructField("State", StringType()),
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
        f"{feed_base_url}/{FEED_PATHS[name]}",
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


def vehicle_state(deviation):
    if deviation is None:
        return "unknown"
    if deviation > 180:
        return "delayed"
    if deviation < -120:
        return "early"
    return "on-time"


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
    """Trip rows plus a trip-to-delay map used to enrich vehicle positions."""
    rows = []
    delay_by_trip = {}
    for entity in feed.entity:
        if not entity.HasField("trip_update"):
            continue
        update = entity.trip_update
        trip_id = update.trip.trip_id or ""
        stamp = as_datetime(update.timestamp, observed_at)
        for stop_time in update.stop_time_update:
            delay = None
            if stop_time.HasField("arrival") and stop_time.arrival.HasField("delay"):
                delay = int(stop_time.arrival.delay)
            elif stop_time.HasField("departure") and stop_time.departure.HasField("delay"):
                delay = int(stop_time.departure.delay)
            if delay is not None and trip_id and trip_id not in delay_by_trip:
                delay_by_trip[trip_id] = delay
            rows.append(
                (
                    f"{entity.id}:{stop_time.stop_sequence}",
                    stamp,
                    trip_id,
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
    return rows, delay_by_trip


def build_vehicle_rows(feed, observed_at, delay_by_trip):
    rows = []
    for entity in feed.entity:
        if not entity.HasField("vehicle"):
            continue
        vehicle = entity.vehicle
        route_id = vehicle.trip.route_id or ""
        trip_id = vehicle.trip.trip_id or ""
        deviation = delay_by_trip.get(trip_id)
        rows.append(
            (
                entity.id,
                as_datetime(vehicle.timestamp, observed_at),
                vehicle.vehicle.id or entity.id,
                vehicle.vehicle.label or vehicle.vehicle.id or entity.id,
                trip_id,
                route_id,
                transit_mode(route_id),
                float(vehicle.position.latitude),
                float(vehicle.position.longitude),
                float(vehicle.position.bearing),
                float(vehicle.position.speed) * 3.6,
                deviation,
                occupancy_label(
                    vehicle.occupancy_status if vehicle.HasField("occupancy_status") else None
                ),
                vehicle_state(deviation),
                vehicle.stop_id or "",
                str(vehicle.current_status),
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

def kusto_token():
    for audience in (kql_cluster_uri, "kusto"):
        try:
            return notebookutils.credentials.getToken(audience)
        except Exception:  # noqa: BLE001 - fall through to the next audience
            continue
    raise RuntimeError("Could not acquire a Kusto access token.")


def write_rows(rows, schema, table):
    if not rows:
        return 0
    dataframe = spark.createDataFrame(rows, schema=schema)
    (
        dataframe.write.format(KUSTO_FORMAT)
        .option("kustoCluster", kql_cluster_uri)
        .option("kustoDatabase", kql_database)
        .option("kustoTable", table)
        .option("accessToken", kusto_token())
        .mode("Append")
        .save()
    )
    return len(rows)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

import json
import traceback

summary = {"ok": False, "stage": "start"}

try:
    summary["stage"] = "parameters"
    summary["kqlClusterUriSupplied"] = bool(kql_cluster_uri)
    summary["runDurationSeconds"] = run_duration_seconds
    if not kql_cluster_uri:
        raise ValueError("kql_cluster_uri parameter is required.")

    summary["stage"] = "connector"
    spark.conf.get("spark.app.name")

    deadline = time.monotonic() + float(run_duration_seconds)
    cycle = 0
    totals = {"vehicles": 0, "trips": 0, "alerts": 0, "enriched": 0}

    while True:
        started = time.monotonic()
        cycle += 1

        summary["stage"] = f"fetch:{cycle}"
        observed_at = datetime.now(tz=timezone.utc)
        trip_feed = fetch_feed("trips")
        trip_rows, delay_by_trip = build_trip_rows(trip_feed, observed_at)
        vehicle_rows = build_vehicle_rows(fetch_feed("vehicles"), observed_at, delay_by_trip)
        alert_rows = build_alert_rows(fetch_feed("alerts"), observed_at)

        summary["stage"] = f"write:{cycle}"
        totals["vehicles"] += write_rows(vehicle_rows, VEHICLE_SCHEMA, "VehiclePositions")
        totals["trips"] += write_rows(trip_rows, TRIP_SCHEMA, "TripUpdates")
        totals["alerts"] += write_rows(alert_rows, ALERT_SCHEMA, "ServiceAlerts")
        totals["enriched"] += sum(1 for row in vehicle_rows if row[11] is not None)

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
