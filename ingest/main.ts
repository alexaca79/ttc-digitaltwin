import type { Server } from 'node:http';

import { loadConfig } from './config.js';
import { createEventSink } from './eventSink.js';
import { openGtfsScheduleLookup, type GtfsScheduleLookup } from './gtfsSchedule.js';
import { startSnapshotServer, type PublisherState } from './snapshotServer.js';
import { pollTtcFeeds } from './ttcGtfsRt.js';

const config = loadConfig();
const sink = createEventSink(config.eventstream);
const runOnce = process.argv.includes('--once');
const state: PublisherState = {
  snapshot: null,
  lastPollStartedAt: null,
  lastPollSucceededAt: null,
  lastPublishSucceededAt: null,
  lastError: null,
  eventstreamEnabled: Boolean(config.eventstream),
};
let server: Server | null = null;
let scheduleLookup: GtfsScheduleLookup | null = null;
let polling = false;

async function poll() {
  if (polling) return;
  polling = true;
  state.lastPollStartedAt = new Date().toISOString();
  try {
    const result = await pollTtcFeeds(config.feedBaseUrl, scheduleLookup);
    state.snapshot = result.snapshot;
    state.lastPollSucceededAt = new Date().toISOString();
    await sink.publish(result.events);
    state.lastPublishSucceededAt = new Date().toISOString();
    state.lastError = null;
    console.log(
      `[${state.lastPollSucceededAt}] ${result.snapshot.vehicles.length} vehicles, ` +
        `${result.snapshot.alerts.length} alerts, ${result.events.length} events` +
        `${config.eventstream ? ' published to Fabric Eventstream' : ' normalized locally'}.`
    );
    if (config.logEvents) {
      for (const event of result.events) console.log(JSON.stringify(event));
    }
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
    console.error(`[${new Date().toISOString()}] TTC poll failed: ${state.lastError}`);
    if (runOnce) throw error;
  } finally {
    polling = false;
  }
}

async function shutdown() {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  await sink.close();
  scheduleLookup?.close();
  scheduleLookup = null;
}

async function main() {
  scheduleLookup = await openGtfsScheduleLookup(config.staticGtfsDirectory);
  if (!scheduleLookup) {
    console.warn(
      `Static TTC schedule not found in ${config.staticGtfsDirectory}; schedule adherence will be unavailable.`
    );
  }
  await poll();
  if (runOnce) {
    await shutdown();
    return;
  }

  server = await startSnapshotServer(config.port, config.allowedOrigin, () => state);
  console.log(`Snapshot API listening at http://127.0.0.1:${config.port}/api/snapshot`);
  const interval = setInterval(() => void poll(), config.pollIntervalMs);

  const stop = () => {
    clearInterval(interval);
    void shutdown().finally(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch(async (error: unknown) => {
  console.error(error);
  await shutdown();
  process.exitCode = 1;
});