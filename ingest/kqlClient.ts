import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  ServiceAlert,
  TransitMode,
  TransitSnapshot,
  VehicleState,
  VehicleTelemetry,
} from '../src/types/transit.js';

const execFileAsync = promisify(execFile);
const KUSTO_RESOURCE = 'https://kusto.kusto.windows.net';
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface KqlConfig {
  queryUri: string;
  database: string;
}

interface KustoTable {
  TableName?: string;
  Columns?: Array<{ ColumnName?: string }>;
  Rows?: unknown[][];
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

let cachedToken: CachedToken | null = null;

async function requestManagedIdentityToken(): Promise<CachedToken | null> {
  const endpoint = process.env.IDENTITY_ENDPOINT;
  const header = process.env.IDENTITY_HEADER;
  if (!endpoint || !header) return null;

  const url = `${endpoint}?resource=${encodeURIComponent(KUSTO_RESOURCE)}&api-version=2019-08-01`;
  const response = await fetch(url, { headers: { 'X-IDENTITY-HEADER': header } });
  if (!response.ok) {
    throw new Error(`Managed identity token request failed (${response.status}).`);
  }
  const body = (await response.json()) as { access_token?: string; expires_on?: string };
  if (!body.access_token) throw new Error('Managed identity returned no access token.');
  const expiresOnSeconds = Number(body.expires_on);
  return {
    token: body.access_token,
    expiresAtMs: Number.isFinite(expiresOnSeconds)
      ? expiresOnSeconds * 1000
      : Date.now() + 45 * 60 * 1000,
  };
}

async function requestAzureCliToken(): Promise<CachedToken> {
  const { stdout } = await execFileAsync(
    process.platform === 'win32' ? 'az.cmd' : 'az',
    [
      'account',
      'get-access-token',
      '--resource',
      KUSTO_RESOURCE,
      '--query',
      '{token:accessToken,expiresOn:expires_on}',
      '--output',
      'json',
    ],
    { shell: process.platform === 'win32', maxBuffer: 10 * 1024 * 1024 }
  );
  const parsed = JSON.parse(stdout) as { token?: string; expiresOn?: number };
  if (!parsed.token) throw new Error('Azure CLI returned no Kusto access token.');
  return {
    token: parsed.token,
    expiresAtMs: parsed.expiresOn ? parsed.expiresOn * 1000 : Date.now() + 45 * 60 * 1000,
  };
}

async function getKustoToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAtMs - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
    return cachedToken.token;
  }
  cachedToken = (await requestManagedIdentityToken()) ?? (await requestAzureCliToken());
  return cachedToken.token;
}

function rowsToRecords(table: KustoTable | undefined): Array<Record<string, unknown>> {
  const columns = (table?.Columns ?? []).map((column) => column.ColumnName ?? '');
  return (table?.Rows ?? []).map((row) =>
    Object.fromEntries(columns.map((column, index) => [column, row[index]]))
  );
}

export async function runKqlQuery(
  config: KqlConfig,
  query: string
): Promise<Array<Record<string, unknown>>> {
  const token = await getKustoToken();
  const response = await fetch(`${config.queryUri.replace(/\/$/, '')}/v1/rest/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ db: config.database, csl: query }),
    signal: AbortSignal.timeout(30_000),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`KQL query failed (${response.status}): ${text.slice(0, 400)}`);
  }

  const body = JSON.parse(text) as { Tables?: KustoTable[] };
  const tables = body.Tables ?? [];
  const primary = tables.find((table) => table.TableName === 'Table_0') ?? tables[0];
  return rowsToRecords(primary);
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function numeric(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableNumeric(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function transitMode(value: unknown): TransitMode {
  return value === 'streetcar' || value === 'subway' ? value : 'bus';
}

function vehicleState(value: unknown): VehicleState {
  return value === 'on-time' || value === 'delayed' || value === 'early' ? value : 'unknown';
}

function occupancy(value: unknown): VehicleTelemetry['occupancy'] {
  return value === 'low' || value === 'medium' || value === 'high' ? value : 'unknown';
}

function severity(value: unknown): ServiceAlert['severity'] {
  return value === 'critical' || value === 'info' ? value : 'warning';
}

function routeIds(value: unknown): string[] {
  const raw = typeof value === 'string' ? safeParse(value) : value;
  return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : [];
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

function isoTimestamp(value: unknown, fallback: string): string {
  const parsed = new Date(String(value ?? ''));
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

export function mapFleetRows(rows: Array<Record<string, unknown>>): VehicleTelemetry[] {
  const observedFallback = new Date().toISOString();
  return rows.map((row) => ({
    id: text(row.VehicleId),
    routeId: text(row.RouteId),
    tripId: text(row.TripId),
    label: text(row.VehicleLabel, text(row.VehicleId)),
    mode: transitMode(row.Mode),
    latitude: numeric(row.Latitude),
    longitude: numeric(row.Longitude),
    bearing: numeric(row.Bearing),
    speedKph: numeric(row.SpeedKph),
    scheduleDeviationSeconds: nullableNumeric(row.ScheduleDeviationSeconds),
    occupancy: occupancy(row.Occupancy),
    state: vehicleState(row.State),
    observedAt: isoTimestamp(row.ObservedAt, observedFallback),
  }));
}

export function mapAlertRows(rows: Array<Record<string, unknown>>): ServiceAlert[] {
  const observedFallback = new Date().toISOString();
  return rows.map((row) => ({
    id: text(row.AlertId),
    severity: severity(row.Severity),
    title: text(row.Title, 'TTC service alert'),
    description: text(row.Description),
    routeIds: routeIds(row.RouteIds),
    updatedAt: isoTimestamp(row.ObservedAt, observedFallback),
  }));
}

const FLEET_QUERY = `CurrentFleet()
| project ObservedAt, VehicleId, VehicleLabel, TripId, RouteId, Mode, Latitude,
          Longitude, Bearing, SpeedKph, ScheduleDeviationSeconds, Occupancy, State`;

const ALERT_QUERY = `ActiveAlerts()
| project ObservedAt, AlertId, Severity, Title, Description, RouteIds`;

export async function fetchLiveSnapshot(config: KqlConfig): Promise<TransitSnapshot> {
  const [fleetRows, alertRows] = await Promise.all([
    runKqlQuery(config, FLEET_QUERY),
    runKqlQuery(config, ALERT_QUERY),
  ]);
  const vehicles = mapFleetRows(fleetRows);
  const newestObservation = vehicles
    .map((vehicle) => vehicle.observedAt)
    .sort()
    .at(-1);

  return {
    source: 'ttc-gtfs-rt',
    observedAt: newestObservation ?? new Date().toISOString(),
    vehicles,
    alerts: mapAlertRows(alertRows),
  };
}

export async function fetchRoutePerformance(config: KqlConfig, lookback: string) {
  return runKqlQuery(config, `RoutePerformance(${lookback})`);
}
