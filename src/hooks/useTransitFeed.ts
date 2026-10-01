import { useCallback, useEffect, useRef, useState } from 'react';

import { createSimulatedAlerts, createSimulatedVehicles } from '@/data/demoNetwork';
import type { ServiceAlert, TransitSnapshot, VehicleTelemetry } from '@/types/transit';

type ConnectionState = 'connecting' | 'connected' | 'degraded' | 'stale' | 'simulated';

const REQUEST_TIMEOUT_MS = 10_000;
const STALE_AFTER_MS = 120_000;

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isVehicle(value: unknown): value is VehicleTelemetry {
  if (value == null || typeof value !== 'object') return false;
  const vehicle = value as VehicleTelemetry;
  return typeof vehicle.id === 'string' && vehicle.id.trim() !== '' &&
    [vehicle.routeId, vehicle.tripId, vehicle.label].every((field) => typeof field === 'string') &&
    ['bus', 'streetcar', 'subway'].includes(vehicle.mode) &&
    ['low', 'medium', 'high', 'unknown'].includes(vehicle.occupancy) &&
    ['on-time', 'delayed', 'early', 'unknown'].includes(vehicle.state) &&
    [vehicle.latitude, vehicle.longitude, vehicle.bearing, vehicle.speedKph].every(Number.isFinite) &&
    Math.abs(vehicle.latitude) <= 90 && Math.abs(vehicle.longitude) <= 180 &&
    (vehicle.scheduleDeviationSeconds === null || Number.isFinite(vehicle.scheduleDeviationSeconds)) &&
    isTimestamp(vehicle.observedAt);
}

function isAlert(value: unknown): value is ServiceAlert {
  if (value == null || typeof value !== 'object') return false;
  const alert = value as ServiceAlert;
  return typeof alert.id === 'string' && alert.id.trim() !== '' &&
    [alert.title, alert.description].every((field) => typeof field === 'string') &&
    ['info', 'warning', 'critical'].includes(alert.severity) &&
    Array.isArray(alert.routeIds) && alert.routeIds.every((route) => typeof route === 'string') &&
    isTimestamp(alert.updatedAt);
}

function simulatedSnapshot(now = new Date()): TransitSnapshot {
  return {
    source: 'simulated',
    observedAt: now.toISOString(),
    vehicles: createSimulatedVehicles(now),
    alerts: createSimulatedAlerts(now),
  };
}

async function requestSnapshotFrom(
  baseUrl: string,
  path: string,
  signal: AbortSignal
): Promise<TransitSnapshot> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  const timeout = window.setTimeout(
    () => controller.abort(new Error('Telemetry request timed out.')),
    REQUEST_TIMEOUT_MS
  );

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`Telemetry API returned ${response.status}.`);
    const snapshot = (await response.json()) as TransitSnapshot | null;
    controller.signal.throwIfAborted();
    if (
      snapshot?.source !== 'ttc-gtfs-rt' ||
      !isTimestamp(snapshot.observedAt) ||
      Date.parse(snapshot.observedAt) > Date.now() + 60_000 ||
      !Array.isArray(snapshot.vehicles) || !snapshot.vehicles.every(isVehicle) ||
      !Array.isArray(snapshot.alerts) || !snapshot.alerts.every(isAlert) ||
      new Set(snapshot.vehicles.map((vehicle) => vehicle.id)).size !== snapshot.vehicles.length ||
      new Set(snapshot.alerts.map((alert) => alert.id)).size !== snapshot.alerts.length
    ) {
      throw new Error('Telemetry API returned an invalid snapshot.');
    }
    return snapshot;
  } finally {
    window.clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}

async function requestLiveSnapshot(baseUrl: string, signal: AbortSignal): Promise<TransitSnapshot> {
  try {
    return await requestSnapshotFrom(baseUrl, '/api/snapshot', signal);
  } catch (caught) {
    if (signal.aborted) throw caught;
    return requestSnapshotFrom(baseUrl, '/api/live', signal);
  }
}

export function useTransitFeed() {
  const telemetryApiUrl = import.meta.env.VITE_TELEMETRY_API_URL?.trim().replace(/\/$/, '');
  const liveProviderAvailable = Boolean(telemetryApiUrl);
  const [snapshot, setSnapshot] = useState<TransitSnapshot>(() =>
    liveProviderAvailable
      ? { source: 'ttc-gtfs-rt', observedAt: '', vehicles: [], alerts: [] }
      : simulatedSnapshot()
  );
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(Date.now);
  const activeRequest = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (!telemetryApiUrl) {
      setSnapshot(simulatedSnapshot());
      return;
    }
    if (activeRequest.current && !activeRequest.current.signal.aborted) return;

    const controller = new AbortController();
    activeRequest.current = controller;
    setRefreshing(true);
    try {
      const nextSnapshot = await requestLiveSnapshot(telemetryApiUrl, controller.signal);
      if (controller.signal.aborted) return;
      setSnapshot(nextSnapshot);
      setNow(Date.now());
      setError(null);
    } catch (caught) {
      if (controller.signal.aborted) return;
      setError(caught instanceof Error ? caught.message : 'Live feed unavailable.');
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        setRefreshing(false);
      }
    }
  }, [telemetryApiUrl]);

  useEffect(() => {
    let interval: number | undefined;
    if (!paused) {
      void refresh();
      interval = window.setInterval(
        () => void refresh(),
        liveProviderAvailable ? 15_000 : 2_000
      );
    }
    return () => {
      activeRequest.current?.abort();
      window.clearInterval(interval);
    };
  }, [liveProviderAvailable, paused, refresh]);

  useEffect(() => {
    if (!liveProviderAvailable) return undefined;
    const interval = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(interval);
  }, [liveProviderAvailable]);

  const hasSnapshot = isTimestamp(snapshot.observedAt);
  const observationAgeSeconds = hasSnapshot
    ? Math.max(0, Math.floor((now - Date.parse(snapshot.observedAt)) / 1000))
    : null;
  const isStale = liveProviderAvailable && observationAgeSeconds !== null &&
    observationAgeSeconds * 1000 >= STALE_AFTER_MS;
  const connectionState: ConnectionState = !liveProviderAvailable
    ? 'simulated'
    : error
      ? 'degraded'
      : !hasSnapshot
        ? 'connecting'
        : isStale ? 'stale' : 'connected';

  return {
    snapshot,
    connectionState,
    hasSnapshot,
    observationAgeSeconds,
    isStale,
    refreshing,
    paused,
    error,
    liveConfigured: liveProviderAvailable,
    setPaused,
    refresh,
  };
}