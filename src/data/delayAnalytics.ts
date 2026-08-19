import type { TransitMode, VehicleTelemetry } from '@/types/transit';

export type DelayComparisonMode = Extract<TransitMode, 'bus' | 'streetcar'>;

export interface RouteDelaySummary {
  routeId: string;
  mode: DelayComparisonMode;
  averageDelayMinutes: number;
  delayedVehicles: number;
  trackedVehicles: number;
}

export interface LineOperationsSummary {
  routeId: string;
  mode: TransitMode;
  activeVehicles: number;
  scheduledVehicles: number;
  scheduleCoveragePercent: number;
  averagePositiveDelayMinutes: number;
  states: Record<VehicleTelemetry['state'], number>;
  statePercentages: Record<VehicleTelemetry['state'], number>;
}

export function summarizeLineOperations(
  vehicles: VehicleTelemetry[],
  routeId: string,
  mode: TransitMode
): LineOperationsSummary | null {
  const lineVehicles = vehicles.filter(
    (vehicle) => vehicle.routeId === routeId && vehicle.mode === mode
  );
  if (lineVehicles.length === 0) return null;

  const states: LineOperationsSummary['states'] = {
    'on-time': 0,
    delayed: 0,
    early: 0,
    unknown: 0,
  };
  let totalPositiveDelaySeconds = 0;
  let scheduledVehicles = 0;

  for (const vehicle of lineVehicles) {
    states[vehicle.state] += 1;
    if (vehicle.scheduleDeviationSeconds == null) continue;
    scheduledVehicles += 1;
    totalPositiveDelaySeconds += Math.max(0, vehicle.scheduleDeviationSeconds);
  }

  const activeVehicles = lineVehicles.length;
  return {
    routeId,
    mode,
    activeVehicles,
    scheduledVehicles,
    scheduleCoveragePercent: Math.round(
      (scheduledVehicles / activeVehicles) * 100
    ),
    averagePositiveDelayMinutes:
      scheduledVehicles > 0
        ? totalPositiveDelaySeconds / scheduledVehicles / 60
        : 0,
    states,
    statePercentages: {
      'on-time': Math.round((states['on-time'] / activeVehicles) * 100),
      delayed: Math.round((states.delayed / activeVehicles) * 100),
      early: Math.round((states.early / activeVehicles) * 100),
      unknown: Math.round((states.unknown / activeVehicles) * 100),
    },
  };
}

export function summarizeRouteDelays(
  vehicles: VehicleTelemetry[],
  mode: DelayComparisonMode,
  limit = 3
): RouteDelaySummary[] {
  const routes = new Map<
    string,
    { totalPositiveDelaySeconds: number; delayedVehicles: number; trackedVehicles: number }
  >();

  for (const vehicle of vehicles) {
    if (
      vehicle.mode !== mode ||
      vehicle.scheduleDeviationSeconds == null ||
      vehicle.routeId.trim() === ''
    ) {
      continue;
    }

    const route = routes.get(vehicle.routeId) ?? {
      totalPositiveDelaySeconds: 0,
      delayedVehicles: 0,
      trackedVehicles: 0,
    };
    route.totalPositiveDelaySeconds += Math.max(
      0,
      vehicle.scheduleDeviationSeconds
    );
    route.delayedVehicles += vehicle.state === 'delayed' ? 1 : 0;
    route.trackedVehicles += 1;
    routes.set(vehicle.routeId, route);
  }

  return [...routes.entries()]
    .filter(([, route]) => route.delayedVehicles > 0)
    .map(([routeId, route]) => ({
      routeId,
      mode,
      averageDelayMinutes:
        route.totalPositiveDelaySeconds / route.trackedVehicles / 60,
      delayedVehicles: route.delayedVehicles,
      trackedVehicles: route.trackedVehicles,
    }))
    .sort(
      (left, right) =>
        right.averageDelayMinutes - left.averageDelayMinutes ||
        right.delayedVehicles - left.delayedVehicles ||
        left.routeId.localeCompare(right.routeId, undefined, { numeric: true })
    )
    .slice(0, limit);
}