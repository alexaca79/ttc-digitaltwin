import GtfsRealtimeBindings, { type transit_realtime } from 'gtfs-realtime-bindings';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GtfsScheduleLookup } from '../../ingest/gtfsSchedule';
import { pollTtcFeeds } from '../../ingest/ttcGtfsRt';

function encodeFeed(feed: transit_realtime.IFeedMessage) {
  const message = GtfsRealtimeBindings.transit_realtime.FeedMessage.create(feed);
  return Uint8Array.from(
    GtfsRealtimeBindings.transit_realtime.FeedMessage.encode(message).finish()
  ).buffer;
}

function stubFeeds(delay: number, predictedArrivalEpoch?: number) {
  const header = { gtfsRealtimeVersion: '2.0' };
  const feeds = new Map([
    ['/vehicles', encodeFeed({
      header,
      entity: [{
        id: 'position-1',
        vehicle: {
          trip: { tripId: 'trip-1', routeId: '7' },
          vehicle: { id: 'vehicle-1', label: 'Vehicle 1' },
          position: { latitude: 43.7, longitude: -79.4 },
        },
      }],
    })],
    ['/trips', encodeFeed({
      header,
      entity: [{
        id: 'update-1',
        tripUpdate: {
          trip: { tripId: 'trip-1', routeId: '7' },
          vehicle: { id: 'vehicle-1' },
          delay,
          stopTimeUpdate: predictedArrivalEpoch == null ? [] : [{
            stopId: 'stop-1',
            stopSequence: 1,
            arrival: { time: predictedArrivalEpoch },
          }],
        },
      }],
    })],
    ['/alerts', encodeFeed({ header, entity: [] })],
  ]);

  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const pathname = new URL(String(input)).pathname;
    const body = feeds.get(pathname);
    if (!body) return new Response(null, { status: 404 });
    return new Response(body, { status: 200 });
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TTC GTFS-RT schedule status', () => {
  it('does not treat an all-zero delay feed as proof that vehicles are on time', async () => {
    stubFeeds(0);

    const result = await pollTtcFeeds('https://example.test');

    expect(result.snapshot.vehicles[0]).toMatchObject({
      scheduleDeviationSeconds: null,
      state: 'unknown',
    });
    expect(result.events.find((event) => event.eventType === 'VehiclePosition')).toMatchObject({
      scheduleDeviationSeconds: null,
      state: 'unknown',
    });
  });

  it('retains a meaningful nonzero delay from the trip-update feed', async () => {
    stubFeeds(240);

    const result = await pollTtcFeeds('https://example.test');

    expect(result.snapshot.vehicles[0]).toMatchObject({
      scheduleDeviationSeconds: 240,
      state: 'delayed',
    });
  });

  it('computes delay from predicted and static stop times when TTC reports zero', async () => {
    stubFeeds(0, 1786719325);
    const scheduleLookup: GtfsScheduleLookup = {
      prefetch: vi.fn(async () => undefined),
      getStopTime: vi.fn(() => ({
        stopId: 'stop-1',
        stopSequence: 1,
        arrivalSeconds: 39_055,
        departureSeconds: 39_055,
      })),
      close: vi.fn(),
    };

    const result = await pollTtcFeeds('https://example.test', scheduleLookup);

    expect(result.snapshot.vehicles[0]).toMatchObject({
      scheduleDeviationSeconds: 270,
      state: 'delayed',
    });
    expect(result.events.find((event) => event.eventType === 'TripUpdate')).toMatchObject({
      delaySeconds: 270,
    });
  });
});