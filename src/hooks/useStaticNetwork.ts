import { useEffect, useState } from 'react';

import type { StaticNetworkAsset, TransitRoute } from '@/types/transit';

interface StaticNetworkState {
  routes: TransitRoute[];
  asset: StaticNetworkAsset | null;
  error: string | null;
}

export function useStaticNetwork(): StaticNetworkState {
  const [state, setState] = useState<StaticNetworkState>({
    routes: [],
    asset: null,
    error: null,
  });

  useEffect(() => {
    const controller = new AbortController();
    fetch('/data/gta-network.json', { signal: controller.signal, cache: 'no-cache' })
      .then((response) => {
        if (!response.ok) throw new Error('Static GTA network asset is not available.');
        return response.json() as Promise<StaticNetworkAsset>;
      })
      .then((asset) => {
        if (controller.signal.aborted) return;
        if (!Array.isArray(asset.routes) || asset.routes.length === 0 || !Array.isArray(asset.stops)) {
          throw new Error('Static GTA network asset is invalid.');
        }
        const agencies = [
          { id: 'ttc', name: 'TTC' },
          { id: 'go', name: 'GO Transit' },
          { id: 'up', name: 'UP Express' },
        ];
        const missingAgencies = agencies.filter((agency) =>
          !asset.routes.some((route) => route.agency === agency.id) ||
          !asset.feeds?.some((feed) => feed.agency === agency.id)
        );
        if (missingAgencies.length > 0) {
          setState({
            routes: [], asset: null,
            error: `GTA route data is incomplete: ${missingAgencies.map((agency) => agency.name).join(', ')} missing.`,
          });
          return;
        }
        setState({ routes: asset.routes, asset, error: null });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && !(error instanceof DOMException && error.name === 'AbortError')) {
          setState({ routes: [], asset: null, error: 'GTA route geometry is unavailable.' });
        }
      });
    return () => controller.abort();
  }, []);

  return state;
}