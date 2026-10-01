import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchLiveSnapshot, mapAlertRows, mapFleetRows } from '../../ingest/kqlClient.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function mockQueryRows(fleetRows: Array<Record<string, unknown>>, alertRows: Array<Record<string, unknown>> = []) {
  vi.stubEnv('IDENTITY_ENDPOINT', 'https://identity.example.test/token');
  vi.stubEnv('IDENTITY_HEADER', 'test-identity-header');
  vi.stubGlobal('fetch', vi.fn(async (url: string, request?: RequestInit) => {
    if (url.startsWith('https://identity.example.test/')) {
      return new Response(JSON.stringify({
        access_token: 'test-token',
        expires_on: String(Math.floor(Date.now() / 1000) + 3600),
      }));
    }
    const { csl } = JSON.parse(String(request?.body)) as { csl: string };
    const rows = csl.startsWith('CurrentFleet()') ? fleetRows : alertRows;
    const columns = Object.keys(rows[0] ?? {});
    return new Response(JSON.stringify({
      Tables: [{
        TableName: 'Table_0',
        Columns: columns.map((ColumnName) => ({ ColumnName })),
        Rows: rows.map((row) => columns.map((column) => row[column])),
      }],
    }));
  }));
}

describe('live snapshot freshness', () => {
  const config = { queryUri: 'https://kql.example.test', database: 'TTCOperations' };

  it('does not turn an empty current fleet into a fresh zero-vehicle snapshot', async () => {
    mockQueryRows([], [{ AlertId: 'still-active', ObservedAt: '2026-09-25T12:00:00Z' }]);

    await expect(fetchLiveSnapshot(config)).rejects.toThrow('No current vehicle observations are available.');
  });

  it('uses the newest vehicle observation rather than the request time', async () => {
    mockQueryRows([
      { VehicleId: '2100', ObservedAt: '2026-09-25T12:00:00Z' },
      { VehicleId: '2101', ObservedAt: '2026-09-25T12:01:00Z' },
    ]);

    const snapshot = await fetchLiveSnapshot(config);

    expect(snapshot.observedAt).toBe('2026-09-25T12:01:00.000Z');
    expect(snapshot.vehicles).toHaveLength(2);
  });

  it('bounds both live queries to the same two-minute freshness window as the UI', async () => {
    mockQueryRows([{ VehicleId: '2100', ObservedAt: '2026-09-25T12:00:00Z' }]);

    await fetchLiveSnapshot(config);

    const queries = vi.mocked(fetch).mock.calls
      .filter(([, request]) => request?.body)
      .map(([, request]) => (JSON.parse(String(request?.body)) as { csl: string }).csl);
    expect(queries).toHaveLength(2);
    for (const query of queries) {
      expect(query).toContain('| where ObservedAt > ago(2m)');
    }
  });
});

describe('Eventhouse row projection', () => {
  it('maps CurrentFleet() rows onto vehicle telemetry', () => {
    const [vehicle] = mapFleetRows([
      {
        ObservedAt: '2026-08-17T14:03:00Z',
        VehicleId: '1234',
        VehicleLabel: 'TTC 1234',
        TripId: 'trip-9',
        RouteId: '504',
        Mode: 'streetcar',
        Latitude: 43.6426,
        Longitude: -79.3871,
        Bearing: 180,
        SpeedKph: 22.5,
        ScheduleDeviationSeconds: 240,
        Occupancy: 'high',
        State: 'delayed',
      },
    ]);

    expect(vehicle).toEqual({
      id: '1234',
      routeId: '504',
      tripId: 'trip-9',
      label: 'TTC 1234',
      mode: 'streetcar',
      latitude: 43.6426,
      longitude: -79.3871,
      bearing: 180,
      speedKph: 22.5,
      scheduleDeviationSeconds: 240,
      occupancy: 'high',
      state: 'delayed',
      observedAt: '2026-08-17T14:03:00.000Z',
    });
  });

  it('preserves null schedule deviation and falls back to safe enum values', () => {
    const [vehicle] = mapFleetRows([
      {
        ObservedAt: '2026-08-17T14:03:00Z',
        VehicleId: '9',
        RouteId: '29',
        Mode: 'ferry',
        ScheduleDeviationSeconds: null,
        Occupancy: 'packed',
        State: 'teleporting',
      },
    ]);

    expect(vehicle.scheduleDeviationSeconds).toBeNull();
    expect(vehicle.mode).toBe('bus');
    expect(vehicle.occupancy).toBe('unknown');
    expect(vehicle.state).toBe('unknown');
    expect(vehicle.label).toBe('9');
  });

  it('parses ActiveAlerts() route arrays whether dynamic or serialized', () => {
    const alerts = mapAlertRows([
      {
        ObservedAt: '2026-08-17T14:00:00Z',
        AlertId: 'alert-1',
        Severity: 'critical',
        Title: 'Line 1 closure',
        Description: 'No service between St George and Union.',
        RouteIds: ['1'],
      },
      {
        ObservedAt: '2026-08-17T14:00:00Z',
        AlertId: 'alert-2',
        Severity: 'unknown-severity',
        Title: '',
        Description: 'Detour in effect.',
        RouteIds: '["504","505"]',
      },
    ]);

    expect(alerts[0].routeIds).toEqual(['1']);
    expect(alerts[1].routeIds).toEqual(['504', '505']);
    expect(alerts[1].severity).toBe('warning');
    expect(alerts[1].title).toBe('TTC service alert');
  });
});
