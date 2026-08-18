import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertAzureContext,
  ensureFabricItem,
  fabricRequest,
  getAzureAccessToken,
  resolveWorkspaceId,
  updateFabricDefinition,
  waitForFabricOperation,
} from './fabricRuntime.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dummyGuid = '00000000-0000-0000-0000-000000000001';

interface Arguments {
  workspaceId?: string;
  workspaceName?: string;
  tenantId?: string;
  subscription?: string;
  dryRun: boolean;
}

interface DefinitionPart {
  path: string;
  payload: string;
  payloadType: 'InlineBase64';
}

function parseArguments(values: string[]): Arguments {
  const result: Arguments = { dryRun: values.includes('--dry-run') };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--workspace-id') result.workspaceId = values[++index];
    if (value === '--workspace-name') result.workspaceName = values[++index];
    if (value === '--tenant-id') result.tenantId = values[++index];
    if (value === '--subscription') result.subscription = values[++index];
  }
  if (result.workspaceId && result.workspaceName) {
    throw new Error('Use either --workspace-id or --workspace-name, not both.');
  }
  return result;
}

function template(content: string, variables: Record<string, string>) {
  let rendered = content;
  for (const [name, value] of Object.entries(variables)) {
    rendered = rendered.replaceAll(`{{${name}}}`, value);
  }
  const unresolved = rendered.match(/{{[A-Z0-9_]+}}/g);
  if (unresolved) throw new Error(`Unresolved template values: ${[...new Set(unresolved)].join(', ')}`);
  JSON.parse(rendered);
  return rendered;
}

function part(path: string, content: string): DefinitionPart {
  return {
    path: path.replaceAll('\\', '/'),
    payload: Buffer.from(content, 'utf8').toString('base64'),
    payloadType: 'InlineBase64',
  };
}

function jsonPart(path: string, variables: Record<string, string>, definitionPath = path) {
  return part(definitionPath, template(readFileSync(join(root, 'fabric', path), 'utf8'), variables));
}

function eventstreamDefinition(variables: Record<string, string>) {
  return {
    format: 'eventstream',
    parts: [
      jsonPart('eventstream/eventstream.json', variables, 'eventstream.json'),
      jsonPart('eventstream/eventstreamProperties.json', variables, 'eventstreamProperties.json'),
    ],
  };
}

function definitionValueMatches(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || expected.length !== actual.length) return false;
    const namedItems = expected.every(
      (item) => typeof item === 'object' && item !== null && typeof Reflect.get(item, 'name') === 'string'
    );
    if (!namedItems) {
      return expected.every((item, index) => definitionValueMatches(item, actual[index]));
    }
    return expected.every((item) => {
      const name = Reflect.get(item as object, 'name');
      const match = actual.find(
        (candidate) =>
          typeof candidate === 'object' && candidate !== null && Reflect.get(candidate, 'name') === name
      );
      return definitionValueMatches(item, match);
    });
  }

  if (typeof expected === 'object' && expected !== null) {
    if (typeof actual !== 'object' || actual === null) return false;
    return Object.entries(expected).every(([key, value]) =>
      definitionValueMatches(value, Reflect.get(actual, key))
    );
  }

  return Object.is(expected, actual);
}

async function fabricDefinitionMatches(
  token: string,
  workspaceId: string,
  endpoint: string,
  itemId: string,
  expected: { parts: DefinitionPart[] }
) {
  let response = await fabricRequest<{ definition?: { parts?: DefinitionPart[] } }>(
    token,
    'POST',
    `/workspaces/${workspaceId}/${endpoint}/${itemId}/getDefinition`
  );
  if (response.status === 202) {
    await waitForFabricOperation(token, response.headers);
    response = await fabricRequest<{ definition?: { parts?: DefinitionPart[] } }>(
      token,
      'POST',
      `/workspaces/${workspaceId}/${endpoint}/${itemId}/getDefinition`
    );
  }

  const actualParts = response.body?.definition?.parts ?? [];
  return expected.parts.every((expectedPart) => {
    const actualPart = actualParts.find((candidate) => candidate.path === expectedPart.path);
    if (!actualPart) return false;
    const expectedValue = JSON.parse(Buffer.from(expectedPart.payload, 'base64').toString('utf8'));
    const actualValue = JSON.parse(Buffer.from(actualPart.payload, 'base64').toString('utf8'));
    return definitionValueMatches(expectedValue, actualValue);
  });
}

async function applyKqlSchema(token: string, queryServiceUri: string) {
  const kqlToken = getAzureAccessToken('https://kusto.kusto.windows.net');
  const schema = readFileSync(join(root, 'fabric', 'eventhouse', 'DatabaseSchema.kql'), 'utf8');
  await fabricRequest(
    kqlToken,
    'POST',
    `${queryServiceUri.replace(/\/$/, '')}/v1/rest/mgmt`,
    { db: 'TTCOperations', csl: schema }
  );
  void token;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.dryRun) {
    const variables = {
      WORKSPACE_ID: dummyGuid,
      KQL_DATABASE_ID: dummyGuid,
    };
    const plan = {
      eventhouse: 'TTCEventhouse',
      kqlDatabase: 'TTCOperations',
      eventstream: eventstreamDefinition(variables),
    };
    console.log(
      `Fabric plan valid: ${plan.eventstream.parts.length} Eventstream parts ` +
        `routed to ${plan.kqlDatabase}.`
    );
    return;
  }

  if (!args.tenantId || !args.subscription) {
    throw new Error('--tenant-id and --subscription are required for deployment context assertions.');
  }
  if (!args.workspaceId && !args.workspaceName) {
    throw new Error('--workspace-id or --workspace-name is required.');
  }

  const account = assertAzureContext(args.tenantId, args.subscription);
  const token = getAzureAccessToken('https://api.fabric.microsoft.com');
  const workspaceId = await resolveWorkspaceId(token, args.workspaceId, args.workspaceName);

  const { item: eventhouse } = await ensureFabricItem(
    token,
    workspaceId,
    'eventhouses',
    'TTCEventhouse',
    {
      displayName: 'TTCEventhouse',
      description: 'Real-time TTC telemetry and service analytics.',
      creationPayload: { minimumConsumptionUnits: 0 },
    }
  );
  const { item: kqlDatabase } = await ensureFabricItem(
    token,
    workspaceId,
    'kqlDatabases',
    'TTCOperations',
    {
      displayName: 'TTCOperations',
      description: 'Vehicle positions, trip updates, and alerts from TTC GTFS-realtime.',
      creationPayload: {
        databaseType: 'ReadWrite',
        parentEventhouseItemId: eventhouse.id,
      },
    }
  );

  const kqlDetails = await fabricRequest<{
    properties?: { queryServiceUri?: string };
  }>(token, 'GET', `/workspaces/${workspaceId}/kqlDatabases/${kqlDatabase.id}`);
  const queryServiceUri = kqlDetails.body?.properties?.queryServiceUri;
  if (!queryServiceUri) throw new Error('KQL database did not expose a query service URI.');
  await applyKqlSchema(token, queryServiceUri);

  const variables = {
    WORKSPACE_ID: workspaceId,
    KQL_DATABASE_ID: kqlDatabase.id,
  };
  const { item: eventstream, created: eventstreamCreated } = await ensureFabricItem(
    token,
    workspaceId,
    'eventstreams',
    'TTCTelemetry',
    {
      displayName: 'TTCTelemetry',
      description: 'TTC GTFS-realtime Custom Endpoint routed to the TTCOperations KQL database.',
      definition: eventstreamDefinition(variables),
    }
  );
  const desiredEventstreamDefinition = eventstreamDefinition(variables);
  if (
    !eventstreamCreated &&
    !(await fabricDefinitionMatches(
      token,
      workspaceId,
      'eventstreams',
      eventstream.id,
      desiredEventstreamDefinition
    ))
  ) {
    await updateFabricDefinition(
      token,
      workspaceId,
      'eventstreams',
      eventstream.id,
      desiredEventstreamDefinition
    );
  }

  const deployment = {
    tenantId: account.tenantId,
    subscriptionId: account.subscriptionId,
    subscriptionName: account.subscriptionName,
    workspaceId,
    eventhouseId: eventhouse.id,
    kqlDatabaseId: kqlDatabase.id,
    kqlDatabaseName: 'TTCOperations',
    queryServiceUri,
    eventstreamId: eventstream.id,
    eventstreamSourceName: 'TTCPublisher',
    deployedAt: new Date().toISOString(),
  };
  const outputPath = join(root, '.fabric', 'deployment.local.json');
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(deployment, null, 2)}\n`, 'utf8');
  console.log(`Fabric workload ready. Non-secret deployment IDs written to ${outputPath}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});