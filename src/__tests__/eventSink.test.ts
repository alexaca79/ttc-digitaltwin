import { describe, expect, it } from 'vitest';

import { batchTransitEvents } from '../../ingest/eventSink.js';
import type { ServiceAlertEvent } from '../../ingest/events.js';

function alertEvent(eventId: string, description: string): ServiceAlertEvent {
  return {
    eventType: 'ServiceAlert',
    eventId,
    observedAt: '2026-08-14T16:00:00.000Z',
    alertId: eventId,
    severity: 'warning',
    title: 'Service alert',
    description,
    routeIds: ['1'],
    cause: 'UNKNOWN_CAUSE',
    effect: 'UNKNOWN_EFFECT',
    activeStartEpochSeconds: 0,
    activeEndEpochSeconds: 0,
    source: 'ttc-gtfs-rt',
  };
}

describe('batchTransitEvents', () => {
  it('preserves event order within a single batch', () => {
    const batches = batchTransitEvents(
      [alertEvent('one', 'First'), alertEvent('two', 'Second')],
      10_000
    );

    expect(batches).toHaveLength(1);
    expect(batches[0].map((message) => message.key)).toEqual(['one', 'two']);
  });

  it('splits requests before their encoded size exceeds the limit', () => {
    const batches = batchTransitEvents(
      [alertEvent('one', 'x'.repeat(200)), alertEvent('two', 'x'.repeat(200))],
      700
    );

    expect(batches).toHaveLength(2);
    expect(batches.flat().map((message) => message.key)).toEqual(['one', 'two']);
  });

  it('rejects an individual event larger than the publish limit', () => {
    expect(() => batchTransitEvents([alertEvent('large', 'x'.repeat(500))], 200)).toThrow(
      "Transit event 'large'"
    );
  });
});