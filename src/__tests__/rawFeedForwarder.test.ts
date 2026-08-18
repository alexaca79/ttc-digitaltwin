import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { encodeRawFeed } from '../../ingest/rawFeedForwarder.js';

describe('raw GTFS-realtime forwarding', () => {
  it('wraps a feed in a gzip and base64 envelope that round-trips', () => {
    const payload = Buffer.from('protobuf-bytes-'.repeat(200), 'utf8');
    const event = encodeRawFeed('trips', payload, '2026-08-18T14:00:00.000Z');

    expect(event.eventType).toBe('RawFeed');
    expect(event.feed).toBe('trips');
    expect(event.encoding).toBe('gzip+base64');
    expect(event.rawBytes).toBe(payload.byteLength);
    expect(gunzipSync(Buffer.from(event.payload, 'base64')).equals(payload)).toBe(true);
  });

  it('compresses well below the Event Hubs single-message limit', () => {
    const payload = Buffer.from('vehicle-position-entity-'.repeat(30_000), 'utf8');
    const event = encodeRawFeed('vehicles', payload, '2026-08-18T14:00:00.000Z');

    expect(Buffer.byteLength(event.payload, 'utf8')).toBeLessThan(900_000);
  });

  it('rejects a feed that would exceed the publish limit once encoded', () => {
    // Random bytes defeat gzip, so this stands in for an incompressible feed.
    const incompressible = Buffer.alloc(2_000_000);
    for (let index = 0; index < incompressible.length; index += 1) {
      incompressible[index] = Math.floor(Math.random() * 256);
    }

    expect(() => encodeRawFeed('trips', incompressible, '2026-08-18T14:00:00.000Z')).toThrow(
      /exceeds the 900000-byte publish limit/
    );
  });
});
