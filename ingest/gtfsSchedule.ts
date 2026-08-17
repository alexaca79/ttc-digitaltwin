import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

import { parse } from 'csv-parse/sync';

import { parseGtfsTime } from './scheduleDeviation.js';

type ByteRange = [offset: number, length: number];

interface ScheduleOffsetIndex {
  version: 1;
  sourceSize: number;
  sourceModifiedMs: number;
  trips: Record<string, ByteRange[]>;
}

export interface ScheduledStopTime {
  stopId: string;
  stopSequence: number;
  arrivalSeconds: number | null;
  departureSeconds: number | null;
}

export interface GtfsScheduleLookup {
  prefetch(tripIds: Iterable<string>): Promise<void>;
  getStopTime(tripId: string, stopSequence: number, stopId: string): ScheduledStopTime | null;
  close(): void;
}

function newlineLength(path: string) {
  const descriptor = openSync(path, 'r');
  try {
    const sample = Buffer.alloc(64 * 1024);
    const bytesRead = readSync(descriptor, sample, 0, sample.length, 0);
    const newline = sample.subarray(0, bytesRead).indexOf(0x0a);
    return newline > 0 && sample[newline - 1] === 0x0d ? 2 : 1;
  } finally {
    closeSync(descriptor);
  }
}

export async function buildGtfsScheduleIndex(stopTimesPath: string, indexPath: string) {
  const source = statSync(stopTimesPath);
  const lineEndingLength = newlineLength(stopTimesPath);
  const trips: Record<string, ByteRange[]> = Object.create(null) as Record<string, ByteRange[]>;
  const lines = createInterface({
    input: createReadStream(stopTimesPath),
    crlfDelay: Infinity,
  });

  let offset = 0;
  let header = true;
  let currentTripId = '';
  let currentOffset = 0;
  let currentLength = 0;

  const finishRange = () => {
    if (!currentTripId || currentLength === 0) return;
    const ranges = trips[currentTripId] ?? [];
    ranges.push([currentOffset, currentLength]);
    trips[currentTripId] = ranges;
  };

  for await (const line of lines) {
    const lineLength = Buffer.byteLength(line) + lineEndingLength;
    if (header) {
      header = false;
      offset += lineLength;
      continue;
    }

    const comma = line.indexOf(',');
    const tripId = comma > 0 ? line.slice(0, comma) : '';
    if (tripId !== currentTripId) {
      finishRange();
      currentTripId = tripId;
      currentOffset = offset;
      currentLength = 0;
    }
    currentLength += lineLength;
    offset += lineLength;
  }
  finishRange();

  const index: ScheduleOffsetIndex = {
    version: 1,
    sourceSize: source.size,
    sourceModifiedMs: source.mtimeMs,
    trips,
  };
  mkdirSync(dirname(indexPath), { recursive: true });
  const temporaryPath = `${indexPath}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(index), 'utf8');
  renameSync(temporaryPath, indexPath);
  return Object.keys(trips).length;
}

function readIndex(path: string, stopTimesPath: string) {
  if (!existsSync(path)) return null;
  const source = statSync(stopTimesPath);
  const index = JSON.parse(readFileSync(path, 'utf8')) as ScheduleOffsetIndex;
  if (
    index.version !== 1
    || index.sourceSize !== source.size
    || index.sourceModifiedMs !== source.mtimeMs
  ) {
    return null;
  }
  return index;
}

export async function openGtfsScheduleLookup(
  staticDirectory: string
): Promise<GtfsScheduleLookup | null> {
  const stopTimesPath = join(staticDirectory, 'stop_times.txt');
  const indexPath = join(staticDirectory, 'schedule-offsets.json');
  if (!existsSync(stopTimesPath)) return null;

  let index = readIndex(indexPath, stopTimesPath);
  if (!index) {
    const tripCount = await buildGtfsScheduleIndex(stopTimesPath, indexPath);
    console.log(`Built static schedule index for ${tripCount} TTC trips.`);
    index = readIndex(indexPath, stopTimesPath);
  }
  if (!index) throw new Error('Static GTFS schedule index could not be loaded.');

  const descriptor = openSync(stopTimesPath, 'r');
  const cache = new Map<string, ScheduledStopTime[]>();

  return {
    async prefetch(tripIds) {
      const missing = [...new Set(tripIds)]
        .filter((tripId) => tripId && !cache.has(tripId))
        .sort((left, right) => (index?.trips[left]?.[0]?.[0] ?? 0) - (index?.trips[right]?.[0]?.[0] ?? 0));

      for (const tripId of missing) {
        const ranges = index?.trips[tripId] ?? [];
        const buffers = ranges.map(([offset, length]) => {
          const buffer = Buffer.alloc(length);
          const bytesRead = readSync(descriptor, buffer, 0, length, offset);
          return buffer.subarray(0, bytesRead);
        });
        const rows = buffers.length === 0
          ? []
          : parse(Buffer.concat(buffers), {
              bom: true,
              relaxColumnCount: true,
              skipEmptyLines: true,
            }) as string[][];
        cache.set(
          tripId,
          rows.flatMap((row) => {
            const stopSequence = Number(row[4]);
            if (!Number.isInteger(stopSequence)) return [];
            return [{
              stopId: row[3] ?? '',
              stopSequence,
              arrivalSeconds: parseGtfsTime(row[1] ?? ''),
              departureSeconds: parseGtfsTime(row[2] ?? ''),
            }];
          })
        );
      }
    },

    getStopTime(tripId, stopSequence, stopId) {
      const stops = cache.get(tripId);
      if (!stops) return null;
      const sequenceMatch = stops.find((stop) => stop.stopSequence === stopSequence);
      if (sequenceMatch) return sequenceMatch;
      const stopMatches = stops.filter((stop) => stop.stopId === stopId);
      if (stopMatches.length === 1) return stopMatches[0];
      return null;
    },

    close() {
      closeSync(descriptor);
    },
  };
}