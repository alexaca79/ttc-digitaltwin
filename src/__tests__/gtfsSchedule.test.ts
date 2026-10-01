import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildGtfsScheduleIndex,
  openGtfsScheduleLookup,
} from '../../ingest/gtfsSchedule';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('static GTFS schedule lookup', () => {
  it('indexes trip ranges and resolves stop times by sequence or unique stop ID', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ttc-schedule-'));
    temporaryDirectories.push(directory);
    const stopTimesPath = join(directory, 'stop_times.txt');
    const indexPath = join(directory, 'schedule-offsets.json');
    writeFileSync(
      stopTimesPath,
      [
        'trip_id,arrival_time,departure_time,stop_id,stop_sequence,stop_headsign',
        'trip-a,10:00:00,10:00:30,stop-1,1,Outbound',
        'trip-a,10:05:00,10:05:30,stop-2,2,Outbound',
        'trip-b,25:00:00,25:00:30,stop-3,1,Night',
        '',
      ].join('\r\n'),
      'utf8'
    );

    await expect(buildGtfsScheduleIndex(stopTimesPath, indexPath)).resolves.toBe(2);
    const lookup = await openGtfsScheduleLookup(directory);
    expect(lookup).not.toBeNull();
    await lookup!.prefetch(['trip-a', 'trip-b']);

    expect(lookup!.getStopTime('trip-a', 2, 'stop-2')).toMatchObject({
      arrivalSeconds: 36_300,
      departureSeconds: 36_330,
    });
    expect(lookup!.getStopTime('trip-b', 99, 'stop-3')).toMatchObject({
      arrivalSeconds: 90_000,
    });
    lookup!.close();
  });

  it('rejects a trip ID that a newer timetable reused on another route', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ttc-schedule-'));
    temporaryDirectories.push(directory);
    writeFileSync(
      join(directory, 'stop_times.txt'),
      [
        'trip_id,arrival_time,departure_time,stop_id,stop_sequence,stop_headsign',
        'trip-a,10:00:00,10:00:30,stop-1,1,Outbound',
        'trip-a,10:05:00,10:05:30,stop-2,2,Outbound',
        '',
      ].join('\n'),
      'utf8'
    );
    writeFileSync(join(directory, 'trips.txt'), 'route_id,service_id,trip_id\n71,1,trip-a\n', 'utf8');
    const lookup = await openGtfsScheduleLookup(directory);
    await lookup!.prefetch(['trip-a']);

    expect(lookup!.getStopTime('trip-a', 2, 'realtime-stop-id', '71')).toMatchObject({ stopId: 'stop-2' });
    expect(lookup!.getStopTime('trip-a', 2, 'realtime-stop-id', '504')).toBeNull();
    expect(lookup!.getStopTime('trip-a', 2, 'realtime-stop-id')).toMatchObject({ stopId: 'stop-2' });
    lookup!.close();
  });
});