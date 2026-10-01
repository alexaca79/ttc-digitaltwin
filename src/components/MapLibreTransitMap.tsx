import { useEffect, useRef, useState } from 'react';
import type { FeatureCollection, LineString, Point } from 'geojson';
import {
  Map as MapLibreMap,
  LngLatBounds,
  NavigationControl,
  setWorkerUrl,
  type ErrorEvent as MapLibreErrorEvent,
  type GeoJSONSource,
  type MapLayerMouseEvent,
  type MapMouseEvent,
  type StyleSpecification,
} from 'maplibre-gl';
import mapLibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

import { isTrunkRoute, routePaintTier } from '@/components/routePaintOrder';
import type {
  TransitRoute,
  TransitStop,
  VehicleTelemetry,
} from '@/types/transit';

import 'maplibre-gl/dist/maplibre-gl.css';

interface MapLibreTransitMapProps {
  vehicles: VehicleTelemetry[];
  visibleRoutes: TransitRoute[];
  stops: TransitStop[];
  selectedVehicleId: string | null;
  focusedRouteId?: string | null;
  onVehicleSelect: (vehicleId: string | null) => void;
  onUnavailable: (message: string) => void;
}

interface RouteProperties {
  color: string;
  routeId: string;
  focused: boolean;
  raised: boolean;
  tier: number;
  casingWidth: number;
  lineWidth: number;
}

interface StopProperties {
  id: string;
  name: string;
}

interface VehicleProperties {
  color: string;
  id: string;
  label: string;
  routeId: string;
  selected: boolean;
}

const vectorTileJsonUrl =
  import.meta.env.VITE_3D_TILEJSON_URL ??
  'https://tiles.openfreemap.org/planet';

setWorkerUrl(mapLibreWorkerUrl);

function emptyFeatureCollection<
  Geometry extends LineString | Point,
  Properties,
>(): FeatureCollection<Geometry, Properties> {
  return { type: 'FeatureCollection', features: [] };
}

function vehicleColor(state: VehicleTelemetry['state']) {
  if (state === 'delayed') return '#d71920';
  if (state === 'early') return '#147d64';
  if (state === 'unknown') return '#86857f';
  return '#151515';
}

function routeWidths(focused: boolean, trunk: boolean) {
  if (!focused) return { casingWidth: 3, lineWidth: 1.5 };
  return trunk ? { casingWidth: 11, lineWidth: 6.5 } : { casingWidth: 8, lineWidth: 4.5 };
}

// Raised routes repeat the casing and line pair above all other routes, so
// their white casing separates them from the surface network beneath.
function routeLayers(raised: boolean): StyleSpecification['layers'] {
  const prefix = raised ? 'raised-' : '';
  return [
    {
      id: `${prefix}route-casing`,
      type: 'line',
      source: 'ttc-routes',
      filter: ['==', ['get', 'raised'], raised],
      layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'tier'] },
      paint: {
        'line-color': '#ffffff',
        'line-opacity': ['case', ['get', 'focused'], 0.88, 0.15],
        'line-width': ['get', 'casingWidth'],
      },
    },
    {
      id: `${prefix}routes`,
      type: 'line',
      source: 'ttc-routes',
      filter: ['==', ['get', 'raised'], raised],
      layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'tier'] },
      paint: {
        'line-color': ['get', 'color'],
        'line-opacity': ['case', ['get', 'focused'], 0.96, 0.2],
        'line-width': ['get', 'lineWidth'],
      },
    },
  ];
}

function createMapStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {
      openfreemap: {
        type: 'vector',
        url: vectorTileJsonUrl,
        attribution:
          '<a href="https://openfreemap.org">OpenFreeMap</a> · ' +
          '<a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      },
      'ttc-routes': {
        type: 'geojson',
        data: emptyFeatureCollection<LineString, RouteProperties>(),
      },
      'ttc-stops': {
        type: 'geojson',
        data: emptyFeatureCollection<Point, StopProperties>(),
      },
      'ttc-vehicles': {
        type: 'geojson',
        data: emptyFeatureCollection<Point, VehicleProperties>(),
      },
    },
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: { 'background-color': '#e8e7e1' },
      },
      {
        id: 'landcover',
        type: 'fill',
        source: 'openfreemap',
        'source-layer': 'landcover',
        paint: { 'fill-color': '#dce3d8', 'fill-opacity': 0.72 },
      },
      {
        id: 'parks',
        type: 'fill',
        source: 'openfreemap',
        'source-layer': 'park',
        paint: { 'fill-color': '#cdddc8', 'fill-opacity': 0.86 },
      },
      {
        id: 'water',
        type: 'fill',
        source: 'openfreemap',
        'source-layer': 'water',
        paint: { 'fill-color': '#a8cbd3' },
      },
      {
        id: 'boundaries',
        type: 'line',
        source: 'openfreemap',
        'source-layer': 'boundary',
        paint: {
          'line-color': '#9c9b95',
          'line-dasharray': [2, 2],
          'line-opacity': 0.45,
          'line-width': 0.8,
        },
      },
      {
        id: 'road-casing',
        type: 'line',
        source: 'openfreemap',
        'source-layer': 'transportation',
        minzoom: 7,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#c5c2ba',
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            7,
            0.6,
            16,
            8,
          ],
        },
      },
      {
        id: 'roads',
        type: 'line',
        source: 'openfreemap',
        'source-layer': 'transportation',
        minzoom: 7,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#f8f7f3',
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            7,
            0.3,
            16,
            5.5,
          ],
        },
      },
      {
        id: 'buildings',
        type: 'fill-extrusion',
        source: 'openfreemap',
        'source-layer': 'building',
        minzoom: 13,
        filter: ['!=', ['get', 'hide_3d'], true],
        paint: {
          'fill-extrusion-base': [
            'coalesce',
            ['get', 'render_min_height'],
            0,
          ],
          'fill-extrusion-color': '#b8b4aa',
          'fill-extrusion-height': [
            'coalesce',
            ['get', 'render_height'],
            6,
          ],
          'fill-extrusion-opacity': 0.84,
          'fill-extrusion-vertical-gradient': true,
        },
      },
      ...routeLayers(false),
      ...routeLayers(true),
      {
        id: 'stops',
        type: 'circle',
        source: 'ttc-stops',
        minzoom: 13,
        paint: {
          'circle-color': '#fbfbf9',
          'circle-radius': 3,
          'circle-stroke-color': '#242422',
          'circle-stroke-width': 1,
        },
      },
      {
        id: 'vehicles',
        type: 'circle',
        source: 'ttc-vehicles',
        paint: {
          'circle-color': ['get', 'color'],
          'circle-pitch-alignment': 'viewport',
          'circle-radius': [
            'case',
            ['boolean', ['get', 'selected'], false],
            9,
            6,
          ],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': [
            'case',
            ['boolean', ['get', 'selected'], false],
            3,
            2,
          ],
        },
      },
    ],
  };
}

function routeData(
  routes: TransitRoute[],
  focusedRouteId?: string | null
): FeatureCollection<LineString, RouteProperties> {
  return {
    type: 'FeatureCollection',
    features: routes.flatMap((route) => {
      const focused = !focusedRouteId || route.id === focusedRouteId;
      const trunk = isTrunkRoute(route);
      const properties: RouteProperties = {
        color: route.color,
        routeId: route.id,
        focused,
        raised: focusedRouteId ? route.id === focusedRouteId : trunk,
        tier: routePaintTier(route, focusedRouteId),
        ...routeWidths(focused, trunk),
      };
      return (route.paths ?? [route.path])
        .filter((path) => path.length >= 2)
        .map((path) => ({
          type: 'Feature' as const,
          geometry: { type: 'LineString' as const, coordinates: path },
          properties,
        }));
    }),
  };
}

function stopData(
  stops: TransitStop[]
): FeatureCollection<Point, StopProperties> {
  return {
    type: 'FeatureCollection',
    features: stops.map((stop) => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [stop.longitude, stop.latitude],
      },
      properties: { id: stop.id, name: stop.name },
    })),
  };
}

function vehicleData(
  vehicles: VehicleTelemetry[],
  selectedVehicleId: string | null
): FeatureCollection<Point, VehicleProperties> {
  return {
    type: 'FeatureCollection',
    features: vehicles.map((vehicle) => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [vehicle.longitude, vehicle.latitude],
      },
      properties: {
        color: vehicleColor(vehicle.state),
        id: vehicle.id,
        label: vehicle.label,
        routeId: vehicle.routeId,
        selected: vehicle.id === selectedVehicleId,
      },
    })),
  };
}

export function MapLibreTransitMap({
  vehicles,
  visibleRoutes,
  stops,
  selectedVehicleId,
  focusedRouteId,
  onVehicleSelect,
  onUnavailable,
}: MapLibreTransitMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const selectHandlerRef = useRef(onVehicleSelect);
  const unavailableHandlerRef = useRef(onUnavailable);
  const [mapReady, setMapReady] = useState(false);
  const [mapWarning, setMapWarning] = useState<string | null>(null);

  selectHandlerRef.current = onVehicleSelect;
  unavailableHandlerRef.current = onUnavailable;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return undefined;
    const capabilityCanvas = document.createElement('canvas');
    if (!capabilityCanvas.getContext('webgl2')) {
      unavailableHandlerRef.current(
        '3D view requires WebGL 2. The map returned to the 2D view.'
      );
      return undefined;
    }

    let map: MapLibreMap;
    try {
      map = new MapLibreMap({
        container: containerRef.current,
        center: [-79.55, 43.74],
        zoom: 10.4,
        pitch: 58,
        bearing: -17,
        minZoom: 7,
        maxZoom: 19,
        maxPitch: 72,
        attributionControl: {
          compact: true,
          customAttribution: 'TTC / Metrolinx GTFS',
        },
        canvasContextAttributes: {
          antialias: true,
          contextType: 'webgl2',
        },
      });
    } catch {
      unavailableHandlerRef.current(
        '3D view could not initialize. The map returned to the 2D view.'
      );
      return undefined;
    }

    mapRef.current = map;
    map.addControl(
      new NavigationControl({ showCompass: true, showZoom: true }),
      'bottom-right'
    );

    const handleStyleLoad = () => {
      setMapReady(true);
      setMapWarning(null);
    };
    const handleError = (event: MapLibreErrorEvent) => {
      setMapWarning(
        `3D basemap issue: ${event.error.message}. TTC overlays remain active.`
      );
    };
    const handleVehicleClick = (event: MapLayerMouseEvent) => {
      const vehicleId = event.features?.[0]?.properties?.id;
      if (typeof vehicleId === 'string') {
        selectHandlerRef.current(vehicleId);
      }
    };
    const handleMapClick = (event: MapMouseEvent) => {
      const vehiclesAtPoint = map.queryRenderedFeatures(event.point, {
        layers: ['vehicles'],
      });
      if (vehiclesAtPoint.length === 0) selectHandlerRef.current(null);
    };
    const showVehicleCursor = () => {
      map.getCanvas().style.cursor = 'pointer';
    };
    const clearVehicleCursor = () => {
      map.getCanvas().style.cursor = '';
    };

    map.on('style.load', handleStyleLoad);
    map.on('error', handleError);
    map.on('click', handleMapClick);
    map.on('click', 'vehicles', handleVehicleClick);
    map.on('mouseenter', 'vehicles', showVehicleCursor);
    map.on('mouseleave', 'vehicles', clearVehicleCursor);
    map.setStyle(createMapStyle());
    if (map.isStyleLoaded()) handleStyleLoad();

    const resizeObserver = new ResizeObserver(() => map.resize());
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      map.off('style.load', handleStyleLoad);
      map.off('error', handleError);
      map.off('click', handleMapClick);
      map.off('click', 'vehicles', handleVehicleClick);
      map.off('mouseenter', 'vehicles', showVehicleCursor);
      map.off('mouseleave', 'vehicles', clearVehicleCursor);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    void (map.getSource('ttc-routes') as GeoJSONSource).setData(
      routeData(visibleRoutes, focusedRouteId)
    );
  }, [focusedRouteId, mapReady, visibleRoutes]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    void (map.getSource('ttc-stops') as GeoJSONSource).setData(stopData(stops));
  }, [mapReady, stops]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    void (map.getSource('ttc-vehicles') as GeoJSONSource).setData(
      vehicleData(vehicles, selectedVehicleId)
    );
  }, [mapReady, selectedVehicleId, vehicles]);

  useEffect(() => {
    const map = mapRef.current;
    const vehicle = vehicles.find(
      (candidate) => candidate.id === selectedVehicleId
    );
    if (!mapReady || !map || !vehicle) return;
    map.flyTo({
      center: [vehicle.longitude, vehicle.latitude],
      zoom: Math.max(map.getZoom(), 14.5),
      pitch: 62,
      duration: 850,
    });
  }, [mapReady, selectedVehicleId, vehicles]);

  useEffect(() => {
    const map = mapRef.current;
    const route = visibleRoutes.find((candidate) => candidate.id === focusedRouteId);
    if (!mapReady || !map || !route) return;
    const bounds = new LngLatBounds();
    for (const path of route.paths ?? [route.path]) {
      for (const coordinate of path) bounds.extend(coordinate);
    }
    if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 65, maxZoom: 13, pitch: 45, duration: 650 });
  }, [focusedRouteId, mapReady, visibleRoutes]);

  return (
    <div
      className="transit-map-shell maplibre-map-shell"
      data-map-ready={mapReady}
      data-route-count={visibleRoutes.length}
      data-route-path-count={visibleRoutes.reduce((count, route) => count + (route.paths?.length ?? 1), 0)}
      data-stop-count={stops.length}
      data-focused-route={focusedRouteId ?? ''}
      aria-busy={!mapReady}
    >
      <div
        ref={containerRef}
        className="transit-map"
        aria-label="GTA three-dimensional transit map"
      />
      {!mapReady && <div className="map-loading">Loading 3D scene...</div>}
      {mapWarning && <div className="map-warning">{mapWarning}</div>}
    </div>
  );
}