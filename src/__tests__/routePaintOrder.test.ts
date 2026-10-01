import { describe, expect, it } from 'vitest';

import { isTrunkRoute, routePaintTier, routesInPaintOrder } from '@/components/routePaintOrder';
import type { TransitMode, TransitRoute } from '@/types/transit';

function route(id: string, mode: TransitMode): TransitRoute {
  return { id, shortName: id, longName: id, mode, color: '#000000', path: [[-79.4, 43.65], [-79.39, 43.66]] };
}

const network = [
  route('1', 'subway'),
  route('5', 'subway'),
  route('go:LW', 'rail'),
  route('300', 'bus'),
  route('501', 'streetcar'),
  route('29', 'bus'),
];

describe('route paint order', () => {
  it('paints the TTC lines above rail, streetcars, and buses', () => {
    expect(routesInPaintOrder(network).map((candidate) => candidate.id)).toEqual([
      '300', '29', '501', 'go:LW', '1', '5',
    ]);
  });

  it('raises a focused route above every other route', () => {
    expect(routesInPaintOrder(network, '29').map((candidate) => candidate.id)).toEqual([
      '300', '501', 'go:LW', '1', '5', '29',
    ]);
    expect(routePaintTier(network[0], '29')).toBeLessThan(routePaintTier(network[5], '29'));
  });

  it('leaves the source order untouched', () => {
    const before = network.map((candidate) => candidate.id);
    routesInPaintOrder(network, '1');
    expect(network.map((candidate) => candidate.id)).toEqual(before);
  });

  it('treats subway and rail as trunk lines', () => {
    expect(network.filter(isTrunkRoute).map((candidate) => candidate.id)).toEqual(['1', '5', 'go:LW']);
  });
});
