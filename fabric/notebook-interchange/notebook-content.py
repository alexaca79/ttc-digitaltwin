# Fabric notebook source

# METADATA ********************

# META {
# META   "kernel_info": {
# META     "name": "synapse_pyspark"
# META   },
# META   "dependencies": {}
# META }

# MARKDOWN ********************

# ## GO and TTC: how well do the two networks hand riders to each other?
#
# GO trains and TTC routes meet at a ring of stations across Toronto. Riders
# transfer in both directions, and under the One Fare program a transfer between
# GO and the TTC paid with PRESTO, debit or credit is free, so the timetables are
# what stands between a train and the next TTC vehicle. This notebook measures
# that handoff on one service day:
#
# 1. **GO to TTC.** After a train arrives, how long does a rider walk and wait
#    for each TTC route? Are TTC departures timed around GO arrivals, unrelated
#    to them, or systematically leaving just before the train pulls in?
# 2. **TTC to GO.** Do TTC vehicles arrive just before GO departures, or just
#    after? Using live TTC lateness from the `TTCOperations` Eventhouse, how
#    often would a delay break the tightest connection a trip planner offers?
#
# Inputs are the official TTC and GO GTFS archives retained in OneLake under
# `Files/gta-gtfs/<snapshot>/` and TTC GTFS-realtime schedule deviation in
# Eventhouse. Results are written to `gold_go_ttc_*` Delta tables in this
# lakehouse.

# PARAMETERS CELL ********************

lakehouse_abfss = "{{LAKEHOUSE_ABFSS}}"
kql_cluster_uri = "{{KQL_CLUSTER_URI}}"
kql_database = "TTCOperations"
gtfs_snapshot = "latest"
service_date = ""
walk_radius_m = 350
live_lookback_days = 14

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# MARKDOWN ********************

# ### Method
#
# * **Interchanges** are GO rail stations with TTC stops inside `walk_radius_m`.
#   Walking time is the straight-line distance times 1.3, at 1.2 m/s, plus two
#   minutes to leave the platform.
# * Each TTC **route-direction** uses its closest stop that serves at least half
#   of its trips near the station, so one bus is never counted at several stops.
# * The **coordination index** divides the observed mean wait by the mean wait
#   when each GO arrival is shifted by a random offset of up to 30 minutes, 200
#   times. About 1 means the timetables are unrelated. Values at or below 0.8
#   with p < 0.05 mean TTC is timed to meet GO; at or above 1.2 with p < 0.05,
#   TTC tends to leave just before GO arrives. Waits only count inside TTC
#   service blocks, with no gap over 90 minutes.
# * A **feeder connection** is the latest TTC arrival that still makes a GO
#   departure on schedule, with at most 30 minutes of slack. Its miss
#   probability is the share of observed TTC lateness on that route exceeding
#   the slack. GO punctuality is not modelled, because GO real-time data is not
#   configured in this workload.

# CELL ********************

import zipfile
from datetime import date, timedelta

import numpy as np
import pandas as pd

WALK_SPEED_MPS = 1.2
WALK_DETOUR = 1.3
PLATFORM_SECONDS = 120
SERVICE_GAP_SECONDS = 90 * 60
FEEDER_WINDOW_SECONDS = 30 * 60
PERMUTATIONS = 200
SHIFT_SECONDS = 30 * 60
MIN_GO_EVENTS = 15
WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
DAY_PERIODS = [("early-morning", 0, 6), ("AM-peak", 6, 9), ("midday", 9, 15), ("PM-peak", 15, 19), ("evening", 19, 22), ("late-night", 22, 30)]
STOP_TIME_COLUMNS = ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence", "pickup_type", "drop_off_type"]


def read_member(archive, filename, **options):
    """Read one GTFS table from an open zip archive as strings."""
    names = [name for name in archive.namelist() if name.split("/")[-1].lower() == filename]
    if not names:
        return None
    with archive.open(names[0]) as handle:
        return pd.read_csv(handle, dtype=str, keep_default_na=False, encoding="utf-8-sig", **options)


def load_feed(zip_path):
    with zipfile.ZipFile(zip_path) as archive:
        return {table: read_member(archive, f"{table}.txt") for table in
                ("routes", "trips", "stops", "calendar", "calendar_dates", "feed_info")}


def read_stop_times(zip_path, trip_ids, stop_ids):
    """Stream stop_times, keeping the stops of interest plus each trip's full sequence span."""
    kept, spans = [], []
    with zipfile.ZipFile(zip_path) as archive:
        name = next(n for n in archive.namelist() if n.split("/")[-1].lower() == "stop_times.txt")
        with archive.open(name) as handle:
            for chunk in pd.read_csv(handle, dtype=str, keep_default_na=False, encoding="utf-8-sig",
                                     usecols=lambda column: column in STOP_TIME_COLUMNS, chunksize=1_000_000):
                chunk = chunk[chunk.trip_id.isin(trip_ids)]
                spans.append(chunk.stop_sequence.astype(int).groupby(chunk.trip_id).agg(["min", "max"]))
                kept.append(chunk[chunk.stop_id.isin(stop_ids)])
    bounds = pd.concat(spans).groupby(level=0).agg(first_seq=("min", "min"), last_seq=("max", "max"))
    return with_trip_bounds(pd.concat(kept, ignore_index=True), bounds)


def gtfs_seconds(values):
    """GTFS clock times, which may pass 24:00, as seconds after service-day midnight."""
    parts = values.str.strip().str.split(":", expand=True).astype(int)
    return parts[0] * 3600 + parts[1] * 60 + parts[2]


def haversine_m(lat1, lon1, lat2, lon2):
    phi1, phi2 = np.radians(lat1), np.radians(lat2)
    a = (np.sin((phi2 - phi1) / 2) ** 2
         + np.cos(phi1) * np.cos(phi2) * np.sin(np.radians(lon2 - lon1) / 2) ** 2)
    return 2 * 6_371_000 * np.arcsin(np.sqrt(a))


def active_services(feed, day):
    """Service IDs running on a date, honouring calendar and calendar_dates exceptions."""
    stamp = day.strftime("%Y%m%d")
    weekday = WEEKDAYS[day.weekday()]
    services = set()
    calendar = feed.get("calendar")
    if calendar is not None and len(calendar):
        services |= set(calendar[(calendar.start_date <= stamp) & (calendar.end_date >= stamp)
                                 & (calendar[weekday] == "1")].service_id)
    exceptions = feed.get("calendar_dates")
    if exceptions is not None and len(exceptions):
        today = exceptions[exceptions.date == stamp]
        services |= set(today[today.exception_type == "1"].service_id)
        services -= set(today[today.exception_type == "2"].service_id)
    return services


def choose_service_date(ttc, go, requested, today):
    """Use the requested date, else the first weekday from today that both agencies run."""
    if requested:
        day = date.fromisoformat(requested)
        if not active_services(ttc, day) or not active_services(go, day):
            raise ValueError(f"TTC and GO do not both run on {requested}.")
        return day
    for offset in range(0, 21):
        day = today + timedelta(days=offset)
        if day.weekday() < 5 and active_services(ttc, day) and active_services(go, day):
            return day
    raise ValueError("No weekday in the next three weeks has both TTC and GO service.")


def with_trip_bounds(events, bounds):
    events = events.copy()
    events["seq"] = events.stop_sequence.astype(int)
    events = events.join(bounds, on="trip_id")
    events["arr"] = gtfs_seconds(events.arrival_time)
    events["dep"] = gtfs_seconds(events.departure_time)
    events["can_alight"] = (events.seq > events.first_seq) & (events.drop_off_type != "1")
    events["can_board"] = (events.seq < events.last_seq) & (events.pickup_type != "1")
    return events


def go_rail_events(go, go_zip, day):
    """GO train stop events on the service date, with the full trip span for terminal checks."""
    trips = go["trips"][go["trips"].service_id.isin(active_services(go, day))]
    trips = trips.merge(go["routes"][["route_id", "route_short_name", "route_long_name", "route_type"]], on="route_id")
    trips = trips[trips.route_type == "2"]
    stop_ids = set(go["stops"].stop_id)
    events = read_stop_times(go_zip, set(trips.trip_id), stop_ids)
    return events.merge(trips[["trip_id", "route_short_name", "route_long_name", "direction_id", "trip_headsign"]], on="trip_id")


def interchange_pairs(go, go_events, ttc, radius_m):
    """TTC stops within walking radius of each GO rail station served that day."""
    stations = go["stops"][go["stops"].stop_id.isin(go_events.stop_id.unique())].copy()
    stations[["stop_lat", "stop_lon"]] = stations[["stop_lat", "stop_lon"]].astype(float)
    stops = ttc["stops"][ttc["stops"].location_type.isin(["", "0"])].copy()
    stops[["stop_lat", "stop_lon"]] = stops[["stop_lat", "stop_lon"]].astype(float)
    distance = haversine_m(stations.stop_lat.values[:, None], stations.stop_lon.values[:, None],
                           stops.stop_lat.values[None, :], stops.stop_lon.values[None, :])
    go_index, ttc_index = np.nonzero(distance <= radius_m)
    pairs = pd.DataFrame({
        "go_stop_id": stations.stop_id.values[go_index],
        "go_station": stations.stop_name.values[go_index],
        "go_lat": stations.stop_lat.values[go_index],
        "go_lon": stations.stop_lon.values[go_index],
        "ttc_stop_id": stops.stop_id.values[ttc_index],
        "ttc_stop_name": stops.stop_name.values[ttc_index],
        "distance_m": distance[go_index, ttc_index].round(1),
    })
    pairs["walk_seconds"] = (pairs.distance_m * WALK_DETOUR / WALK_SPEED_MPS + PLATFORM_SECONDS).round().astype(int)
    return pairs, stations


def ttc_events_near(ttc, ttc_zip, day, pairs):
    trips = ttc["trips"][ttc["trips"].service_id.isin(active_services(ttc, day))]
    trips = trips.merge(ttc["routes"][["route_id", "route_short_name", "route_long_name", "route_type"]], on="route_id")
    events = read_stop_times(ttc_zip, set(trips.trip_id), set(pairs.ttc_stop_id))
    events = events.merge(trips[["trip_id", "route_id", "route_short_name", "route_long_name", "route_type",
                                 "direction_id", "trip_headsign"]], on="trip_id")
    rapid = (events.route_type == "1") | ((events.route_type == "0") & events.route_long_name.str.endswith(" Line"))
    events["mode"] = np.where(rapid, "subway", np.where(events.route_type == "0", "streetcar", "bus"))
    events["route_dir"] = events.route_short_name + "/" + events.direction_id
    return events


def nearest_stop_events(events, pairs, usable):
    """One stop per station and route-direction: the closest serving at least half its trips there."""
    events = events[usable].merge(pairs[["go_stop_id", "go_station", "ttc_stop_id", "walk_seconds"]],
                                  left_on="stop_id", right_on="ttc_stop_id")
    per_stop = events.groupby(["go_stop_id", "route_dir", "stop_id"]).agg(trips=("trip_id", "nunique"), walk=("walk_seconds", "first")).reset_index()
    per_stop["total"] = per_stop.groupby(["go_stop_id", "route_dir"]).trips.transform("max")
    chosen = (per_stop[per_stop.trips >= 0.5 * per_stop.total].sort_values("walk")
              .groupby(["go_stop_id", "route_dir"]).head(1)[["go_stop_id", "route_dir", "stop_id"]])
    return events.merge(chosen, on=["go_stop_id", "route_dir", "stop_id"])


def service_blocks(times):
    """Contiguous runs of departures without a gap longer than SERVICE_GAP_SECONDS."""
    times = np.sort(np.unique(times))
    breaks = np.nonzero(np.diff(times) > SERVICE_GAP_SECONDS)[0]
    starts = np.concatenate(([times[0]], times[breaks + 1]))
    ends = np.concatenate((times[breaks], [times[-1]]))
    return starts, ends


def in_service(ready, starts, ends):
    block = np.searchsorted(starts, ready, side="right") - 1
    return (block >= 0) & (ready <= ends[np.clip(block, 0, None)])


def wait_for_next(times, ready):
    times = np.sort(times)
    index = np.searchsorted(times, ready, side="left")
    waits = np.full(len(ready), np.nan)
    found = index < len(times)
    waits[found] = times[index[found]] - ready[found]
    return waits


def handoff_table(go_arrivals, departures, seed=7):
    """GO arrival -> TTC departure waits per route-direction, against a random-timing null."""
    rng = np.random.default_rng(seed)
    rows = []
    for (station, route_dir), group in departures.groupby(["go_stop_id", "route_dir"]):
        walk = int(group.walk_seconds.iat[0])
        arrivals = go_arrivals.loc[go_arrivals.stop_id == station, "arr"].to_numpy()
        starts, ends = service_blocks(group.dep.to_numpy())
        ready = arrivals + walk
        mask = in_service(ready, starts, ends)
        if mask.sum() == 0:
            continue
        waits = wait_for_next(group.dep.to_numpy(), ready[mask])
        observed = float(np.nanmean(waits))
        null_means = []
        for _ in range(PERMUTATIONS):
            shifted = ready + rng.uniform(-SHIFT_SECONDS, SHIFT_SECONDS, len(ready))
            shifted = shifted[in_service(shifted, starts, ends)]
            if len(shifted):
                null_means.append(np.nanmean(wait_for_next(group.dep.to_numpy(), shifted)))
        null_means = np.array(null_means)
        expected = float(null_means.mean())
        lower = (np.sum(null_means <= observed) + 1) / (len(null_means) + 1)
        upper = (np.sum(null_means >= observed) + 1) / (len(null_means) + 1)
        first = group.iloc[0]
        rows.append({
            "go_stop_id": station, "go_station": first.go_station, "route_dir": route_dir,
            "route_id": first.route_id, "route": first.route_short_name, "route_name": first.route_long_name,
            "mode": first["mode"], "headsign": group.trip_headsign.mode().iat[0], "ttc_stop_id": first.stop_id,
            "walk_minutes": round(walk / 60, 1), "go_arrivals": int(mask.sum()), "ttc_departures": int(group.dep.nunique()),
            "mean_wait_minutes": round(observed / 60, 2), "median_wait_minutes": round(float(np.nanmedian(waits)) / 60, 2),
            "random_wait_minutes": round(expected / 60, 2), "share_within_5_minutes": round(float(np.mean(waits <= 300)), 3),
            "coordination_index": round(observed / expected, 3) if expected else np.nan,
            "p_value": round(float(min(1.0, 2 * min(lower, upper))), 4),
        })
    table = pd.DataFrame(rows)
    solid = (table.go_arrivals >= MIN_GO_EVENTS) & (table.ttc_departures >= MIN_GO_EVENTS)
    table["timing"] = np.select(
        [solid & (table.p_value < 0.05) & (table.coordination_index <= 0.8),
         solid & (table.p_value < 0.05) & (table.coordination_index >= 1.2),
         solid],
        ["timed to meet GO", "leaves just before GO arrives", "independent"],
        default="too few events",
    )
    return table


def first_ride_out(go_arrivals, departures):
    """Minutes from each GO arrival to the first reachable TTC departure, any route."""
    rows = []
    for station, arrivals in go_arrivals.groupby("stop_id"):
        group = departures[departures.go_stop_id == station]
        if group.empty:
            continue
        latest_arrival = (group.dep - group.walk_seconds).to_numpy()
        order = np.argsort(latest_arrival)
        latest_arrival, dep = latest_arrival[order], group.dep.to_numpy()[order]
        index = np.searchsorted(latest_arrival, arrivals.arr.to_numpy(), side="left")
        found = index < len(dep)
        minutes = np.full(len(arrivals), np.nan)
        minutes[found] = (dep[index[found]] - arrivals.arr.to_numpy()[found]) / 60
        minutes[minutes > SERVICE_GAP_SECONDS / 60] = np.nan
        rows.append(pd.DataFrame({"go_stop_id": station, "go_station": group.go_station.iat[0],
                                  "arrival_seconds": arrivals.arr.to_numpy(), "transfer_minutes": minutes}))
    rides = pd.concat(rows, ignore_index=True)
    rides["hour"] = (rides.arrival_seconds // 3600).astype(int)
    rides["period"] = pd.cut(rides.hour, [p[1] for p in DAY_PERIODS] + [DAY_PERIODS[-1][2]], right=False,
                             labels=[p[0] for p in DAY_PERIODS])
    return rides


def feeder_connections(go_departures, arrivals):
    """Tightest planned TTC -> GO connection per GO departure and feeder route-direction."""
    rows = []
    for (station, route_dir), group in arrivals.groupby(["go_stop_id", "route_dir"]):
        departures = go_departures.loc[go_departures.stop_id == station, "dep"].to_numpy()
        if not len(departures):
            continue
        at_platform = np.sort((group.arr + group.walk_seconds).to_numpy())
        index = np.searchsorted(at_platform, departures, side="right") - 1
        found = index >= 0
        slack = np.full(len(departures), np.nan)
        slack[found] = departures[found] - at_platform[index[found]]
        keep = found & (slack <= FEEDER_WINDOW_SECONDS)
        first = group.iloc[0]
        rows.append(pd.DataFrame({
            "go_stop_id": station, "go_station": first.go_station, "route_dir": route_dir,
            "route_id": first.route_id, "route": first.route_short_name, "mode": first["mode"],
            "go_departure_seconds": departures[keep], "slack_seconds": slack[keep],
        }))
    return pd.concat(rows, ignore_index=True)


def arrival_balance(go_departures, arrivals, window_seconds=300):
    """TTC arrivals landing just before versus just after each GO departure."""
    before = after = 0
    for station, group in arrivals.groupby("go_stop_id"):
        at_platform = (group.arr + group.walk_seconds).to_numpy()
        for departure in go_departures.loc[go_departures.stop_id == station, "dep"].to_numpy():
            delta = departure - at_platform
            before += int(((delta >= 0) & (delta <= window_seconds)).sum())
            after += int(((delta < 0) & (delta >= -window_seconds)).sum())
    return before, after


def miss_probability(slack_seconds, quantiles):
    """Share of observed lateness exceeding each connection's slack."""
    quantiles = np.sort(np.asarray(quantiles, dtype=float))
    return 1 - np.searchsorted(quantiles, np.asarray(slack_seconds, dtype=float), side="right") / len(quantiles)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

import json
import os
import re
import tempfile
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

walk_radius_m = float(walk_radius_m)
snapshot_root = f"{lakehouse_abfss}/Files/gta-gtfs"
if gtfs_snapshot == "latest":
    folders = [entry.name.strip("/") for entry in notebookutils.fs.ls(snapshot_root) if entry.isDir]
    stamps = sorted(name for name in folders if re.fullmatch(r"\d{8}T\d{4}Z", name))
    if not stamps:
        raise FileNotFoundError(f"No GTFS snapshots under {snapshot_root}.")
    gtfs_snapshot = stamps[-1]

work_dir = tempfile.mkdtemp(prefix="gta-gtfs-")
archives = {}
for agency in ("ttc", "go"):
    archives[agency] = os.path.join(work_dir, f"{agency}-gtfs.zip")
    notebookutils.fs.cp(f"{snapshot_root}/{gtfs_snapshot}/{agency}-gtfs.zip", f"file:{archives[agency]}")

ttc, go = load_feed(archives["ttc"]), load_feed(archives["go"])
day = choose_service_date(ttc, go, service_date, datetime.now(ZoneInfo("America/Toronto")).date())
go_events = go_rail_events(go, archives["go"], day)
pairs, stations = interchange_pairs(go, go_events, ttc, walk_radius_m)
ttc_events = ttc_events_near(ttc, archives["ttc"], day, pairs)
departures = nearest_stop_events(ttc_events, pairs, ttc_events.can_board)
arrivals = nearest_stop_events(ttc_events, pairs, ttc_events.can_alight)
go_arrivals = go_events[go_events.can_alight & go_events.stop_id.isin(pairs.go_stop_id)]
go_departures = go_events[go_events.can_board & go_events.stop_id.isin(pairs.go_stop_id)]

print(f"GTFS snapshot {gtfs_snapshot}; service date {day:%A %Y-%m-%d}")
print(f"{go_events.stop_id.nunique()} GO rail stations in service; {pairs.go_stop_id.nunique()} have TTC stops within {walk_radius_m:.0f} m")
print(f"{len(go_arrivals):,} GO arrivals and {len(go_departures):,} GO departures at those interchanges")
print(f"{len(departures):,} TTC departures and {len(arrivals):,} TTC arrivals at the closest stop of each route-direction")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# MARKDOWN ********************

# ### GO to TTC: are TTC departures timed around GO arrivals?

# CELL ********************

import matplotlib.pyplot as plt

TIMING_COLORS = {
    "timed to meet GO": "#00853f",
    "independent": "#9aa0a6",
    "leaves just before GO arrives": "#da291c",
}
handoffs = handoff_table(go_arrivals, departures)
rated = handoffs[handoffs.timing != "too few events"]

fig, ax = plt.subplots(figsize=(11, 4))
bins = np.linspace(0, 2.5, 51)
for label, color in TIMING_COLORS.items():
    values = rated.loc[rated.timing == label, "coordination_index"].clip(upper=2.5)
    ax.hist(values, bins=bins, color=color, label=f"{label} ({len(values)})")
ax.axvline(1.0, color="#202124", linestyle="--", linewidth=1)
ax.set_xlabel("Coordination index: observed wait / wait if the timetables were unrelated")
ax.set_ylabel("TTC route-directions")
ax.set_title("GO to TTC: most TTC timetables ignore GO arrivals")
ax.legend(frameon=False)
plt.show()

columns = ["go_station", "route", "route_name", "headsign", "mode", "go_arrivals", "ttc_departures",
           "mean_wait_minutes", "random_wait_minutes", "coordination_index", "p_value", "timing"]
display(rated[rated.timing != "independent"].sort_values("coordination_index")[columns])

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# MARKDOWN ********************

# ### GO to TTC: minutes from stepping off a train to the first TTC departure

# CELL ********************

rides = first_ride_out(go_arrivals, departures)
station_routes = departures.groupby("go_stop_id").agg(
    ttc_route_directions=("route_dir", "nunique"),
    rapid_transit=("mode", lambda modes: bool((modes == "subway").any())),
)
scorecard = (
    rides.groupby(["go_stop_id", "go_station"])
    .agg(
        go_arrivals=("transfer_minutes", "size"),
        median_transfer_minutes=("transfer_minutes", "median"),
        p90_transfer_minutes=("transfer_minutes", lambda minutes: minutes.quantile(0.9)),
        no_connection_share=("transfer_minutes", lambda minutes: minutes.isna().mean()),
    )
    .reset_index()
    .join(station_routes, on="go_stop_id")
    .merge(stations[["stop_id", "stop_lat", "stop_lon"]].rename(columns={"stop_id": "go_stop_id", "stop_lat": "latitude", "stop_lon": "longitude"}), on="go_stop_id")
    .sort_values("median_transfer_minutes")
    .round(3)
)

fig, ax = plt.subplots(figsize=(11, 7))
ordered = scorecard.sort_values("median_transfer_minutes", ascending=False)
colors = np.where(ordered.rapid_transit, "#0054a6", "#da291c")
ax.barh(ordered.go_station, ordered.median_transfer_minutes, color=colors)
ax.scatter(ordered.p90_transfer_minutes, ordered.go_station, color="#202124", marker="|", s=120, label="90th percentile")
ax.set_xlabel("Minutes from GO arrival to the first TTC departure, including the walk")
ax.set_title("GO to TTC handoff by station (blue: subway or LRT at the station)")
ax.legend(frameon=False, loc="upper right")
plt.tight_layout()
plt.show()

by_period = rides.groupby("period", observed=True).transfer_minutes.agg(
    arrivals="size", median="median", p90=lambda minutes: minutes.quantile(0.9)
).round(1)
display(by_period.reset_index())
display(scorecard)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# MARKDOWN ********************

# ### TTC to GO: do feeder arrivals line up with departing trains?
#
# A planned connection is safe only while the TTC vehicle is on time. Live TTC
# schedule deviation from the `TTCOperations` Eventhouse estimates how often
# lateness would break each station's tightest planned connections.

# CELL ********************

import requests

MAX_LIVE_DEVIATION_SECONDS = 2 * 60 * 60


def kql(csl):
    token = None
    for audience in (kql_cluster_uri, "kusto"):
        try:
            token = notebookutils.credentials.getToken(audience)
            break
        except Exception:  # noqa: BLE001 - try the next audience
            continue
    if not token:
        raise RuntimeError("Could not acquire a Kusto access token.")
    response = requests.post(
        f"{kql_cluster_uri.rstrip('/')}/v1/rest/query",
        json={"db": kql_database, "csl": csl},
        headers={"Authorization": f"Bearer {token}"},
        timeout=180,
    )
    response.raise_for_status()
    table = response.json()["Tables"][0]
    return pd.DataFrame(table["Rows"], columns=[column["ColumnName"] for column in table["Columns"]])


before, after = arrival_balance(go_departures, arrivals)
print(f"TTC arrivals reaching the platform within 5 minutes before a GO departure: {before:,}; within 5 minutes after: {after:,} "
      f"({before / (before + after):.1%} before)")

feeders = feeder_connections(go_departures, arrivals)
feeders["miss_probability"] = np.nan
live_status = "unavailable"
lateness = pd.DataFrame()
try:
    routes = ", ".join(f"'{route}'" for route in sorted(feeders.route_id.unique()))
    points = ", ".join(str(point) for point in range(1, 100))
    lateness = kql(f"""
VehiclePositions
| where ObservedAt > ago({int(live_lookback_days)}d)
| where isnotnull(ScheduleDeviationSeconds) and abs(ScheduleDeviationSeconds) <= {MAX_LIVE_DEVIATION_SECONDS}
| where RouteId in ({routes})
| summarize Observations = count(), FirstObserved = min(ObservedAt), LastObserved = max(ObservedAt),
    Quantiles = percentiles_array(ScheduleDeviationSeconds, dynamic([{points}])) by RouteId
""")
    quantiles = {
        row.RouteId: json.loads(row.Quantiles) if isinstance(row.Quantiles, str) else row.Quantiles
        for row in lateness.itertuples()
        if row.Observations >= 200
    }
    for route_id, rows in feeders.groupby("route_id").groups.items():
        if route_id in quantiles:
            feeders.loc[rows, "miss_probability"] = miss_probability(feeders.loc[rows, "slack_seconds"], quantiles[route_id])
    live_status = "ok"
    print(f"Live TTC lateness: {int(lateness.Observations.sum()):,} observations on {len(quantiles)} feeder routes "
          f"between {lateness.FirstObserved.min()} and {lateness.LastObserved.max()}")
except Exception as error:  # noqa: BLE001 - the static analysis stands without live data
    print(f"Live TTC lateness unavailable ({type(error).__name__}: {error}); feeder risk is not estimated.")

feeder_risk = (
    feeders.groupby(["go_stop_id", "go_station", "route_id", "route", "mode"])
    .agg(
        planned_connections=("slack_seconds", "size"),
        median_slack_minutes=("slack_seconds", lambda seconds: seconds.median() / 60),
        tight_share=("slack_seconds", lambda seconds: (seconds < 180).mean()),
        expected_missed_share=("miss_probability", "mean"),
    )
    .reset_index()
    .round(3)
)
station_risk = (
    feeders.groupby("go_station")
    .agg(planned_connections=("slack_seconds", "size"), expected_missed_share=("miss_probability", "mean"))
    .dropna()
    .sort_values("expected_missed_share")
)
if len(station_risk):
    fig, ax = plt.subplots(figsize=(11, 6))
    ax.barh(station_risk.index, station_risk.expected_missed_share * 100, color="#da291c")
    ax.set_xlabel("Planned TTC to GO connections broken by observed TTC lateness (%)")
    ax.set_title("TTC to GO: where live TTC lateness costs riders their train")
    plt.tight_layout()
    plt.show()
display(feeder_risk.sort_values("expected_missed_share", ascending=False))

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# MARKDOWN ********************

# ### Persist the results
#
# Each table is overwritten on every run and carries the service date and GTFS
# snapshot it was computed from.

# CELL ********************

generated_at = datetime.now(timezone.utc).isoformat()


def save(frame, name):
    output = frame.copy()
    for column in output.columns:
        if isinstance(output[column].dtype, pd.CategoricalDtype):
            output[column] = output[column].astype(str)
    output["service_date"] = day.isoformat()
    output["gtfs_snapshot"] = gtfs_snapshot
    output["generated_at"] = generated_at
    target = f"{lakehouse_abfss}/Tables/{name}"
    spark.createDataFrame(output).write.mode("overwrite").option("overwriteSchema", "true").format("delta").save(target)
    return spark.read.format("delta").load(target).count()


written = {
    "gold_go_ttc_interchanges": save(scorecard, "gold_go_ttc_interchanges"),
    "gold_go_ttc_handoffs": save(handoffs, "gold_go_ttc_handoffs"),
    "gold_go_ttc_feeder_risk": save(feeder_risk, "gold_go_ttc_feeder_risk"),
}
print(json.dumps(written, indent=2))

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# MARKDOWN ********************

# ### Findings

# CELL ********************

timing_counts = rated.timing.value_counts()
covered = feeders.dropna(subset=["miss_probability"])
fastest = scorecard.nsmallest(3, "median_transfer_minutes")
slowest = scorecard.nlargest(3, "median_transfer_minutes")
worst_timed = rated[rated.timing == "leaves just before GO arrives"].nlargest(3, "coordination_index")
best_timed = rated[rated.timing == "timed to meet GO"].nsmallest(3, "coordination_index")
busy_periods = by_period[by_period.arrivals >= 10]
hardest_period = busy_periods.p90.idxmax() if len(busy_periods) else None


def route_label(row):
    heading = row.headsign.split(" - ")[0].strip().lower()
    direction = f"{heading}bound" if heading in ("north", "south", "east", "west") else row.headsign
    return f"{row.route} {row.route_name} {direction} at {row.go_station}"


findings = [
    f"{pairs.go_stop_id.nunique()} of {go_events.stop_id.nunique()} GO rail stations in service on {day:%A %B %d} have TTC stops within {walk_radius_m:.0f} m.",
    f"Across {len(rated)} TTC route-directions with enough service, the median coordination index is "
    f"{rated.coordination_index.median():.2f}: {timing_counts.get('independent', 0)} are scheduled independently of GO, "
    f"{timing_counts.get('timed to meet GO', 0)} are timed to meet trains and "
    f"{timing_counts.get('leaves just before GO arrives', 0)} tend to leave just before trains arrive.",
    f"TTC arrivals land just before a GO departure {before / (before + after):.0%} of the time and just after "
    f"{after / (before + after):.0%}, so feeder timetables do not target GO departures either.",
    "Quickest handoffs (median minutes from train to TTC departure): "
    + ", ".join(f"{row.go_station} {row.median_transfer_minutes:.1f}" for row in fastest.itertuples()) + ".",
    "Slowest handoffs: " + ", ".join(f"{row.go_station} {row.median_transfer_minutes:.1f}" for row in slowest.itertuples()) + ".",
]
if hardest_period is not None:
    findings.append(
        f"Handoffs are least reliable for {hardest_period} arrivals: median {by_period.loc[hardest_period, 'median']:.1f} min, "
        f"90th percentile {by_period.loc[hardest_period, 'p90']:.1f} min across all interchanges."
    )
if len(best_timed):
    findings.append(
        "Best timed to meet trains: "
        + "; ".join(f"{route_label(row)} (index {row.coordination_index:.2f}, "
                    f"{row.mean_wait_minutes:.1f} vs {row.random_wait_minutes:.1f} min)" for row in best_timed.itertuples())
        + "."
    )
if len(worst_timed):
    findings.append(
        "Most consistently mistimed: "
        + "; ".join(f"{route_label(row)} (index {row.coordination_index:.2f}, "
                    f"{row.mean_wait_minutes:.1f} vs {row.random_wait_minutes:.1f} min)" for row in worst_timed.itertuples())
        + ". Shifting these departures by a few minutes would shorten every transfer."
    )
if len(covered):
    worst_station = station_risk.index[-1]
    findings.append(
        f"Observed TTC lateness would break {covered.miss_probability.mean():.1%} of {len(covered):,} tightest planned "
        f"TTC to GO connections (median slack {feeders.slack_seconds.median() / 60:.1f} min); "
        f"{worst_station} is most exposed at {station_risk.expected_missed_share.iloc[-1]:.1%}."
    )
for finding in findings:
    print(f"- {finding}")

summary = {
    "ok": True,
    "serviceDate": day.isoformat(),
    "gtfsSnapshot": gtfs_snapshot,
    "interchanges": int(pairs.go_stop_id.nunique()),
    "routeDirections": int(len(rated)),
    "timing": {label: int(count) for label, count in timing_counts.items()},
    "medianCoordinationIndex": round(float(rated.coordination_index.median()), 3),
    "ttcArrivalsBeforeGoDepartureShare": round(before / (before + after), 3),
    "feederConnections": int(len(feeders)),
    "liveLateness": live_status,
    "expectedMissedShare": round(float(covered.miss_probability.mean()), 3) if len(covered) else None,
    "tables": written,
}
print(json.dumps(summary))

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

notebookutils.notebook.exit(json.dumps(summary))

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
