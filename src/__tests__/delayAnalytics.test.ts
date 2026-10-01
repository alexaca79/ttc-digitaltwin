import { describe, expect, it } from 'vitest';

import {
  summarizeLineOperations,
  summarizeNetworkOperations,
  summarizeRouteDelays,
} from '@/data/delayAnalytics';
import type { TransitMode, VehicleTelemetry } from '@/types/transit';

function vehicle(
  routeId: string,
  mode: TransitMode,
  delaySeconds: number | null
): VehicleTelemetry {
  return {
    id: `${mode}-${routeId}-${delaySeconds}`,
    routeId,
    tripId: 'trip',
    label: routeId,
    mode,
    latitude: 43.67,
    longitude: -79.39,
    bearing: 0,
    speedKph: 20,
    scheduleDeviationSeconds: delaySeconds,
    occupancy: 'unknown',
    state:
      delaySeconds == null
        ? 'unknown'
        : delaySeconds > 180
          ? 'delayed'
          : delaySeconds < -180
            ? 'early'
            : 'on-time',
    observedAt: '2026-08-14T00:00:00.000Z',
  };
}

describe('summarizeNetworkOperations', () => {
  it('uses only measured schedules as the on-time denominator', () => {
    expect(summarizeNetworkOperations([
      vehicle('29', 'bus', 600),
      vehicle('504', 'streetcar', 0),
      vehicle('1', 'subway', -240),
      vehicle('63', 'bus', null),
    ])).toEqual({
      trackedVehicles: 4,
      scheduledVehicles: 3,
      onTimeVehicles: 1,
      delayedVehicles: 1,
      earlyVehicles: 1,
      onTimePercent: 33,
      scheduleCoveragePercent: 75,
    });
  });

  it('derives state from deviation using the feed thresholds, including boundaries', () => {
    const vehicles = [-121, -120, 0, 180, 181].map((deviation) => ({
      ...vehicle('29', 'bus', deviation),
      state: 'unknown' as const,
    }));

    expect(summarizeNetworkOperations(vehicles)).toMatchObject({
      scheduledVehicles: 5,
      onTimeVehicles: 3,
      delayedVehicles: 1,
      earlyVehicles: 1,
      onTimePercent: 60,
      scheduleCoveragePercent: 100,
    });
  });

  it('does not count missing or non-finite estimates as measured schedules', () => {
    expect(summarizeNetworkOperations(
      [null, NaN, Infinity, -Infinity].map((delay) => vehicle('29', 'bus', delay))
    )).toMatchObject({
      trackedVehicles: 4,
      scheduledVehicles: 0,
      onTimeVehicles: 0,
      delayedVehicles: 0,
      earlyVehicles: 0,
      onTimePercent: null,
      scheduleCoveragePercent: 0,
    });
  });

  it('keeps an empty fleet distinct from zero-percent schedule performance', () => {
    expect(summarizeNetworkOperations([])).toEqual({
      trackedVehicles: 0,
      scheduledVehicles: 0,
      onTimeVehicles: 0,
      delayedVehicles: 0,
      earlyVehicles: 0,
      onTimePercent: null,
      scheduleCoveragePercent: null,
    });
  });
});

describe('summarizeRouteDelays', () => {
  it('ranks routes by average positive delay across tracked vehicles', () => {
    const vehicles = [
      vehicle('29', 'bus', 600),
      vehicle('29', 'bus', 0),
      vehicle('63', 'bus', 480),
      vehicle('63', 'bus', 240),
      vehicle('504', 'streetcar', 900),
      vehicle('504', 'streetcar', -120),
    ];

    expect(summarizeRouteDelays(vehicles, 'bus')).toEqual([
      {
        routeId: '63',
        mode: 'bus',
        averageDelayMinutes: 6,
        delayedVehicles: 2,
        trackedVehicles: 2,
      },
      {
        routeId: '29',
        mode: 'bus',
        averageDelayMinutes: 5,
        delayedVehicles: 1,
        trackedVehicles: 2,
      },
    ]);
    expect(summarizeRouteDelays(vehicles, 'streetcar')[0]).toMatchObject({
      routeId: '504',
      averageDelayMinutes: 7.5,
      delayedVehicles: 1,
      trackedVehicles: 2,
    });
  });

  it('excludes other modes, unknown schedules, and routes without delays', () => {
    const vehicles = [
      vehicle('1', 'subway', 900),
      vehicle('7', 'bus', null),
      vehicle('10', 'bus', 120),
    ];

    expect(summarizeRouteDelays(vehicles, 'bus')).toEqual([]);
  });
});

describe('summarizeLineOperations', () => {
  it('summarizes the selected route and mode as a current snapshot', () => {
    const vehicles = [
      vehicle('29', 'bus', 600),
      vehicle('29', 'bus', 0),
      vehicle('29', 'bus', -240),
      vehicle('29', 'bus', null),
      vehicle('29', 'streetcar', 900),
      vehicle('63', 'bus', 900),
    ];

    expect(summarizeLineOperations(vehicles, '29', 'bus')).toEqual({
      routeId: '29',
      mode: 'bus',
      activeVehicles: 4,
      scheduledVehicles: 3,
      scheduleCoveragePercent: 75,
      averagePositiveDelayMinutes: 10 / 3,
      states: {
        'on-time': 1,
        delayed: 1,
        early: 1,
        unknown: 1,
      },
      statePercentages: {
        'on-time': 25,
        delayed: 25,
        early: 25,
        unknown: 25,
      },
    });
  });

  it('returns no summary when the selected line has no active vehicles', () => {
    expect(summarizeLineOperations([], '29', 'bus')).toBeNull();
  });
});