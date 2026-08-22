---
title: Fabric-Native Publisher Alternative
description: Superseded decision record covering the removal of ACA from the TTC twin
ms.date: 2026-08-22
ms.topic: concept
---

## Status

Superseded. This document originally recommended keeping the Azure Container
App publisher and listed the gates a Fabric-native replacement had to pass.
That replacement now ships, so the recommendation no longer applies.

The record is kept because the gates it defined were not all met. Some were
satisfied, several became moot, and two were consciously waived. Anyone
operating this workload should understand which is which.

## What shipped instead

`TTCNativeIngest` polls the three GTFS-realtime feeds, decodes the protobuf in
Spark, joins the medallion Lakehouse gold table for schedule adherence, and
appends to Eventhouse. `TTCLiveOperations`, a Real-Time Dashboard, reads
Eventhouse directly.

The container publisher still exists, but only as a query proxy for the
optional React app. Its Eventstream publishing is disabled, so it no longer
participates in ingestion.

## Assumptions that held

The TTC endpoints still return `application/x-google-protobuf` for vehicles,
trips, and alerts, including when the caller requests JSON. The `?debug`
variant still returns Protobuf text notation rather than JSON.

Fabric Eventstream's HTTP source still accepts JSON only, and Eventhouse still
has no Protobuf ingestion mapping. A Fabric-hosted decoding step was therefore
still required. The feed cannot be wired directly into Eventhouse.

## Assumptions that changed

The original design assumed the replacement would need a serving API, OneLake
snapshot caches, and Fabric SSO token validation. None of that was built. A
Real-Time Dashboard reads Eventhouse directly, which removed the entire serving
tier rather than reimplementing it.

The original design also assumed continuous polling with overlapping notebooks,
leader election, and fencing across the seven-day job limit. That was avoided
by not running continuously. A Cron schedule starts a session every thirty
minutes and each session polls for twenty eight minutes.

## Gate outcomes

| Gate | Outcome |
| --- | --- |
| Output parity | Not run as a seven-day shadow. Waived. |
| Poll cadence within 20 s | Not met. See accepted regressions. |
| Snapshot freshness | Replaced by a 35-minute `CurrentFleet()` window. |
| Forced-failover recovery | Moot. No leader election exists. |
| Handoff gap under 60 s | Not met. See accepted regressions. |
| Duplicate rate | Met. `arg_max` collapses repeats per vehicle. |
| Query parity | Moot. The ACA query path was removed, not mirrored. |
| API authentication | Moot. No serving API exists. |
| API contract | Moot. No serving API exists. |
| API throttling | Moot. No serving API exists. |
| Capacity outage | Regression accepted. See below. |

## Accepted regressions

**Ingestion is not continuous.** There is roughly a two-minute gap between the
end of one scheduled session and the start of the next. `CurrentFleet()` looks
back thirty five minutes so the dashboard stays populated across that gap, but
no vehicle observations are recorded during it. The original 15-second cadence
gate is not met and was not met by design.

**There is no independent fallback.** Polling, storage, and serving now all sit
on Fabric capacity. Pausing the capacity stops ingestion, makes the Kusto
endpoint stop resolving, and takes the dashboard down together. The previous
architecture kept an in-memory snapshot in ACA that could survive an Eventhouse
outage. That failure boundary is gone.

## When to revisit

Restore a continuous poller if a use case needs sub-minute vehicle history
rather than a current-fleet view. Restore an independent serving boundary if
the dashboard must survive a Fabric capacity outage. Neither is required for
macro operations reporting, which is what this workload does.

## References

* [Add a custom endpoint or custom app source to an eventstream](https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/add-source-custom-app?pivots=extended-features)
* [Add an HTTP source to an eventstream](https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/add-source-http)
* [Data formats supported by Fabric Eventstream](https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/data-formats)
* [Fabric notebook limitations](https://learn.microsoft.com/fabric/data-engineering/notebook-limitation)
