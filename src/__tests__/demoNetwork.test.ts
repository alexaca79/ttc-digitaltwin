import { describe, expect, it } from 'vitest';

import {
  createSimulatedAlerts,
  createSimulatedVehicles,
  TTC_ROUTES,
} from '@/data/demoNetwork';

describe('TTC demo network', () => {
  it('produces stable, geographically valid vehicle telemetry', () => {
    const observedAt = new Date('2026-08-13T12:00:00Z');
    const first = createSimulatedVehicles(observedAt);
    const second = createSimulatedVehicles(observedAt);

    expect(first).toEqual(second);
    expect(first).toHaveLength(53);
    expect(new Set(first.map((vehicle) => vehicle.id)).size).toBe(first.length);
    expect(first.every((vehicle) => vehicle.latitude >= 43.58 && vehicle.latitude <= 43.8)).toBe(true);
    expect(first.every((vehicle) => vehicle.longitude >= -79.56 && vehicle.longitude <= -79.25)).toBe(true);
    expect(first.every((vehicle) => TTC_ROUTES.some((route) => route.id === vehicle.routeId))).toBe(true);
  });

  it('labels every synthetic service alert as simulated content', () => {
    const alerts = createSimulatedAlerts(new Date('2026-08-13T12:00:00Z'));

    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts.every((alert) => alert.description.toLowerCase().includes('synthetic'))).toBe(true);
  });
});