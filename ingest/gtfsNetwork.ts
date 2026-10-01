import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { simplify } from '@turf/simplify';
import { parse } from 'csv-parse';

import type { Coordinate, TransitAgency, TransitMode, TransitRoute, TransitStop } from '../src/types/transit.js';

export type GtfsRecord = Record<string, string>;

const SHAPE_SIMPLIFICATION_TOLERANCE_DEGREES = 0.00001;

function routeMode(route: GtfsRecord): TransitMode | null {
  const routeType = route.route_type;
  // Route type 0 covers streetcars and light rail alike. TTC names only its
  // light rail rapid transit "<name> Line" (Line 5 Eglinton, Line 6 Finch
  // West), and those lines belong with the subway network.
  if (routeType === '0') return route.route_long_name?.trim().endsWith(' Line') ? 'subway' : 'streetcar';
  if (routeType === '1') return 'subway';
  if (routeType === '2') return 'rail';
  if (routeType === '3') return 'bus';
  return null;
}

export function buildGtfsRoutes(
  routeRecords: GtfsRecord[],
  tripRecords: GtfsRecord[],
  shapeRecords: GtfsRecord[]
): TransitRoute[] {
  const shapeIdsByRoute = new Map<string, Set<string>>();
  const tripCounts = new Map<string, number>();
  const referencedShapes = new Set<string>();
  for (const trip of tripRecords) {
    if (trip.route_id) tripCounts.set(trip.route_id, (tripCounts.get(trip.route_id) ?? 0) + 1);
    if (!trip.route_id || !trip.shape_id) continue;
    const shapeIds = shapeIdsByRoute.get(trip.route_id) ?? new Set<string>();
    shapeIds.add(trip.shape_id);
    shapeIdsByRoute.set(trip.route_id, shapeIds);
    referencedShapes.add(trip.shape_id);
  }

  const pointsByShape = new Map<string, Array<{ sequence: number; coordinate: Coordinate }>>();
  for (const point of shapeRecords) {
    if (!referencedShapes.has(point.shape_id)) continue;
    const longitude = Number(point.shape_pt_lon);
    const latitude = Number(point.shape_pt_lat);
    const sequence = Number(point.shape_pt_sequence);
    if (!point.shape_pt_lon?.trim() || !point.shape_pt_lat?.trim() ||
        !point.shape_pt_sequence?.trim() || !Number.isFinite(longitude) ||
        !Number.isFinite(latitude) || Math.abs(longitude) > 180 ||
        Math.abs(latitude) > 90 || !Number.isInteger(sequence) || sequence < 0) {
      throw new Error(`Invalid GTFS shape point in ${point.shape_id}.`);
    }
    const points = pointsByShape.get(point.shape_id) ?? [];
    points.push({ sequence, coordinate: [longitude, latitude] });
    pointsByShape.set(point.shape_id, points);
  }
  const pathsByShape = new Map<string, Coordinate[]>();
  for (const [shapeId, points] of pointsByShape) {
    const path = points.sort((left, right) => left.sequence - right.sequence).map((point) => point.coordinate);
    if (path.length < 2) {
      pathsByShape.set(shapeId, path);
      continue;
    }
    const simplified = simplify({
      type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: path },
    }, { tolerance: SHAPE_SIMPLIFICATION_TOLERANCE_DEGREES, highQuality: true });
    pathsByShape.set(shapeId, simplified.geometry.coordinates as Coordinate[]);
  }

  return routeRecords.flatMap((route): TransitRoute[] => {
    const mode = routeMode(route);
    if (!mode) return [];
    const shapeIds = [...(shapeIdsByRoute.get(route.route_id) ?? [])].sort();
    if (shapeIds.length === 0) return [];
    const paths = shapeIds.map((shapeId) => {
      const path = pathsByShape.get(shapeId);
      if (!path || path.length < 2) {
        throw new Error(`Missing usable GTFS shape ${shapeId} for route ${route.route_id}.`);
      }
      return path;
    });
    const path = paths.reduce((longest, candidate) => candidate.length > longest.length ? candidate : longest);
    const fallbackColor = mode === 'streetcar' ? '#d71920' : mode === 'subway' ? '#3f9f58' : '#1b74bb';
    return [{
      id: route.route_id,
      scheduledTrips: tripCounts.get(route.route_id) ?? 0,
      shortName: route.route_short_name || route.route_id,
      longName: route.route_long_name || route.route_short_name || route.route_id,
      mode,
      color: /^[0-9a-fA-F]{6}$/.test(route.route_color) ? `#${route.route_color}` : fallbackColor,
      path,
      paths,
    }];
  }).sort((left, right) => left.shortName.localeCompare(right.shortName, undefined, { numeric: true }));
}

export async function readGtfsStopRouteIds(
  input: Readable,
  tripRecords: GtfsRecord[],
  routeIds: ReadonlySet<string>
): Promise<Map<string, Set<string>>> {
  const tripRoutes = new Map(tripRecords
    .filter((trip) => routeIds.has(trip.route_id))
    .map((trip) => [trip.trip_id, trip.route_id]));
  const stopRoutes = new Map<string, Set<string>>();
  await pipeline(input, parse({ bom: true, columns: true, skip_empty_lines: true }), async (records) => {
    for await (const row of records) {
      const record = row as GtfsRecord;
      const routeId = tripRoutes.get(record.trip_id);
      if (!routeId || !record.stop_id) continue;
      const linkedRoutes = stopRoutes.get(record.stop_id) ?? new Set<string>();
      linkedRoutes.add(routeId);
      stopRoutes.set(record.stop_id, linkedRoutes);
    }
  });
  return stopRoutes;
}

export function buildGtfsStops(
  stopRecords: GtfsRecord[],
  stopRouteIds: ReadonlyMap<string, ReadonlySet<string>>
): TransitStop[] {
  const linkedRoutes = new Map([...stopRouteIds].map(([stopId, routeIds]) => [stopId, new Set(routeIds)]));
  for (const stop of stopRecords) {
    if (!stop.parent_station) continue;
    const parentRoutes = linkedRoutes.get(stop.parent_station) ?? new Set<string>();
    for (const routeId of stopRouteIds.get(stop.stop_id) ?? []) parentRoutes.add(routeId);
    linkedRoutes.set(stop.parent_station, parentRoutes);
  }
  return stopRecords.flatMap((stop): TransitStop[] => {
    if (!['', '0', '1'].includes(stop.location_type ?? '')) return [];
    const routeIds = [...(linkedRoutes.get(stop.stop_id) ?? [])].sort();
    if (routeIds.length === 0) return [];
    const longitude = Number(stop.stop_lon);
    const latitude = Number(stop.stop_lat);
    if (!stop.stop_lon?.trim() || !stop.stop_lat?.trim() ||
        !Number.isFinite(longitude) || !Number.isFinite(latitude) ||
        Math.abs(longitude) > 180 || Math.abs(latitude) > 90) {
      throw new Error(`Invalid GTFS stop coordinates for ${stop.stop_id}.`);
    }
    return [{
      id: stop.stop_id,
      name: stop.stop_name || stop.stop_id,
      latitude,
      longitude,
      parentStation: stop.parent_station || undefined,
      wheelchairBoarding: stop.wheelchair_boarding || undefined,
      routeIds,
    }];
  });
}

export function identifyGtfsNetwork(
  routes: TransitRoute[],
  stops: TransitStop[],
  agency: TransitAgency
): { routes: TransitRoute[]; stops: TransitStop[] } {
  const qualify = (id: string) => agency === 'ttc' ? id : `${agency}:${id}`;
  return {
    routes: routes.map((route) => ({
      ...route,
      id: qualify(route.id),
      agency,
      gtfsRouteId: route.id,
    })),
    stops: stops.map((stop) => ({
      ...stop,
      id: qualify(stop.id),
      agency,
      gtfsStopId: stop.id,
      parentStation: stop.parentStation ? qualify(stop.parentStation) : undefined,
      routeIds: stop.routeIds?.map(qualify),
    })),
  };
}
