import { gzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';

import type { RawFeedEvent, RawFeedName } from './events.js';

/** Feed path segments exposed by the TTC GTFS-realtime service. */
const FEEDS: RawFeedName[] = ['vehicles', 'trips', 'alerts'];

/**
 * Event Hubs rejects requests above 1 MB. Gzip keeps the largest TTC feed
 * (trips, ~590 KB raw) near 292 KB once base64-encoded, so a whole feed fits
 * in a single message without chunking.
 */
const MAX_ENCODED_BYTES = 900_000;

async function fetchRawFeed(feedBaseUrl: string, feed: RawFeedName): Promise<Buffer> {
  const response = await fetch(`${feedBaseUrl}/${feed}`, {
    headers: {
      Accept: 'application/x-protobuf, application/octet-stream',
      'User-Agent': 'ttc-digital-twin-open-data/1.0',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`${feedBaseUrl}/${feed} returned ${response.status} ${response.statusText}.`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('protobuf') && !contentType.includes('octet-stream')) {
    throw new Error(`${feedBaseUrl}/${feed} returned '${contentType}' instead of protobuf.`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export function encodeRawFeed(feed: RawFeedName, payload: Buffer, observedAt: string): RawFeedEvent {
  const encoded = gzipSync(payload).toString('base64');
  if (Buffer.byteLength(encoded, 'utf8') > MAX_ENCODED_BYTES) {
    throw new Error(
      `Raw ${feed} feed is ${Buffer.byteLength(encoded, 'utf8')} bytes encoded and exceeds the ` +
        `${MAX_ENCODED_BYTES}-byte publish limit.`
    );
  }
  return {
    eventType: 'RawFeed',
    eventId: randomUUID(),
    observedAt,
    feed,
    encoding: 'gzip+base64',
    rawBytes: payload.byteLength,
    payload: encoded,
    source: 'ttc-gtfs-rt',
  };
}

/**
 * Fetches each GTFS-realtime feed and forwards it untouched. Decoding and
 * schedule enrichment happen in the Fabric Spark notebook destination, so this
 * path deliberately performs no protobuf work.
 */
export async function collectRawFeeds(feedBaseUrl: string): Promise<RawFeedEvent[]> {
  const observedAt = new Date().toISOString();
  const results = await Promise.all(
    FEEDS.map(async (feed) => {
      const payload = await fetchRawFeed(feedBaseUrl, feed);
      return encodeRawFeed(feed, payload, observedAt);
    })
  );
  return results;
}
