# Fabric notebook source

# METADATA ********************

# META {
# META   "kernel_info": {
# META     "name": "synapse_pyspark"
# META   },
# META   "dependencies": {}
# META }

# MARKDOWN ********************

# ## TTC feed decoder
#
# Consumes raw GTFS-realtime protobuf forwarded by the publisher, decodes it in
# Fabric, enriches vehicle positions with schedule adherence, and writes the
# typed tables into the `TTCOperations` Eventhouse.
#
# Eventstream injects `__in_eventstream_item_id` and `__in_eventstream_datasource_id`
# when it starts this notebook as a destination.

# CELL ********************

%pip install --quiet gtfs-realtime-bindings==1.0.0

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# Parameters. Eventstream overwrites the first two when it launches the job.
__in_eventstream_item_id = ""
__in_eventstream_datasource_id = ""
kql_cluster_uri = ""
kql_database = "TTCOperations"
schedule_table = ""

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark",
# META   "tags": ["parameters"]
# META }

# CELL ********************

import base64
import gzip
from datetime import datetime, timezone

from google.transit import gtfs_realtime_pb2
from pyspark.sql import Row
from pyspark.sql.functions import col
from pyspark.sql.types import StringType

KUSTO_FORMAT = "com.microsoft.kusto.spark.synapse.datasource"

SUBWAY_ROUTES = {"1", "2", "3", "4"}
STREETCAR_PREFIX = "5"


def transit_mode(route_id: str) -> str:
    """Mirrors the mode classification the TypeScript publisher applied."""
    if route_id in SUBWAY_ROUTES:
        return "subway"
    if route_id.startswith(STREETCAR_PREFIX) and len(route_id) == 3:
        return "streetcar"
    return "bus"


def vehicle_state(deviation_seconds):
    if deviation_seconds is None:
        return "unknown"
    if deviation_seconds > 180:
        return "delayed"
    if deviation_seconds < -120:
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


def decode_feed(encoded: str):
    """gzip+base64 envelope back into a parsed FeedMessage."""
    raw = gzip.decompress(base64.b64decode(encoded))
    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(raw)
    return feed


def iso(epoch_seconds):
    if not epoch_seconds:
        return None
    return datetime.fromtimestamp(epoch_seconds, tz=timezone.utc).isoformat()

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

def vehicle_rows(feed, observed_at):
    rows = []
    for entity in feed.entity:
        if not entity.HasField("vehicle"):
            continue
        vehicle = entity.vehicle
        route_id = vehicle.trip.route_id or ""
        position = vehicle.position
        rows.append(
            Row(
                EventId=entity.id,
                ObservedAt=iso(vehicle.timestamp) or observed_at,
                VehicleId=vehicle.vehicle.id or entity.id,
                VehicleLabel=vehicle.vehicle.label or vehicle.vehicle.id or entity.id,
                TripId=vehicle.trip.trip_id or "",
                RouteId=route_id,
                Mode=transit_mode(route_id),
                Latitude=float(position.latitude),
                Longitude=float(position.longitude),
                Bearing=float(position.bearing),
                SpeedKph=float(position.speed) * 3.6,
                ScheduleDeviationSeconds=None,
                Occupancy=occupancy_label(
                    vehicle.occupancy_status if vehicle.HasField("occupancy_status") else None
                ),
                State="unknown",
                StopId=vehicle.stop_id or "",
                CurrentStatus=str(vehicle.current_status),
                Source="ttc-gtfs-rt",
            )
        )
    return rows


def trip_rows(feed, observed_at):
    rows = []
    for entity in feed.entity:
        if not entity.HasField("trip_update"):
            continue
        update = entity.trip_update
        for stop_time in update.stop_time_update:
            delay = None
            if stop_time.HasField("arrival") and stop_time.arrival.HasField("delay"):
                delay = stop_time.arrival.delay
            elif stop_time.HasField("departure") and stop_time.departure.HasField("delay"):
                delay = stop_time.departure.delay
            rows.append(
                Row(
                    EventId=f"{entity.id}:{stop_time.stop_sequence}",
                    ObservedAt=iso(update.timestamp) or observed_at,
                    TripId=update.trip.trip_id or "",
                    RouteId=update.trip.route_id or "",
                    VehicleId=update.vehicle.id or "",
                    StopId=stop_time.stop_id or "",
                    StopSequence=int(stop_time.stop_sequence),
                    ArrivalEpochSeconds=int(stop_time.arrival.time) if stop_time.HasField("arrival") else 0,
                    DepartureEpochSeconds=int(stop_time.departure.time) if stop_time.HasField("departure") else 0,
                    DelaySeconds=delay,
                    Source="ttc-gtfs-rt",
                )
            )
    return rows


def alert_rows(feed, observed_at):
    rows = []
    for entity in feed.entity:
        if not entity.HasField("alert"):
            continue
        alert = entity.alert
        header = alert.header_text.translation[0].text if alert.header_text.translation else ""
        body = alert.description_text.translation[0].text if alert.description_text.translation else ""
        route_ids = [selector.route_id for selector in alert.informed_entity if selector.route_id]
        active = alert.active_period[0] if alert.active_period else None
        rows.append(
            Row(
                EventId=entity.id,
                ObservedAt=observed_at,
                AlertId=entity.id,
                Severity="warning",
                Title=header,
                Description=body,
                RouteIds=route_ids,
                Cause=str(alert.cause),
                Effect=str(alert.effect),
                ActiveStartEpochSeconds=int(active.start) if active and active.start else 0,
                ActiveEndEpochSeconds=int(active.end) if active and active.end else 0,
                Source="ttc-gtfs-rt",
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
    """Optional static GTFS lookup used to derive schedule adherence."""
    if not schedule_table:
        return None
    try:
        return spark.read.table(schedule_table).select(
            "TripId", "StopSequence", "ScheduledEpochSeconds"
        )
    except Exception as error:  # noqa: BLE001 - notebook surfaces the reason inline
        print(f"Schedule table '{schedule_table}' unavailable: {error}")
        return None


def write_to_eventhouse(dataframe, table):
    if dataframe.rdd.isEmpty():
        return
    access_token = notebookutils.credentials.getToken(kql_cluster_uri)
    (
        dataframe.write.format(KUSTO_FORMAT)
        .option("kustoCluster", kql_cluster_uri)
        .option("kustoDatabase", kql_database)
        .option("kustoTable", table)
        .option("accessToken", access_token)
        .mode("Append")
        .save()
    )

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

schedule = load_schedule()


def process_batch(batch_df, batch_id):
    envelopes = [row.asDict() for row in batch_df.collect()]
    vehicles, trips, alerts = [], [], []

    for envelope in envelopes:
        if envelope.get("eventType") != "RawFeed":
            continue
        observed_at = envelope.get("observedAt")
        feed = decode_feed(envelope["payload"])
        name = envelope.get("feed")
        if name == "vehicles":
            vehicles.extend(vehicle_rows(feed, observed_at))
        elif name == "trips":
            trips.extend(trip_rows(feed, observed_at))
        elif name == "alerts":
            alerts.extend(alert_rows(feed, observed_at))

    if vehicles:
        vehicle_df = spark.createDataFrame(vehicles)
        if schedule is not None:
            vehicle_df = vehicle_df.join(schedule, on=["TripId"], how="left")
        write_to_eventhouse(vehicle_df, "VehiclePositions")
    if trips:
        write_to_eventhouse(spark.createDataFrame(trips), "TripUpdates")
    if alerts:
        write_to_eventhouse(spark.createDataFrame(alerts), "ServiceAlerts")

    print(
        f"batch {batch_id}: {len(vehicles)} vehicles, {len(trips)} trip updates, {len(alerts)} alerts"
    )

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

import json

from pyspark.sql.functions import from_json
from pyspark.sql.types import IntegerType, StructField, StructType

envelope_schema = StructType(
    [
        StructField("eventType", StringType()),
        StructField("eventId", StringType()),
        StructField("observedAt", StringType()),
        StructField("feed", StringType()),
        StructField("encoding", StringType()),
        StructField("rawBytes", IntegerType()),
        StructField("payload", StringType()),
        StructField("source", StringType()),
    ]
)

eventstream_options = {
    "eventstream.itemid": __in_eventstream_item_id,
    "eventstream.datasourceid": __in_eventstream_datasource_id,
}

raw_stream = spark.readStream.format("kafka").options(**eventstream_options).load()

envelopes = raw_stream.select(
    from_json(col("value").cast(StringType()), envelope_schema).alias("envelope")
).select("envelope.*")

query = (
    envelopes.writeStream.foreachBatch(process_batch)
    .outputMode("append")
    .option("checkpointLocation", "Files/checkpoints/ttc-feed-decoder")
    .start()
)

query.awaitTermination()

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
