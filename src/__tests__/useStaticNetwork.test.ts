import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useStaticNetwork } from '@/hooks/useStaticNetwork';
import type { StaticNetworkAsset } from '@/types/transit';

const asset: StaticNetworkAsset = {
  generatedAt: '2026-09-28T12:00:00.000Z',
  sourceUrl: 'https://example.test/gtfs.zip',
  licenseUrl: 'https://example.test/license',
  routes: [{
    id: '29', agency: 'ttc', shortName: '29', longName: 'Dufferin', mode: 'bus', color: '#ED1C24',
    path: [[-79.435, 43.635], [-79.435, 43.65]],
  }, {
    id: 'go:LW', agency: 'go', shortName: 'LW', longName: 'Lakeshore West', mode: 'rail', color: '#007934',
    path: [[-79.38, 43.65], [-79.6, 43.55]],
  }, {
    id: 'up:UP', agency: 'up', shortName: 'UP', longName: 'Union Pearson Express', mode: 'rail', color: '#5B4B36',
    path: [[-79.38, 43.65], [-79.63, 43.68]],
  }],
  stops: [],
  statistics: { routes: 3, stops: 0, trips: 3, services: 3 },
  feeds: (['ttc', 'go', 'up'] as const).map((agency) => ({
    agency, name: agency, sourceUrl: 'https://example.test/gtfs.zip', licenseUrl: 'https://example.test/license',
    generatedAt: '2026-09-28T12:00:00.000Z', files: ['routes.txt', 'stops.txt'], routes: 1, stops: 0, trips: 1, services: 1, shapes: 1,
  })),
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useStaticNetwork', () => {
  it('waits for official geometry instead of drawing demo lines during loading', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => asset }));
    const { result } = renderHook(() => useStaticNetwork());

    expect(result.current.routes).toEqual([]);
    expect(result.current.asset).toBeNull();
    await waitFor(() => expect(result.current.asset).toEqual(asset));
    expect(result.current.routes).toEqual(asset.routes);
    expect(result.current.error).toBeNull();
  });

  it('does not substitute invented route lines when the spatial feed fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Offline')));
    const { result } = renderHook(() => useStaticNetwork());

    await waitFor(() => expect(result.current.error).toBe('GTA route geometry is unavailable.'));
    expect(result.current.routes).toEqual([]);
    expect(result.current.asset).toBeNull();
  });

  it('rejects an empty spatial asset without falling back to demo geography', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ ...asset, routes: [] }),
    }));
    const { result } = renderHook(() => useStaticNetwork());

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.routes).toEqual([]);
  });

  it.each(['go', 'up'])('reports missing %s geometry instead of accepting a partial GTA dataset', async (agency) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ ...asset, routes: asset.routes.filter((route) => route.agency !== agency) }),
    }));
    const { result } = renderHook(() => useStaticNetwork());

    await waitFor(() => expect(result.current.error).toContain(agency === 'go' ? 'GO Transit missing' : 'UP Express missing'));
    expect(result.current.routes).toEqual([]);
  });
});
