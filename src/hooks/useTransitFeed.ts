import { useCallback, useEffect, useState } from 'react';

import { createSimulatedAlerts, createSimulatedVehicles } from '@/data/demoNetwork';
import type { TransitSnapshot } from '@/types/transit';

type ConnectionState = 'connected' | 'degraded' | 'simulated';

const telemetryApiUrl = import.meta.env.VITE_TELEMETRY_API_URL?.replace(/\/$/, '');

function simulatedSnapshot(now = new Date()): TransitSnapshot {
  return {
    source: 'simulated',
    observedAt: now.toISOString(),
    vehicles: createSimulatedVehicles(now),
    alerts: createSimulatedAlerts(now),
  };
}

async function requestLiveSnapshot(signal: AbortSignal): Promise<TransitSnapshot> {
  if (!telemetryApiUrl) throw new Error('Live telemetry API is not configured.');
  const response = await fetch(`${telemetryApiUrl}/api/snapshot`, { signal });
  if (!response.ok) throw new Error(`Telemetry API returned ${response.status}.`);
  const snapshot = (await response.json()) as TransitSnapshot;
  if (!Array.isArray(snapshot.vehicles) || !Array.isArray(snapshot.alerts)) {
    throw new Error('Telemetry API returned an invalid snapshot.');
  }
  return snapshot;
}

export function useTransitFeed() {
  const liveProviderAvailable = Boolean(telemetryApiUrl);
  const [snapshot, setSnapshot] = useState<TransitSnapshot>(() => simulatedSnapshot());
  const [connectionState, setConnectionState] = useState<ConnectionState>(
    liveProviderAvailable ? 'degraded' : 'simulated'
  );
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!liveProviderAvailable) {
      setSnapshot(simulatedSnapshot());
      setConnectionState('simulated');
      return;
    }

    try {
      const nextSnapshot = await requestLiveSnapshot(signal ?? new AbortController().signal);
      setSnapshot(nextSnapshot);
      setConnectionState('connected');
      setError(null);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setSnapshot(simulatedSnapshot());
      setConnectionState('degraded');
      setError(caught instanceof Error ? caught.message : 'Live feed unavailable.');
    }
  }, [liveProviderAvailable]);

  useEffect(() => {
    if (paused) return undefined;
    const controller = new AbortController();
    void refresh(controller.signal);
    const interval = window.setInterval(
      () => void refresh(controller.signal),
      liveProviderAvailable ? 15_000 : 2_000
    );
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [liveProviderAvailable, paused, refresh]);

  return {
    snapshot,
    connectionState,
    paused,
    error,
    liveConfigured: liveProviderAvailable,
    setPaused,
    refresh: () => refresh(),
  };
}