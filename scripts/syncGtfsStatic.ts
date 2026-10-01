import { createReadStream, createWriteStream, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'csv-parse/sync';
import unzipper from 'unzipper';

import { buildGtfsRoutes, buildGtfsStops, identifyGtfsNetwork, readGtfsStopRouteIds } from '../ingest/gtfsNetwork.js';
import { buildGtfsScheduleIndex } from '../ingest/gtfsSchedule.js';
import type { StaticNetworkAsset, TransitAgency, TransitFeedMetadata } from '../src/types/transit.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rawOutput = join(root, 'data', 'gtfs-static');
const webOutput = join(root, 'public', 'data', 'gta-network.json');

interface FeedConfig {
  agency: TransitAgency;
  name: string;
  sourceUrl: string;
  licenseUrl: string;
  directory: string;
}

const feeds: FeedConfig[] = [
  {
    agency: 'ttc', name: 'TTC', directory: rawOutput,
    sourceUrl: process.env.TTC_GTFS_STATIC_URL
      ?? 'https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/b811ead4-6eaf-4adb-8408-d389fb5a069c/resource/c920e221-7a1c-488b-8c5b-6d8cd4e85eaf/download/Complete%20GTFS.zip',
    licenseUrl: 'https://open.toronto.ca/open-data-licence/',
  },
  {
    agency: 'go', name: 'GO Transit', directory: join(rawOutput, 'go'),
    sourceUrl: process.env.GO_GTFS_STATIC_URL
      ?? 'https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/GO-GTFS.zip',
    licenseUrl: 'https://www.gotransit.com/en/partner-with-us/software-developers',
  },
  {
    agency: 'up', name: 'UP Express', directory: join(rawOutput, 'up'),
    sourceUrl: process.env.UP_GTFS_STATIC_URL
      ?? 'https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/UP-GTFS.zip',
    licenseUrl: 'https://www.gotransit.com/en/partner-with-us/software-developers',
  },
];

type CsvRecord = Record<string, string>;

function records(buffer: Buffer) {
  return parse(buffer, {
    bom: true,
    columns: true,
    relaxColumnCount: true,
    skipEmptyLines: true,
  }) as CsvRecord[];
}

function calendarDate(value: string | undefined) {
  return value && /^\d{8}$/.test(value)
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
    : undefined;
}

function writeAsset(path: string, asset: StaticNetworkAsset) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(asset)}\n`, 'utf8');
  renameSync(`${path}.tmp`, path);
}

async function importFeed(feed: FeedConfig): Promise<StaticNetworkAsset> {
  console.log(`Downloading ${feed.name} GTFS from ${feed.sourceUrl}`);
  const response = await fetch(feed.sourceUrl, { signal: AbortSignal.timeout(600_000) });
  if (!response.ok) throw new Error(`GTFS download failed (${response.status}): ${response.statusText}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const archive = await unzipper.Open.buffer(buffer);
  mkdirSync(feed.directory, { recursive: true });
  writeFileSync(join(feed.directory, 'feed.zip'), buffer);

  const required = new Set(['agency.txt', 'routes.txt', 'trips.txt', 'stops.txt', 'shapes.txt', 'stop_times.txt']);
  const parsedNames = new Set(['routes.txt', 'trips.txt', 'stops.txt', 'shapes.txt', 'calendar.txt', 'calendar_dates.txt', 'feed_info.txt']);
  const files = new Set<string>();
  const parsed = new Map<string, CsvRecord[]>();
  for (const entry of archive.files.filter((candidate) => candidate.type === 'File')) {
    const name = (entry.path.split('/').at(-1) ?? entry.path).toLowerCase();
    if (!name.endsWith('.txt')) continue;
    if (files.has(name)) throw new Error(`${feed.name} GTFS contains duplicate ${name}.`);
    files.add(name);
    const targetPath = join(feed.directory, name);
    if (parsedNames.has(name)) {
      const buffer = await entry.buffer();
      writeFileSync(targetPath, buffer);
      parsed.set(name, records(buffer));
    } else {
      await pipeline(entry.stream(), createWriteStream(targetPath));
    }
  }

  for (const name of required) {
    if (!files.has(name)) throw new Error(`${feed.name} GTFS archive is missing ${name}.`);
  }
  if (!files.has('calendar.txt') && !files.has('calendar_dates.txt')) {
    throw new Error(`${feed.name} GTFS has no service calendar.`);
  }

  const routeRecords = parsed.get('routes.txt') ?? [];
  const tripRecords = parsed.get('trips.txt') ?? [];
  const stopRecords = parsed.get('stops.txt') ?? [];
  const shapeRecords = parsed.get('shapes.txt') ?? [];
  const routes = buildGtfsRoutes(routeRecords, tripRecords, shapeRecords);
  if (routes.length === 0) throw new Error(`${feed.name} has no usable route geometry.`);
  const stopRouteIds = await readGtfsStopRouteIds(
    createReadStream(join(feed.directory, 'stop_times.txt')),
    tripRecords,
    new Set(routes.map((route) => route.id))
  );
  const stops = buildGtfsStops(stopRecords, stopRouteIds);
  const services = new Set(tripRecords.map((trip) => trip.service_id).filter(Boolean));
  const calendar = parsed.get('calendar.txt') ?? [];
  const exceptionDates = (parsed.get('calendar_dates.txt') ?? []).map((record) => record.date);
  const firstDate = [...calendar.map((record) => record.start_date), ...exceptionDates].filter(Boolean).sort()[0];
  const lastDate = [...calendar.map((record) => record.end_date), ...exceptionDates].filter(Boolean).sort().at(-1);
  const info = parsed.get('feed_info.txt')?.[0];
  const generatedAt = new Date().toISOString();
  const metadata: TransitFeedMetadata = {
    agency: feed.agency, name: feed.name, sourceUrl: feed.sourceUrl, licenseUrl: feed.licenseUrl,
    generatedAt,
    validFrom: calendarDate(info?.feed_start_date || firstDate),
    validThrough: calendarDate(info?.feed_end_date || lastDate),
    version: info?.feed_version || undefined,
    files: [...files].sort(),
    routes: routes.length, stops: stops.length, trips: tripRecords.length, services: services.size,
    shapes: new Set(tripRecords.map((trip) => trip.shape_id).filter(Boolean)).size,
  };
  const network = identifyGtfsNetwork(routes, stops, feed.agency);

  const asset: StaticNetworkAsset = {
    generatedAt,
    sourceUrl: feed.sourceUrl,
    licenseUrl: feed.licenseUrl,
    feeds: [metadata],
    routes: network.routes,
    stops: network.stops,
    statistics: {
      routes: routes.length,
      stops: stops.length,
      trips: tripRecords.length,
      services: services.size,
    },
  };
  const indexedTrips = await buildGtfsScheduleIndex(
    join(feed.directory, 'stop_times.txt'),
    join(feed.directory, 'schedule-offsets.json')
  );
  console.log(
    `${feed.name} GTFS ready: ${routes.length} routes, ${stops.length} stops, ` +
      `${tripRecords.length} trips, ${services.size} service calendars.`
  );
  console.log(`Schedule index: ${indexedTrips} trips`);
  writeFileSync(join(feed.directory, 'import-manifest.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  return asset;
}

async function main() {
  const imported: StaticNetworkAsset[] = [];
  for (const feed of feeds) imported.push(await importFeed(feed));
  const combined: StaticNetworkAsset = {
    generatedAt: new Date().toISOString(),
    sourceUrl: feeds[0].sourceUrl,
    licenseUrl: feeds[0].licenseUrl,
    feeds: imported.flatMap((asset) => asset.feeds ?? []),
    routes: imported.flatMap((asset) => asset.routes),
    stops: imported.flatMap((asset) => asset.stops),
    statistics: {
      routes: imported.reduce((sum, asset) => sum + asset.statistics.routes, 0),
      stops: imported.reduce((sum, asset) => sum + asset.statistics.stops, 0),
      trips: imported.reduce((sum, asset) => sum + asset.statistics.trips, 0),
      services: imported.reduce((sum, asset) => sum + asset.statistics.services, 0),
    },
  };
  if (new Set(combined.routes.map((route) => route.id)).size !== combined.routes.length ||
      new Set(combined.stops.map((stop) => stop.id)).size !== combined.stops.length) {
    throw new Error('Cross-agency GTFS identifier collision.');
  }
  writeAsset(join(root, 'public', 'data', 'ttc-network.json'), imported[0]);
  writeAsset(webOutput, combined);
  console.log(`GTA network ready: ${combined.statistics.routes} routes, ${combined.statistics.stops} linked stops.`);
  console.log(`Dashboard network asset: ${webOutput}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});