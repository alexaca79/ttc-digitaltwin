import { useEffect, useRef, useState } from 'react';
import * as L from 'leaflet';
import type { CircleMarker, LayerGroup, Map as LeafletMap } from 'leaflet';

import type { TransitRoute, TransitStop, VehicleTelemetry } from '@/types/transit';

import 'leaflet/dist/leaflet.css';

interface TransitMapProps {
  vehicles: VehicleTelemetry[];
  visibleRoutes: TransitRoute[];
  stops: TransitStop[];
  selectedVehicleId: string | null;
  onVehicleSelect: (vehicleId: string | null) => void;
}

const tileUrl =
  import.meta.env.VITE_MAP_TILE_URL ??
  'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

function vehicleColor(state: VehicleTelemetry['state']) {
  if (state === 'delayed') return '#d71920';
  if (state === 'early') return '#147d64';
  if (state === 'unknown') return '#86857f';
  return '#151515';
}

export function TransitMap({
  vehicles,
  visibleRoutes,
  stops,
  selectedVehicleId,
  onVehicleSelect,
}: TransitMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const routeLayerRef = useRef<LayerGroup | null>(null);
  const stopLayerRef = useRef<LayerGroup | null>(null);
  const vehicleLayerRef = useRef<LayerGroup | null>(null);
  const vehicleMarkersRef = useRef(new Map<string, CircleMarker>());
  const latestStopsRef = useRef(stops);
  const renderStopsRef = useRef<() => void>(() => undefined);
  const selectHandlerRef = useRef(onVehicleSelect);
  const [mapWarning, setMapWarning] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState(false);

  selectHandlerRef.current = onVehicleSelect;
  latestStopsRef.current = stops;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return undefined;
    const vehicleMarkers = vehicleMarkersRef.current;

    const map = L.map(containerRef.current, {
      center: [43.674, -79.392],
      zoom: 11,
      minZoom: 9,
      maxZoom: 19,
      zoomControl: false,
      attributionControl: true,
      preferCanvas: true,
    });
    mapRef.current = map;
    const clearSelection = () => selectHandlerRef.current(null);
    map.on('click', clearSelection);
    map.attributionControl.setPrefix(false);
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    const routesPane = map.createPane('ttc-routes-pane');
    routesPane.style.zIndex = '410';
    routesPane.style.pointerEvents = 'none';
    const stopsPane = map.createPane('ttc-stops-pane');
    stopsPane.style.zIndex = '420';
    const vehiclesPane = map.createPane('ttc-vehicles-pane');
    vehiclesPane.style.zIndex = '430';

    let tileErrorCount = 0;
    const tiles = L.tileLayer(tileUrl, {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · TTC Open Data',
      maxZoom: 19,
      updateWhenIdle: true,
      keepBuffer: 2,
    });
    tiles.on('tileerror', () => {
      tileErrorCount += 1;
      if (tileErrorCount === 6) {
        setMapWarning(
          'Basemap tiles are unavailable; live TTC overlays remain active.'
        );
      }
    });
    tiles.on('load', () => {
      tileErrorCount = 0;
      setMapWarning(null);
    });
    tiles.addTo(map);

    const routes = L.layerGroup().addTo(map);
    const stopsLayer = L.layerGroup();
    const vehiclesLayer = L.layerGroup().addTo(map);
    routeLayerRef.current = routes;
    stopLayerRef.current = stopsLayer;
    vehicleLayerRef.current = vehiclesLayer;

    const renderVisibleStops = () => {
      stopsLayer.clearLayers();
      if (map.getZoom() < 13) {
        if (map.hasLayer(stopsLayer)) map.removeLayer(stopsLayer);
        return;
      }

      if (!map.hasLayer(stopsLayer)) stopsLayer.addTo(map);
      const visibleBounds = map.getBounds().pad(0.15);
      for (const stop of latestStopsRef.current) {
        const position = L.latLng(stop.latitude, stop.longitude);
        if (!visibleBounds.contains(position)) continue;

        const marker = L.circleMarker(position, {
          pane: 'ttc-stops-pane',
          radius: 3,
          color: '#242422',
          weight: 1,
          fillColor: '#fbfbf9',
          fillOpacity: 0.94,
        });
        marker.on('click', () => {
          const content = document.createElement('span');
          content.textContent = `${stop.name} · Stop ${stop.id}`;
          L.popup({ closeButton: false, offset: [0, -3] })
            .setLatLng(marker.getLatLng())
            .setContent(content)
            .openOn(map);
        });
        marker.addTo(stopsLayer);
      }
    };
    renderStopsRef.current = renderVisibleStops;
    map.on('zoomend moveend', renderVisibleStops);
    renderVisibleStops();

    const resizeObserver = new ResizeObserver(() => {
      map.invalidateSize(false);
      renderVisibleStops();
    });
    resizeObserver.observe(containerRef.current);
    setMapReady(true);
    requestAnimationFrame(() => {
      if (mapRef.current === map) map.invalidateSize(false);
    });

    return () => {
      resizeObserver.disconnect();
      renderStopsRef.current = () => undefined;
      map.off('click', clearSelection);
      map.off('zoomend moveend', renderVisibleStops);
      vehicleMarkers.clear();
      routeLayerRef.current = null;
      stopLayerRef.current = null;
      vehicleLayerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    renderStopsRef.current();
  }, [stops]);

  useEffect(() => {
    const routes = routeLayerRef.current;
    if (!routes) return;

    routes.clearLayers();
    for (const route of visibleRoutes) {
      if (route.path.length < 2) continue;
      const points = route.path.map(([longitude, latitude]) =>
        L.latLng(latitude, longitude)
      );
      L.polyline(points, {
        pane: 'ttc-routes-pane',
        color: '#ffffff',
        weight: 7,
        opacity: 0.82,
        lineCap: 'round',
        lineJoin: 'round',
        interactive: false,
      }).addTo(routes);
      L.polyline(points, {
        pane: 'ttc-routes-pane',
        color: route.color,
        weight: 4,
        opacity: 0.94,
        lineCap: 'round',
        lineJoin: 'round',
        interactive: false,
      }).addTo(routes);
    }
  }, [visibleRoutes]);

  useEffect(() => {
    const vehicleLayer = vehicleLayerRef.current;
    if (!vehicleLayer) return;

    const seen = new Set<string>();
    for (const vehicle of vehicles) {
      seen.add(vehicle.id);
      const selected = vehicle.id === selectedVehicleId;
      const style = {
        radius: selected ? 9 : 6,
        color: '#ffffff',
        weight: 2,
        fillColor: vehicleColor(vehicle.state),
        fillOpacity: 0.98,
      };
      let marker = vehicleMarkersRef.current.get(vehicle.id);
      if (marker) {
        marker.setLatLng([vehicle.latitude, vehicle.longitude]);
        marker.setRadius(style.radius);
        marker.setStyle(style);
      } else {
        marker = L.circleMarker([vehicle.latitude, vehicle.longitude], {
          pane: 'ttc-vehicles-pane',
          bubblingMouseEvents: false,
          ...style,
        });
        marker.on('click', () => selectHandlerRef.current(vehicle.id));
        marker.bindTooltip(`${vehicle.label} · ${vehicle.id}`, {
          direction: 'top',
          offset: [0, -7],
          opacity: 0.94,
        });
        marker.addTo(vehicleLayer);
        vehicleMarkersRef.current.set(vehicle.id, marker);
      }
      if (selected) marker.bringToFront();
    }

    for (const [vehicleId, marker] of vehicleMarkersRef.current) {
      if (seen.has(vehicleId)) continue;
      vehicleLayer.removeLayer(marker);
      vehicleMarkersRef.current.delete(vehicleId);
    }
  }, [selectedVehicleId, vehicles]);

  useEffect(() => {
    const vehicle = vehicles.find(
      (candidate) => candidate.id === selectedVehicleId
    );
    const map = mapRef.current;
    if (vehicle && map) {
      map.flyTo(
        [vehicle.latitude, vehicle.longitude],
        Math.max(map.getZoom(), 14),
        { duration: 0.85 }
      );
    }
  }, [selectedVehicleId, vehicles]);

  return (
    <div
      className="transit-map-shell"
      data-map-ready={mapReady}
      aria-busy={!mapReady}
    >
      <div
        ref={containerRef}
        className="transit-map"
        aria-label="Live TTC operations map"
      />
      {mapWarning && <div className="map-warning">{mapWarning}</div>}
    </div>
  );
}
