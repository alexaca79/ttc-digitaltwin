export interface EventstreamConfig {
  brokers: string[];
  topic: string;
  username: string;
  password: string;
}

export interface KqlQueryConfig {
  queryUri: string;
  database: string;
}

export interface PublisherConfig {
  feedBaseUrl: string;
  staticGtfsDirectory: string;
  pollIntervalMs: number;
  port: number;
  allowedOrigin: string;
  logEvents: boolean;
  rawFeedMode: boolean;
  eventstream: EventstreamConfig | null;
  kql: KqlQueryConfig | null;
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(environment = process.env): PublisherConfig {
  const brokers = environment.FABRIC_EVENTSTREAM_BROKERS
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean) ?? [];
  const topic = environment.FABRIC_EVENTSTREAM_TOPIC?.trim() ?? '';
  const username = environment.FABRIC_EVENTSTREAM_USERNAME?.trim() ?? '';
  const password = environment.FABRIC_EVENTSTREAM_PASSWORD ?? '';
  const suppliedEventstreamFields = [brokers.length > 0, Boolean(topic), Boolean(username), Boolean(password)];
  const eventstreamConfigured = suppliedEventstreamFields.every(Boolean);

  if (!eventstreamConfigured && suppliedEventstreamFields.some(Boolean)) {
    throw new Error(
      'Fabric Eventstream configuration is incomplete. Set brokers, topic, username, and password together.'
    );
  }

  const kqlQueryUri = environment.FABRIC_KQL_QUERY_URI?.trim() ?? '';
  const kqlDatabase = environment.FABRIC_KQL_DATABASE?.trim() || 'TTCOperations';

  return {
    feedBaseUrl: (environment.TTC_GTFS_RT_BASE_URL ?? 'https://bustime.ttc.ca/gtfsrt').replace(/\/$/, ''),
    staticGtfsDirectory: environment.TTC_GTFS_STATIC_DIR ?? 'data/gtfs-static',
    pollIntervalMs: positiveInteger(environment.TTC_POLL_INTERVAL_MS, 15_000),
    port: positiveInteger(environment.PORT, 7071),
    allowedOrigin: environment.PUBLISHER_ALLOWED_ORIGIN ?? '*',
    logEvents: environment.PUBLISHER_LOG_EVENTS === 'true',
    rawFeedMode: environment.PUBLISHER_RAW_FEED_MODE === 'true',
    eventstream: eventstreamConfigured ? { brokers, topic, username, password } : null,
    kql: kqlQueryUri ? { queryUri: kqlQueryUri, database: kqlDatabase } : null,
  };
}