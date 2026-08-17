import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'csv-parse/sync';
import unzipper from 'unzipper';

import { buildGtfsScheduleIndex } from '../ingest/gtfsSchedule.js';
import type {
  Coordinate,
  StaticNetworkAsset,
  TransitMode,
  TransitRoute,
  TransitStop,
} from '../src/types/transit.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceUrl = process.env.TTC_GTFS_STATIC_URL
  ?? 'https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/b811ead4-6eaf-4adb-8408-d389fb5a069c/resource/c920e221-7a1c-488b-8c5b-6d8cd4e85eaf/download/Complete%20GTFS.zip';
const licenseUrl = 'https://open.toronto.ca/open-data-licence/';
const rawOutput = join(root, 'data', 'gtfs-static');
const webOutput = join(root, 'public', 'data', 'ttc-network.json');

type CsvRecord = Record<string, string>;

function mode(routeType: string): TransitMode | null {
  if (routeType === '0') return 'streetcar';
  if (routeType === '1') return 'subway';
  if (routeType === '3') return 'bus';
  return null;
}

function color(value: string, routeMode: TransitMode) {
  if (/^[0-9a-fA-F]{6}$/.test(value)) return `#${value}`;
  if (routeMode === 'streetcar') return '#d71920';
  if (routeMode === 'subway') return '#3f9f58';
  return '#1b74bb';
}

function compactPath(points: Coordinate[], maximumPoints = 420) {
  if (points.length <= maximumPoints) return points;
  const stride = Math.ceil(points.length / maximumPoints);
  const compacted = points.filter((_, index) => index % stride === 0);
  const finalPoint = points.at(-1);
  if (finalPoint && compacted.at(-1) !== finalPoint) compacted.push(finalPoint);
  return compacted;
}

function records(buffer: Buffer) {
  return parse(buffer, {
    bom: true,
    columns: true,
    relaxColumnCount: true,
    skipEmptyLines: true,
  }) as CsvRecord[];
}

async function main() {
  console.log(`Downloading TTC merged GTFS from ${sourceUrl}`);
  const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(600_000) });
  if (!response.ok) throw new Error(`GTFS download failed (${response.status}): ${response.statusText}`);
  const archive = await unzipper.Open.buffer(Buffer.from(await response.arrayBuffer()));
  mkdirSync(rawOutput, { recursive: true });

  const required = new Set(['routes.txt', 'trips.txt', 'stops.txt', 'shapes.txt']);
  const parsed = new Map<string, CsvRecord[]>();
  for (const entry of archive.files.filter((candidate) => candidate.type === 'File')) {
    const name = entry.path.split('/').at(-1) ?? entry.path;
    if (!name.endsWith('.txt')) continue;
    const targetPath = join(rawOutput, name);
    if (required.has(name)) {
      const buffer = await entry.buffer();
      writeFileSync(targetPath, buffer);
      parsed.set(name, records(buffer));
    } else {
      await pipeline(entry.stream(), createWriteStream(targetPath));
    }
  }

  for (const name of required) {
    if (!parsed.has(name)) throw new Error(`Merged GTFS archive is missing ${name}.`);
  }

  const routeRecords = parsed.get('routes.txt') ?? [];
  const tripRecords = parsed.get('trips.txt') ?? [];
  const stopRecords = parsed.get('stops.txt') ?? [];
  const shapeRecords = parsed.get('shapes.txt') ?? [];
  const routeById = new Map(
    routeRecords.flatMap((route) => {
      const routeMode = mode(route.route_type);
      return routeMode ? [[route.route_id, { record: route, mode: routeMode }] as const] : [];
    })
  );
  const shapeRoute = new Map<string, string>();
  const services = new Set<string>();
  for (const trip of tripRecords) {
    if (trip.shape_id && trip.route_id && !shapeRoute.has(trip.shape_id)) {
      shapeRoute.set(trip.shape_id, trip.route_id);
    }
    if (trip.service_id) services.add(trip.service_id);
  }

  const shapePoints = new Map<string, Array<{ sequence: number; coordinate: Coordinate }>>();
  for (const point of shapeRecords) {
    if (!shapeRoute.has(point.shape_id)) continue;
    const longitude = Number(point.shape_pt_lon);
    const latitude = Number(point.shape_pt_lat);
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) continue;
    const points = shapePoints.get(point.shape_id) ?? [];
    points.push({
      sequence: Number(point.shape_pt_sequence),
      coordinate: [longitude, latitude],
    });
    shapePoints.set(point.shape_id, points);
  }

  const longestShapeByRoute = new Map<string, Coordinate[]>();
  for (const [shapeId, points] of shapePoints) {
    const routeId = shapeRoute.get(shapeId);
    if (!routeId || !routeById.has(routeId)) continue;
    const path = points
      .sort((left, right) => left.sequence - right.sequence)
      .map((point) => point.coordinate);
    if (path.length > (longestShapeByRoute.get(routeId)?.length ?? 0)) {
      longestShapeByRoute.set(routeId, path);
    }
  }

  const routes: TransitRoute[] = [...routeById].flatMap(([routeId, route]) => {
    const path = longestShapeByRoute.get(routeId);
    if (!path || path.length < 2) return [];
    return [{
      id: routeId,
      shortName: route.record.route_short_name || routeId,
      longName: route.record.route_long_name || route.record.route_short_name || routeId,
      mode: route.mode,
      color: color(route.record.route_color, route.mode),
      path: compactPath(path),
    }];
  }).sort((left, right) => left.shortName.localeCompare(right.shortName, undefined, { numeric: true }));

  const stops: TransitStop[] = stopRecords.flatMap((stop) => {
    const longitude = Number(stop.stop_lon);
    const latitude = Number(stop.stop_lat);
    if (!stop.stop_id || !Number.isFinite(longitude) || !Number.isFinite(latitude)) return [];
    return [{
      id: stop.stop_id,
      name: stop.stop_name || stop.stop_id,
      latitude,
      longitude,
      parentStation: stop.parent_station || undefined,
      wheelchairBoarding: stop.wheelchair_boarding || undefined,
    }];
  });

  const asset: StaticNetworkAsset = {
    generatedAt: new Date().toISOString(),
    sourceUrl,
    licenseUrl,
    routes,
    stops,
    statistics: {
      routes: routes.length,
      stops: stops.length,
      trips: tripRecords.length,
      services: services.size,
    },
  };
  mkdirSync(dirname(webOutput), { recursive: true });
  writeFileSync(webOutput, `${JSON.stringify(asset)}\n`, 'utf8');
  const indexedTrips = await buildGtfsScheduleIndex(
    join(rawOutput, 'stop_times.txt'),
    join(rawOutput, 'schedule-offsets.json')
  );
  console.log(
    `Static GTFS ready: ${routes.length} routes, ${stops.length} stops, ` +
      `${tripRecords.length} trips, ${services.size} service calendars.`
  );
  console.log(`Raw GTFS files: ${rawOutput}`);
  console.log(`Schedule index: ${indexedTrips} trips`);
  console.log(`Dashboard network asset: ${webOutput}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});