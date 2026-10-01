import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTransitFeed } from '@/hooks/useTransitFeed';
import type { TransitSnapshot } from '@/types/transit';

const observedAt = '2026-09-25T13:00:00.000Z';
const liveSnapshot: TransitSnapshot = {
  source: 'ttc-gtfs-rt',
  observedAt,
  vehicles: [{
    id: '2100',
    routeId: '29',
    tripId: 'trip-29',
    label: '29 - 2100',
    mode: 'bus',
    latitude: 43.67,
    longitude: -79.39,
    bearing: 0,
    speedKph: 20,
    scheduleDeviationSeconds: 0,
    occupancy: 'unknown',
    state: 'on-time',
    observedAt,
  }],
  alerts: [],
};

function response(snapshot: unknown = liveSnapshot) {
  return { ok: true, json: async () => snapshot } as Response;
}

beforeEach(() => {
  vi.stubEnv('VITE_TELEMETRY_API_URL', 'https://telemetry.example.test');
  vi.setSystemTime(new Date(observedAt));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('useTransitFeed', () => {
  it('does not replace an unavailable live feed with simulated metrics', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Feed unavailable')));

    const { result } = renderHook(() => useTransitFeed());

    expect(result.current.connectionState).toBe('connecting');
    expect(result.current.hasSnapshot).toBe(false);
    expect(result.current.snapshot.vehicles).toEqual([]);
    await waitFor(() => expect(result.current.error).toBe('Feed unavailable'));
    expect(result.current.connectionState).toBe('degraded');
    expect(result.current.snapshot.source).toBe('ttc-gtfs-rt');
    expect(result.current.snapshot.vehicles).toEqual([]);
    expect(result.current.snapshot.alerts).toEqual([]);
  });

  it('retains the last known snapshot on failure and recovers on refresh', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useTransitFeed());
    await waitFor(() => expect(result.current.connectionState).toBe('connected'));

    fetchMock.mockRejectedValue(new Error('Feed unavailable'));
    await act(() => result.current.refresh());
    expect(result.current.snapshot).toEqual(liveSnapshot);
    expect(result.current.hasSnapshot).toBe(true);
    expect(result.current.connectionState).toBe('degraded');

    fetchMock.mockResolvedValue(response({ ...liveSnapshot, vehicles: [] }));
    await act(() => result.current.refresh());
    expect(result.current.connectionState).toBe('connected');
    expect(result.current.snapshot.vehicles).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('uses a complete publisher snapshot before querying the asynchronously ingested fleet', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useTransitFeed());

    await waitFor(() => expect(result.current.connectionState).toBe('connected'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://telemetry.example.test/api/snapshot');
    expect(result.current.snapshot).toEqual(liveSnapshot);
  });

  it('falls back to Eventhouse without caching telemetry when the publisher snapshot is unavailable', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce(response());
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useTransitFeed());

    await waitFor(() => expect(result.current.connectionState).toBe('connected'));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://telemetry.example.test/api/snapshot',
      'https://telemetry.example.test/api/live',
    ]);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ cache: 'no-store' });
  });

  it.each([
    null,
    { ...liveSnapshot, source: 'simulated' },
    { ...liveSnapshot, observedAt: 'not-a-date' },
    { ...liveSnapshot, observedAt: '2026-09-26T13:00:00.000Z' },
    { ...liveSnapshot, vehicles: [null] },
    { ...liveSnapshot, vehicles: [{ ...liveSnapshot.vehicles[0], scheduleDeviationSeconds: '120' }] },
    { ...liveSnapshot, vehicles: [liveSnapshot.vehicles[0], liveSnapshot.vehicles[0]] },
    { ...liveSnapshot, alerts: [{ id: 'missing-fields' }] },
  ])('rejects invalid live telemetry: %j', async (snapshot) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(snapshot)));
    const { result } = renderHook(() => useTransitFeed());

    await waitFor(() => expect(result.current.error).toBe('Telemetry API returned an invalid snapshot.'));
    expect(result.current.hasSnapshot).toBe(false);
    expect(result.current.snapshot.vehicles).toEqual([]);
  });

  it('marks repeated old observations stale even when HTTP requests succeed', async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(observedAt));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()));
    const { result } = renderHook(() => useTransitFeed());
    await act(async () => {});
    expect(result.current.connectionState).toBe('connected');

    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(result.current.connectionState).toBe('stale');
    expect(result.current.observationAgeSeconds).toBe(120);
    expect(result.current.snapshot).toEqual(liveSnapshot);
  });

  it('prevents overlapping requests and aborts polling on pause', async () => {
    let resolveFetch!: (value: Response) => void;
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useTransitFeed());

    await act(() => result.current.refresh());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => result.current.setPaused(true));
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => resolveFetch(response()));
    expect(result.current.hasSnapshot).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('aborts pending requests on unmount without starting a fallback request', async () => {
    const fetchMock = vi.fn().mockImplementation((_url, { signal }: RequestInit) =>
      new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason)))
    );
    vi.stubGlobal('fetch', fetchMock);
    const { unmount } = renderHook(() => useTransitFeed());

    unmount();
    await act(async () => {});
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('bounds hanging requests and reports unavailability after both sources time out', async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(observedAt));
    const fetchMock = vi.fn().mockImplementation((_url, { signal }: RequestInit) =>
      new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason)))
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useTransitFeed());

    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBe('Telemetry request timed out.');
    expect(result.current.hasSnapshot).toBe(false);
    expect(result.current.refreshing).toBe(false);
  });

  it('only generates simulated data when no live provider is configured', async () => {
    vi.stubEnv('VITE_TELEMETRY_API_URL', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useTransitFeed());

    await act(() => result.current.refresh());
    expect(result.current.connectionState).toBe('simulated');
    expect(result.current.snapshot.source).toBe('simulated');
    expect(result.current.snapshot.vehicles.length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
