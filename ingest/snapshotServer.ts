import { createServer, type IncomingMessage, type Server } from 'node:http';

import type { TransitSnapshot } from '../src/types/transit.js';
import { fetchLiveSnapshot, fetchRoutePerformance, type KqlConfig } from './kqlClient.js';

export interface PublisherState {
  snapshot: TransitSnapshot | null;
  lastPollStartedAt: string | null;
  lastPollSucceededAt: string | null;
  lastPublishSucceededAt: string | null;
  lastError: string | null;
  eventstreamEnabled: boolean;
}

export interface SnapshotServerOptions {
  kql?: KqlConfig | null;
  /** Requests allowed per client each minute. Zero disables the limit. */
  requestsPerMinute?: number;
  /** Include dependency error text in /api/health. Off by default. */
  exposeErrorDetail?: boolean;
}

/** Allow-listed lookbacks keep caller input out of the KQL text. */
const ALLOWED_LOOKBACKS = new Set(['15m', '30m', '1h', '3h', '6h', '12h', '24h']);

const WINDOW_MS = 60_000;

function sendJson(response: import('node:http').ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

/**
 * Container Apps terminates ingress, so the left-most forwarded address is the
 * caller. It is spoofable in general, which is why this throttles abuse rather
 * than acting as an authorization control.
 */
function clientKey(request: IncomingMessage) {
  const forwarded = request.headers['x-forwarded-for'];
  const header = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = header?.split(',')[0]?.trim();
  return first || request.socket.remoteAddress || 'unknown';
}

export function createRateLimiter(requestsPerMinute: number) {
  const windows = new Map<string, { count: number; resetAt: number }>();

  return function consume(key: string, now = Date.now()) {
    if (requestsPerMinute <= 0) return { allowed: true, retryAfterSeconds: 0 };

    for (const [candidate, window] of windows) {
      if (window.resetAt <= now) windows.delete(candidate);
    }

    const existing = windows.get(key);
    if (!existing || existing.resetAt <= now) {
      windows.set(key, { count: 1, resetAt: now + WINDOW_MS });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    existing.count += 1;
    if (existing.count > requestsPerMinute) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
      };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  };
}

export function startSnapshotServer(
  port: number,
  allowedOrigin: string,
  getState: () => PublisherState,
  options: SnapshotServerOptions | KqlConfig | null = null
): Promise<Server> {
  const settings: SnapshotServerOptions =
    options && 'queryUri' in options ? { kql: options } : (options ?? {});
  const kql = settings.kql ?? null;
  const consume = createRateLimiter(settings.requestsPerMinute ?? 60);

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

    const throttle = consume(clientKey(request));
    if (!throttle.allowed) {
      response.setHeader('Retry-After', String(throttle.retryAfterSeconds));
      sendJson(response, 429, { error: 'Too many requests.' });
      return;
    }

    const url = new URL(request.url ?? '/', 'http://localhost');

    if (request.method === 'GET' && url.pathname === '/api/live') {
      if (!kql) {
        sendJson(response, 503, { error: 'Eventhouse query endpoint is not configured.' });
        return;
      }
      fetchLiveSnapshot(kql)
        .then((snapshot) => sendJson(response, 200, snapshot))
        .catch((error: unknown) => {
          sendJson(response, 503, {
            error: 'Eventhouse query failed.',
            detail: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/route-performance') {
      if (!kql) {
        sendJson(response, 503, { error: 'Eventhouse query endpoint is not configured.' });
        return;
      }
      const lookback = url.searchParams.get('lookback') ?? '30m';
      if (!ALLOWED_LOOKBACKS.has(lookback)) {
        sendJson(response, 400, {
          error: 'Unsupported lookback.',
          allowed: [...ALLOWED_LOOKBACKS],
        });
        return;
      }
      fetchRoutePerformance(kql, lookback)
        .then((rows) => sendJson(response, 200, { lookback, routes: rows }))
        .catch((error: unknown) => {
          sendJson(response, 503, {
            error: 'Eventhouse query failed.',
            detail: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/snapshot') {
      const state = getState();
      if (!state.snapshot) {
        sendJson(response, 503, { error: 'No TTC snapshot has been collected yet.' });
        return;
      }
      sendJson(response, 200, state.snapshot);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/health') {
      const state = getState();
      sendJson(response, state.lastError ? 503 : 200, {
        status: state.lastError ? 'degraded' : state.snapshot ? 'ready' : 'starting',
        lastPollStartedAt: state.lastPollStartedAt,
        lastPollSucceededAt: state.lastPollSucceededAt,
        lastPublishSucceededAt: state.lastPublishSucceededAt,
        eventstreamEnabled: state.eventstreamEnabled,
        kqlConfigured: Boolean(kql),
        // Dependency text can name internal hosts, so it stays opt-in.
        failing: Boolean(state.lastError),
        ...(settings.exposeErrorDetail ? { lastError: state.lastError } : {}),
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

    if (request.method === 'GET' && url.pathname === '/api/ready') {
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