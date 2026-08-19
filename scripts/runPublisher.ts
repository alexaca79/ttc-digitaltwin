import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  assertAzureContext,
  fabricRequest,
  getAzureAccessToken,
} from './fabricRuntime.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface Deployment {
  tenantId: string;
  subscriptionId: string;
  workspaceId: string;
  eventstreamId: string;
  eventstreamSourceName: string;
  queryServiceUri?: string;
  kqlDatabaseName?: string;
}

interface TopologySource {
  id: string;
  name: string;
}

interface SourceConnection {
  fullyQualifiedNamespace: string;
  eventHubName: string;
  accessKeys: {
    primaryConnectionString: string;
  };
}

async function main() {
  const deployment = JSON.parse(
    readFileSync(join(root, '.fabric', 'deployment.local.json'), 'utf8')
  ) as Deployment;
  assertAzureContext(deployment.tenantId, deployment.subscriptionId);
  const token = getAzureAccessToken('https://api.fabric.microsoft.com');
  const topologyResponse = await fabricRequest<{
    sources?: TopologySource[];
    topology?: { sources?: TopologySource[] };
  }>(
    token,
    'GET',
    `/workspaces/${deployment.workspaceId}/eventstreams/${deployment.eventstreamId}/topology`
  );
  const sources = topologyResponse.body?.sources ?? topologyResponse.body?.topology?.sources ?? [];
  const source = sources.find((candidate) => candidate.name === deployment.eventstreamSourceName);
  if (!source) throw new Error(`Custom Endpoint source '${deployment.eventstreamSourceName}' was not found.`);

  const connectionResponse = await fabricRequest<SourceConnection>(
    token,
    'GET',
    `/workspaces/${deployment.workspaceId}/eventstreams/${deployment.eventstreamId}/sources/${source.id}/connection`
  );
  const connection = connectionResponse.body;
  if (!connection?.fullyQualifiedNamespace || !connection.eventHubName || !connection.accessKeys.primaryConnectionString) {
    throw new Error('Fabric returned incomplete Custom Endpoint connection details.');
  }

  console.log('Starting TTC publisher with in-memory Fabric Eventstream credentials.');
  const child = spawn('npm', ['run', 'ingest'], {
    cwd: root,
    env: {
      ...process.env,
      FABRIC_EVENTSTREAM_BROKERS: `${connection.fullyQualifiedNamespace}:9093`,
      FABRIC_EVENTSTREAM_TOPIC: connection.eventHubName,
      FABRIC_EVENTSTREAM_USERNAME: '$ConnectionString',
      FABRIC_EVENTSTREAM_PASSWORD: connection.accessKeys.primaryConnectionString,
      FABRIC_KQL_QUERY_URI: deployment.queryServiceUri ?? '',
      FABRIC_KQL_DATABASE: deployment.kqlDatabaseName ?? 'TTCOperations',
    },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  child.once('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});