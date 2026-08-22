---
title: TTC Digital Twin Deployment Quickstart
description: Short path to deploy the supported Fabric, Rayfin, and Azure Container Apps workload
ms.date: 2026-08-20
ms.topic: quickstart
---

The shortest path from a fresh clone to a running workload. Each step links to
[DEPLOYMENT.md](DEPLOYMENT.md) for the detail, failure modes, and rollback
procedures.

## What you deploy

| Store | Item | Holds |
| --- | --- | --- |
| Lakehouse | `TTCSchedule` | Static GTFS in bronze, silver, gold |
| Eventhouse | `TTCOperations` | Live vehicles, trips, and alerts |
| Eventstream | `TTCTelemetry` | Custom Endpoint and SQL router |
| Rayfin | AppBackend and SQL | The app, SSO, and operator notes |

Static reference data changes daily and lives in the Lakehouse. Live telemetry
changes every few seconds and lives in Eventhouse, where KQL serves the map.

## Before you start

* A Fabric workspace on supported capacity, with Contributor or higher
* Fabric Apps enabled by the tenant administrator
* Azure CLI and Node 22
* Permission to grant a managed identity viewer access on a KQL database

Use an isolated CLI profile so a deployment cannot target the wrong tenant:

```powershell
$env:AZURE_CONFIG_DIR = "$env:USERPROFILE\.azure-tenants\<alias>"
az login --tenant <tenant-id>
az account set --subscription <subscription-id-or-name>
az account show --query "{tenant:tenantId, subscription:name}" --output table
```

The deployment script asserts this context and refuses to run against a
mismatch. See [Prerequisites](DEPLOYMENT.md#prerequisites).

## 1. Install and validate

```powershell
npm install
npm run fabric:plan
```

`fabric:plan` renders every Fabric definition without contacting Fabric. It
should report the Eventstream, notebook, and medallion parts.

## 2. Provision Fabric

```powershell
npm run fabric:deploy -- `
  --tenant-id <tenant-id> `
  --subscription <subscription-id-or-name> `
  --workspace-name <workspace-name>
```

The script is idempotent by item name and writes non-secret identifiers to the
gitignored `.fabric/deployment.local.json`. Notebook parameter defaults are
templated with the resolved Lakehouse and Eventhouse identifiers, because
Fabric schedules cannot pass parameters.

See [Fresh Deployment](DEPLOYMENT.md#fresh-deployment).

## 3. Build the static schedule

Schedule adherence needs the published timetable, which the realtime feed does
not carry. Run `TTCScheduleBronze` once; it downloads the City of Toronto
archive and chains silver and gold.

Then register it daily so the timetable stays current. A 03:00 Eastern schedule
against the bronze notebook refreshes the whole chain.

Until `gold_schedule_lookup` exists, ingestion still works and
`ScheduleDeviationSeconds` stays null.

See [Static Reference Data](DEPLOYMENT.md#static-reference-data).

## 4. Choose an ingestion path

| Path | Runs where | Enable with |
| --- | --- | --- |
| Decoded publisher | Container App | Default |
| Raw forward | Container App and notebook | `PUBLISHER_RAW_FEED_MODE` |
| Fabric ingestion prototype | `TTCNativeIngest` notebook | Run it manually |

All three target the same Eventhouse tables. They are not row-equivalent or
complete application deployment alternatives. Running more than one duplicates
rows; `CurrentFleet()` collapses them per vehicle, while duplicated history can
still skew aggregate analytics.

`TTCNativeIngest` can remove the container from ingestion experiments, but it
does not replace the publisher's HTTPS snapshot and query API. ACA remains part
of the supported end-to-end deployment. See
[Potential ACA-free architecture](DEPLOYMENT.md#potential-aca-free-architecture)
for the proposed Fabric and Rayfin-only replacement and its operational
constraints. The current container paths are covered in
[Fresh Deployment](DEPLOYMENT.md#fresh-deployment).

See [Ingestion Paths](DEPLOYMENT.md#ingestion-paths).

## 5. Open the dashboard

`TTCLiveOperations` is a Real-Time Dashboard that reads Eventhouse directly. It
refreshes every minute, and Fabric identity governs access, so nothing is
publicly reachable and no web tier is required.

Open it from the workspace. Tiles stay empty until `TTCNativeIngest` has run at
least once, and `Feed age minutes` tells you whether what you are seeing is
current.

This is the default operator surface. Steps 6 and 7 apply only if you also want
the optional container publisher and React app.

## 6. Optional: connect the container query endpoint

The application reads Eventhouse through the publisher. Grant the publisher
identity viewer access on `TTCOperations`, then set `FABRIC_KQL_QUERY_URI` and
`FABRIC_KQL_DATABASE` on the Container App.

Until this is done, `/api/live` returns HTTP 503 and the browser falls back to
`/api/snapshot`. The map still works; it is served from poller memory rather
than Eventhouse.

## 7. Optional: deploy the app

```powershell
npx rayfin login
npm run rayfin:up
```

`rayfin up` builds the static app, deploys it, and applies pending schema
migrations. Copy `.env.production.example` to `.env.production.local` and set
the publisher ingress before building.

Open the app from the Fabric portal so embedded SSO can complete. It will not
finish authenticating in a plain browser tab.

## 8. Validate

| Check | Expected |
| --- | --- |
| `/api/health` | 200, `failing: false`, `kqlConfigured: true` |
| `/api/ready` | 200 |
| `/api/live` | 200, a non-empty vehicle array |
| `/api/route-performance?lookback=30m` | 200 |
| `/api/route-performance?lookback=99h` | 400 |
| Rayfin app | Loads with source status `GTFS-RT live` |

The 400 confirms the lookback allow list is enforced. Also compare
`max(ingestion_time())` against `max(ObservedAt)` in `VehiclePositions`: if
ingestion is current but observations are old, the stream is lagging rather
than stopped.

See [Post-Deployment Validation](DEPLOYMENT.md#post-deployment-validation).

## Before exposing this publicly

The publisher endpoints are unauthenticated. Confirm each of these:

* `PUBLISHER_ALLOWED_ORIGIN` equals the Rayfin origin exactly, with no
  trailing slash. CORS restricts browsers, not clients.
* `PUBLISHER_RATE_LIMIT_PER_MINUTE` is set. It defaults to 60 and throttles
  casual abuse rather than replacing a gateway.
* `PUBLISHER_EXPOSE_ERROR_DETAIL` stays false, so health checks report that a
  dependency failed without naming it.
* A gateway, authentication, and monitoring are in place before any internal
  TTC, employee, incident, or passenger data flows through this API.

See [SECURITY.md](SECURITY.md).

## Common surprises

**Capacity pause breaks three things.** Resuming is not enough. The Eventstream
Custom Endpoint password rotates, so re-fetch it, update the secret, and restart
the revision. The Eventstream also stops processing and must be resumed
explicitly.

**`%pip install` does not work in notebook job runs.** The notebooks install
dependencies through `subprocess` instead.

**Low Eventstream throughput cannot keep pace.** Observation lag grows until
`CurrentFleet()`, which looks back 10 minutes, returns nothing.

See [Troubleshooting](DEPLOYMENT.md#troubleshooting).
