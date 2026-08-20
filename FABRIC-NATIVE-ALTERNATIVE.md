---
title: Fabric-Native Publisher Alternative
description: Decision record for retaining ACA while evaluating a Fabric and Rayfin-only TTC publisher
ms.date: 2026-08-20
ms.topic: concept
---

## Decision

Keep the Azure Container App publisher as the supported production adapter.
Treat it as a temporary platform boundary while Fabric-native polling and
serving options mature.

ACA itself can eventually be removed, but its responsibilities cannot currently
be eliminated. They must move to another runtime.

## Current ACA responsibilities

The publisher performs three jobs:

1. Polls the TTC GTFS-realtime feeds every 15 seconds.
2. Decodes Protobuf messages, enriches them with static schedule data, and
   publishes normalized events to Fabric Eventstream.
3. Exposes live snapshots, fallback data, route analytics, health, readiness,
   and throttling over HTTPS.

Fabric Eventstream already provides the custom endpoint used by the publisher.
That endpoint accepts application-pushed events through Event Hubs, AMQP, or
Kafka protocols. It is an ingress endpoint, not a hosted poller or decoder.

## Why the TTC feed cannot connect directly

The current TTC endpoints return `application/x-google-protobuf` for vehicles,
trip updates, and alerts. They continue to return Protobuf when the caller sends
`Accept: application/json` or adds `?format=json`. The documented `?debug`
variant returns Protobuf text notation, not valid JSON.

Fabric's HTTP Eventstream source can poll at a 15-second interval, but it accepts
JSON responses only. Eventstream can process JSON, CSV, and supported Avro
payloads for Eventhouse destinations. Unsupported payloads can pass through
only to a custom endpoint; they cannot be routed into Eventhouse. Eventhouse
also has no Protobuf ingestion mapping or KQL Protobuf decoder.

Adding Azure Event Hubs does not close this gap. Event Hubs is a broker and does
not poll TTC or decode GTFS-realtime messages. Fabric Eventstream's existing
custom endpoint already supplies the broker capability needed by this project.

## Potential Fabric and Rayfin-only design

A future implementation could move the ACA responsibilities to:

* Long-running Fabric notebooks that poll TTC, decode Protobuf, enrich vehicle
  observations, and write normalized rows to Eventhouse
* OneLake files that hold live, fallback, route-performance, and health caches
* An authenticated serving API that exposes those caches to the browser;
  runtime selection, Fabric SSO token validation, and OneLake authorization
  remain open design decisions
* Overlapping poller jobs with leader election, fencing, and automated recovery

This design preserves product capabilities, but it is not currently equivalent
operationally. Fabric notebooks have a seven-day maximum job runtime, so polling
must survive scheduled handoffs. Those handoffs can introduce short ingestion
gaps, and multiple warm Spark sessions add Fabric capacity consumption that has
not been measured against the current 0.5-vCPU, 1-GiB ACA deployment.

The design also collapses an existing failure boundary. ACA keeps an in-memory
snapshot outside Eventhouse, so an Eventhouse query outage can still return
fallback data. A Fabric-only design places polling, OneLake cache storage,
the serving API, and the hosted application on Fabric capacity. A capacity or
workspace outage can therefore remove both live queries and fallback serving at
the same time. Removing ACA requires explicitly accepting that regression or
placing the serving cache on a separately operated boundary.

## Removal gates

Do not remove ACA until the replacement passes all of these checks:

* Shadow output matches ACA vehicle, trip, alert, and schedule-enrichment data
* A seven-day shadow run records no more than one missed 15-second poll per
  handoff and keeps 99 percent of poll starts within 20 seconds of the previous
  start
* The served snapshot remains no more than 30 seconds behind the latest
  successful TTC observation for 95 percent of samples
* Forced leader termination restores polling within 60 seconds and creates no
  duplicate observation keys or stale cache promotion
* Eventhouse failure returns a valid fallback snapshot
* TTC feed failure preserves the last valid snapshot and reports degraded health
* The serving API introduces authenticated access while preserving the
  60-request-per-minute throttling intent and response contracts
* The OneLake authorization model documents whether access uses caller
  delegation or a service identity, including its permissions and audit trail
* A Fabric capacity pause test records browser and API behavior, then either
  accepts loss of the independent fallback or validates a separate serving
  boundary
* An eight-day soak crosses at least one notebook runtime handoff with no
  telemetry gap longer than 60 seconds
* Duplicate rows remain below 0.01 percent and do not alter current-fleet or
  route-performance results
* Fabric CU usage, cost, availability, and recovery measurements are reviewed
  against the existing ACA deployment and accepted by the workload owner

### Test protocol

<!-- markdownlint-disable MD013 -->

| Metric | Measurement | Window | Pass threshold |
| --- | --- | --- | --- |
| Output parity | Match source timestamps, then compare vehicle identity, coordinates within 10 metres, route, state, and schedule deviation within one second; compare every trip stop, sequence, arrival, departure, delay, and vehicle field; compare alert identity, severity, title, description, routes, cause, effect, and active period | Seven-day shadow run, sampled every 15 seconds | At least 99.9 percent matching records per table and field group; every omission explained |
| Poll cadence | Difference between consecutive poll start timestamps | Seven-day shadow run | At least 99 percent at or below 20 seconds; no more than one missed poll per handoff |
| Snapshot freshness | Served observation time subtracted from latest successful TTC observation time | Seven-day shadow run, sampled every 15 seconds | At least 95 percent at or below 30 seconds |
| Recovery | First successful poll after forced leader termination minus termination time | Three forced failures | Every recovery at or below 60 seconds |
| Handoff gap | Difference between consecutive successful observation timestamps across a scheduled handoff | Eight-day soak | No gap above 60 seconds |
| Duplicate rate | Rows with a repeated `(EventId, ObservedAt)` observation key divided by all rows, calculated separately for each Eventhouse table | Eight-day soak | Below 0.01 percent per table |
| Query parity | Compare sorted `CurrentFleet()` vehicle IDs and `RoutePerformance(30m)` counts, percentages, and percentiles against the ACA-only baseline | Seven-day shadow run, sampled every five minutes | Identical fleet IDs; route counts within one vehicle and percentages or percentiles within 0.1 |
| API authentication | Call every serving operation without a token, with an expired token, with a valid unauthorized identity, and with an authorized identity | Every deployment candidate | Invalid or unauthorized calls are denied; authorized calls succeed and audit the caller identity |
| API contract | Validate live, fallback, route-performance, health, readiness, dependency-failure, and invalid-lookback responses against versioned schemas | Every deployment candidate | Status semantics and response fields match the approved contract |
| API throttling | Send 61 requests within one minute from one authenticated principal, then retry after the window resets | Every deployment candidate | First 60 requests are accepted, request 61 is throttled, and requests resume after reset |
| Capacity outage | Pause the assigned Fabric capacity and record browser, API, cache, and recovery behavior | One controlled test | Regression explicitly accepted, or a separate serving boundary remains available |

<!-- markdownlint-enable MD013 -->

## Recommendation

Keep the existing flow for now:

```text
TTC Protobuf -> ACA poll and decode -> Fabric Eventstream -> Eventhouse
```

Revisit the Fabric-native design when Fabric adds native Protobuf ingestion or a
service that can continuously poll and decode the TTC feed with service-grade
handoffs. Until then, ACA remains the current validated adapter for this
real-time workload.

## References

* [Add a custom endpoint or custom app source to an eventstream](https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/add-source-custom-app?pivots=extended-features)
* [Add an HTTP source to an eventstream](https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/add-source-http)
* [Data formats supported by Fabric Eventstream](https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/data-formats)
* [Fabric notebook limitations](https://learn.microsoft.com/fabric/data-engineering/notebook-limitation)
