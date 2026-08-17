import { describe, expect, it } from 'vitest';

import {
  computeScheduleDeviation,
  medianDeviation,
  parseGtfsTime,
} from '../../ingest/scheduleDeviation';

describe('GTFS schedule deviation', () => {
  it('computes the observed TTC late-running sample from predicted and scheduled times', () => {
    const scheduled = parseGtfsTime('10:50:55');

    expect(scheduled).not.toBeNull();
    expect(computeScheduleDeviation(1786719325, scheduled!)).toBe(270);
  });

  it('supports GTFS trips scheduled after 24:00', () => {
    const scheduled = parseGtfsTime('25:03:00');
    const predicted = Date.parse('2026-08-14T01:08:00-04:00') / 1000;

    expect(scheduled).not.toBeNull();
    expect(computeScheduleDeviation(predicted, scheduled!)).toBe(300);
  });

  it('keeps early arrivals negative and combines stop estimates with a median', () => {
    const scheduled = parseGtfsTime('11:12:00');
    const predicted = Date.parse('2026-08-14T11:10:00-04:00') / 1000;

    expect(scheduled).not.toBeNull();
    expect(computeScheduleDeviation(predicted, scheduled!)).toBe(-120);
    expect(medianDeviation([270, 300, 240])).toBe(270);
  });
});