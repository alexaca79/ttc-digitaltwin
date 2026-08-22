---
title: Security Policy
---

Microsoft takes the security of our software products and services seriously,
which includes all source code repositories in our GitHub organizations.

## Reporting a vulnerability

Do not report security vulnerabilities through public GitHub issues.

For reporting instructions, contact information, and disclosure policy, review
the latest guidance for Microsoft repositories at
[https://aka.ms/SECURITY.md](https://aka.ms/SECURITY.md).

## Scope notes for this repository

This project reads public City of Toronto open data. It stores no personal
data, no fare data, and no employee data.

This repository supports two serving paths and they have different exposure.

The `TTCLiveOperations` Real-Time Dashboard reads Eventhouse directly and is
governed by Fabric identity. It exposes no public endpoint.

The React app is served from Fabric and requires sign-in, but it reads live
telemetry from the container publisher over a public HTTPS endpoint. That
endpoint is currently enabled. Understand these boundaries before relying on
it:

* The endpoints are unauthenticated. `PUBLISHER_ALLOWED_ORIGIN` restricts
  browser origins through CORS, which is not an authorization control.
* `PUBLISHER_RATE_LIMIT_PER_MINUTE` throttles per caller and defaults to 60.
  It limits casual abuse and does not replace a gateway.
* `/api/health` reports whether a dependency is failing but withholds the
  error text. Set `PUBLISHER_EXPOSE_ERROR_DETAIL=true` only on private
  deployments.
* `/api/route-performance` accepts an allow-listed lookback only, so caller
  input never reaches the query text.

Add authentication, a gateway, and monitoring before exposing internal TTC,
employee, incident, or passenger data through this API.
