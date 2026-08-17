import { createServer, type Server } from 'node:http';

import type { TransitSnapshot } from '../src/types/transit.js';

export interface PublisherState {
  snapshot: TransitSnapshot | null;
  lastPollStartedAt: string | null;
  lastPollSucceededAt: string | null;
  lastPublishSucceededAt: string | null;
  lastError: string | null;
  eventstreamEnabled: boolean;
}

function sendJson(response: import('node:http').ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

export function startSnapshotServer(
  port: number,
  allowedOrigin: string,
  getState: () => PublisherState
): Promise<Server> {
  const server = createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    response.setHeader('Cache-Control', 'no-store');

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method === 'GET' && request.url === '/api/snapshot') {
      const state = getState();
      if (!state.snapshot) {
        sendJson(response, 503, { error: 'No TTC snapshot has been collected yet.' });
        return;
      }
      sendJson(response, 200, state.snapshot);
      return;
    }

    if (request.method === 'GET' && request.url === '/api/health') {
      const state = getState();
      sendJson(response, state.lastError ? 503 : 200, {
        status: state.lastError ? 'degraded' : state.snapshot ? 'ready' : 'starting',
        ...state,
        snapshot: state.snapshot
          ? {
              observedAt: state.snapshot.observedAt,
              vehicles: state.snapshot.vehicles.length,
              alerts: state.snapshot.alerts.length,
            }
          : null,
      });
      return;
    }

    if (request.method === 'GET' && request.url === '/api/ready') {
      const state = getState();
      const ready = Boolean(
        state.snapshot &&
        state.lastPollSucceededAt &&
        !state.lastError &&
        state.eventstreamEnabled &&
        state.lastPublishSucceededAt
      );
      sendJson(response, ready ? 200 : 503, {
        status: ready ? 'ready' : 'not-ready',
        lastPollSucceededAt: state.lastPollSucceededAt,
        lastPublishSucceededAt: state.lastPublishSucceededAt,
        eventstreamEnabled: state.eventstreamEnabled,
      });
      return;
    }

    sendJson(response, 404, { error: 'Not found.' });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve(server));
  });
}