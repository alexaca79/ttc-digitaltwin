import { useEffect, useState } from 'react';

import { TTC_ROUTES } from '@/data/demoNetwork';
import type { StaticNetworkAsset, TransitRoute } from '@/types/transit';

interface StaticNetworkState {
  routes: TransitRoute[];
  asset: StaticNetworkAsset | null;
}

export function useStaticNetwork(): StaticNetworkState {
  const [state, setState] = useState<StaticNetworkState>({
    routes: TTC_ROUTES,
    asset: null,
  });

  useEffect(() => {
    const controller = new AbortController();
    fetch('/data/ttc-network.json', { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('Static TTC network asset is not available.');
        return response.json() as Promise<StaticNetworkAsset>;
      })
      .then((asset) => {
        if (asset.routes.length > 0) setState({ routes: asset.routes, asset });
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setState({ routes: TTC_ROUTES, asset: null });
        }
      });
    return () => controller.abort();
  }, []);

  return state;
}