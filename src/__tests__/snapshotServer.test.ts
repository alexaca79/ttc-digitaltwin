import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import {
  startSnapshotServer,
  type PublisherState,
} from '../../ingest/snapshotServer.js';
import type { TransitSnapshot } from '@/types/transit';

const snapshot: TransitSnapshot = {
  source: 'ttc-gtfs-rt',
  observedAt: '2026-08-15T12:00:00.000Z',
  vehicles: [],
  alerts: [],
};

function publisherState(
  overrides: Partial<PublisherState> = {}
): PublisherState {
  return {
    snapshot: null,
    lastPollStartedAt: null,
    lastPollSucceededAt: null,
    lastPublishSucceededAt: null,
    lastError: null,
    eventstreamEnabled: true,
    ...overrides,
  };
}

describe('publisher readiness', () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  });

  async function requestReady(state: PublisherState) {
    server = await startSnapshotServer(0, 'https://example.test', () => state);
    const address = server.address() as AddressInfo;
    return fetch(`http://127.0.0.1:${address.port}/api/ready`);
  }

  it('stays unavailable until Fabric publishing succeeds', async () => {
    const response = await requestReady(
      publisherState({
        snapshot,
        lastPollSucceededAt: snapshot.observedAt,
      })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: 'not-ready',
      lastPublishSucceededAt: null,
      eventstreamEnabled: true,
    });
  });

  it('becomes ready after polling and publishing both succeed', async () => {
    const response = await requestReady(
      publisherState({
        snapshot,
        lastPollSucceededAt: snapshot.observedAt,
        lastPublishSucceededAt: snapshot.observedAt,
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'ready' });
  });

  it('rejects production readiness when Eventstream publishing is disabled', async () => {
    const response = await requestReady(
      publisherState({
        snapshot,
        lastPollSucceededAt: snapshot.observedAt,
        eventstreamEnabled: false,
      })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: 'not-ready',
      eventstreamEnabled: false,
    });
  });

  it('reports the Eventhouse query endpoint as unavailable when it is not configured', async () => {
    const state = publisherState({ snapshot });
    server = await startSnapshotServer(0, 'https://example.test', () => state);
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/live`);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Eventhouse query endpoint is not configured.',
    });
  });

  it('rejects route performance lookbacks outside the allow list', async () => {
    const state = publisherState({ snapshot });
    server = await startSnapshotServer(0, 'https://example.test', () => state, {
      queryUri: 'https://kusto.invalid',
      database: 'TTCOperations',
    });
    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/route-performance?lookback=1h)%20|%20take%201`
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'Unsupported lookback.' });
  });
});