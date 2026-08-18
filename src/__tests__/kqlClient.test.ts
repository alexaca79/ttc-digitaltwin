import { describe, expect, it } from 'vitest';

import { mapAlertRows, mapFleetRows } from '../../ingest/kqlClient.js';

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
