import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { buildGtfsRoutes, buildGtfsStops, identifyGtfsNetwork, readGtfsStopRouteIds, type GtfsRecord } from '../../ingest/gtfsNetwork.js';

const routes: GtfsRecord[] = [
  { route_id: '29', route_short_name: '29', route_long_name: 'Dufferin', route_type: '3', route_color: 'ED1C24' },
  { route_id: '504', route_short_name: '504', route_long_name: 'King', route_type: '0', route_color: 'ED1C24' },
  { route_id: '1', route_short_name: '1', route_long_name: 'Yonge-University', route_type: '1', route_color: 'D5C82B' },
];
const trips: GtfsRecord[] = [
  { trip_id: 'bus-out', route_id: '29', shape_id: 'outbound' },
  { trip_id: 'bus-back', route_id: '29', shape_id: 'inbound' },
  { trip_id: 'bus-again', route_id: '29', shape_id: 'outbound' },
  { trip_id: 'streetcar', route_id: '504', shape_id: 'outbound' },
  { trip_id: 'subway', route_id: '1', shape_id: 'rail' },
];
const shapes = ['outbound', 'inbound', 'rail'].flatMap((shapeId, index) => [
  { shape_id: shapeId, shape_pt_sequence: '2', shape_pt_lon: String(-79.4 + index / 100), shape_pt_lat: '43.66' },
  { shape_id: shapeId, shape_pt_sequence: '1', shape_pt_lon: String(-79.41 + index / 100), shape_pt_lat: '43.65' },
]);

describe('GTFS spatial relationships', () => {
  it('preserves separate direction paths without joining unrelated endpoints', () => {
    const result = buildGtfsRoutes(routes, trips, shapes);
    const bus = result.find((route) => route.id === '29');

    expect(bus?.paths).toHaveLength(2);
    expect(bus?.paths).toContainEqual([[-79.41, 43.65], [-79.4, 43.66]]);
    expect(bus?.paths?.every((path) => path.length === 2)).toBe(true);
    expect(result.find((route) => route.id === '504')?.paths).toEqual([[[-79.41, 43.65], [-79.4, 43.66]]]);
  });

  it('links shared shapes to every owning route and honors GTFS mode types', () => {
    const result = buildGtfsRoutes(routes, trips, shapes);

    expect(result.map((route) => [route.id, route.mode])).toEqual([
      ['1', 'subway'], ['29', 'bus'], ['504', 'streetcar'],
    ]);
    expect(result.every((route) => route.paths?.includes(route.path))).toBe(true);
  });

  it('groups TTC light rail rapid transit lines with the subway network', () => {
    const result = buildGtfsRoutes([
      { route_id: '5', route_short_name: '5', route_long_name: 'Eglinton Line', route_type: '0', route_color: 'FF8000' },
      { route_id: '6', route_short_name: '6', route_long_name: 'Finch West Line', route_type: '0', route_color: '808080' },
      routes[1],
    ], [
      { trip_id: 'eglinton', route_id: '5', shape_id: 'rail' },
      { trip_id: 'finch-west', route_id: '6', shape_id: 'inbound' },
      trips[3],
    ], shapes);

    expect(result.map((route) => [route.id, route.mode])).toEqual([
      ['5', 'subway'], ['6', 'subway'], ['504', 'streetcar'],
    ]);
  });

  it('imports regional rail geometry instead of discarding GTFS route type 2', () => {
    const result = buildGtfsRoutes([
      { route_id: 'LW', route_short_name: 'LW', route_long_name: 'Lakeshore West', route_type: '2', route_color: '00853F' },
    ], [{ trip_id: 'go-trip', route_id: 'LW', shape_id: 'rail' }], shapes);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'LW', mode: 'rail', color: '#00853F' });
    expect(result[0].paths).toHaveLength(1);
  });

  it('namespaces GO and UP route, stop, and station IDs without breaking TTC live links', () => {
    const rawRoutes = buildGtfsRoutes([routes[2]], [trips[4]], shapes);
    const rawStops = [{
      id: '1', name: 'Platform', latitude: 43.65, longitude: -79.4,
      parentStation: 'parent', routeIds: ['1'],
    }];
    const networks = (['ttc', 'go', 'up'] as const).map((agency) =>
      identifyGtfsNetwork(rawRoutes, rawStops, agency)
    );

    expect(networks.map((network) => network.routes[0].id)).toEqual(['1', 'go:1', 'up:1']);
    expect(networks.map((network) => network.stops[0].id)).toEqual(['1', 'go:1', 'up:1']);
    expect(networks.map((network) => network.stops[0].parentStation)).toEqual(['parent', 'go:parent', 'up:parent']);
    for (const network of networks) {
      expect(network.stops[0].routeIds).toEqual([network.routes[0].id]);
      expect(network.routes[0].gtfsRouteId).toBe('1');
      expect(network.routes[0].scheduledTrips).toBe(1);
    }
  });

  it('reduces redundant collinear points while preserving exact endpoints', () => {
    const detailed = Array.from({ length: 500 }, (_, index) => ({
      shape_id: 'outbound', shape_pt_sequence: String(index),
      shape_pt_lon: String(-79.41 + index / 100000), shape_pt_lat: '43.65',
    }));
    const result = buildGtfsRoutes([routes[0]], [trips[0]], detailed);

    expect(result[0].paths?.[0]).toHaveLength(2);
    expect(result[0].paths?.[0]?.[0]).toEqual([-79.41, 43.65]);
    expect(result[0].paths?.[0]?.at(-1)).toEqual([-79.41 + 499 / 100000, 43.65]);
  });

  it('preserves a sharp route turn instead of skipping over it', () => {
    const bentShape = [
      { shape_id: 'outbound', shape_pt_sequence: '1', shape_pt_lon: '-79.4', shape_pt_lat: '43.65' },
      { shape_id: 'outbound', shape_pt_sequence: '2', shape_pt_lon: '-79.4', shape_pt_lat: '43.66' },
      { shape_id: 'outbound', shape_pt_sequence: '3', shape_pt_lon: '-79.39', shape_pt_lat: '43.66' },
    ];
    const result = buildGtfsRoutes([routes[0]], [trips[0]], bentShape);

    expect(result[0].paths?.[0]).toEqual([[-79.4, 43.65], [-79.4, 43.66], [-79.39, 43.66]]);
  });

  it('fails validation rather than publishing missing or invalid geometry', () => {
    expect(() => buildGtfsRoutes(routes, trips, [])).toThrow('Missing usable GTFS shape');
    expect(() => buildGtfsRoutes(routes, trips, [{ ...shapes[0], shape_pt_lon: '' }])).toThrow('Invalid GTFS shape point');
  });

  it('links platforms and parent stations to their routes, excluding entrances and unrelated stops', async () => {
    const input = Readable.from([
      'trip_id,stop_id\nbus-out,shared\nbus-again,shared\nstreetcar,shared\nsubway,rail-platform\nmissing,orphan\n',
    ]);
    const links = await readGtfsStopRouteIds(input, trips, new Set(['29', '504', '1']));
    const stops: GtfsRecord[] = [
      { stop_id: 'shared', stop_name: 'Shared stop', stop_lon: '-79.4', stop_lat: '43.65' },
      { stop_id: 'rail-platform', stop_name: 'Rail platform', stop_lon: '-79.4', stop_lat: '43.66', parent_station: 'station', location_type: '0' },
      { stop_id: 'station', stop_name: 'Station', stop_lon: '-79.4', stop_lat: '43.66', location_type: '1' },
      { stop_id: 'entrance', stop_name: 'Entrance', stop_lon: '-79.4', stop_lat: '43.66', parent_station: 'station', location_type: '2' },
      { stop_id: 'orphan', stop_name: 'Unserved stop', stop_lon: '-79.4', stop_lat: '43.66' },
    ];
    const result = buildGtfsStops(stops, links);

    expect(result.map((stop) => stop.id)).toEqual(['shared', 'rail-platform', 'station']);
    expect(result[0].routeIds).toEqual(['29', '504']);
    expect(result[1].routeIds).toEqual(['1']);
    expect(result[2].routeIds).toEqual(['1']);
  });
});
