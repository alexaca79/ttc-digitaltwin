import type { TransitMode, TransitRoute } from '@/types/transit';

// Lower tiers paint first, so rail and the TTC subway and LRT lines stay
// visible above the dense surface network instead of disappearing beneath it.
const MODE_PAINT_TIERS: Record<TransitMode, number> = {
  bus: 0,
  streetcar: 1,
  rail: 2,
  subway: 3,
};
const FOCUSED_PAINT_TIER = 4;

export function routePaintTier(route: TransitRoute, focusedRouteId?: string | null) {
  if (route.id === focusedRouteId) return FOCUSED_PAINT_TIER;
  return MODE_PAINT_TIERS[route.mode] ?? 0;
}

/** Rapid transit and regional rail draw wider than surface routes. */
export function isTrunkRoute(route: TransitRoute) {
  return route.mode === 'subway' || route.mode === 'rail';
}

/** Returns routes bottom to top; routes in the same tier keep their order. */
export function routesInPaintOrder(routes: readonly TransitRoute[], focusedRouteId?: string | null) {
  return [...routes].sort((left, right) =>
    routePaintTier(left, focusedRouteId) - routePaintTier(right, focusedRouteId)
  );
}
