import { execFileSync } from 'node:child_process';

export interface AzureContext {
  tenantId: string;
  subscriptionId: string;
  subscriptionName: string;
}

export interface FabricRequestResult<T> {
  body: T | null;
  headers: Headers;
  status: number;
}

const FABRIC_API = 'https://api.fabric.microsoft.com/v1';

function runAz(argumentsList: string[]) {
  return execFileSync(process.platform === 'win32' ? 'az.cmd' : 'az', argumentsList, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function assertAzureContext(
  expectedTenantId: string,
  expectedSubscription: string
): AzureContext {
  if (!process.env.AZURE_CONFIG_DIR) {
    throw new Error(
      'AZURE_CONFIG_DIR is required. Set it to an isolated per-tenant Azure CLI profile before deployment.'
    );
  }

  let account: { tenantId: string; id: string; name: string };
  try {
    account = JSON.parse(runAz(['account', 'show', '--output', 'json'])) as typeof account;
  } catch {
    throw new Error(
      'Azure CLI is not signed in for this isolated profile. Run az login --tenant <tenant-id> in this terminal.'
    );
  }

  if (account.tenantId.toLowerCase() !== expectedTenantId.toLowerCase()) {
    throw new Error(
      `Tenant assertion failed. Expected ${expectedTenantId}, active tenant is ${account.tenantId}.`
    );
  }
  if (
    account.id.toLowerCase() !== expectedSubscription.toLowerCase() &&
    account.name.toLowerCase() !== expectedSubscription.toLowerCase()
  ) {
    throw new Error(
      `Subscription assertion failed. Expected ${expectedSubscription}, active subscription is ${account.name} (${account.id}).`
    );
  }

  return {
    tenantId: account.tenantId,
    subscriptionId: account.id,
    subscriptionName: account.name,
  };
}

export function getAzureAccessToken(resource: string) {
  const token = runAz([
    'account',
    'get-access-token',
    '--resource',
    resource,
    '--query',
    'accessToken',
    '--output',
    'tsv',
  ]);
  if (!token) throw new Error(`Azure CLI returned no access token for ${resource}.`);
  return token;
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function fabricRequest<T>(
  token: string,
  method: string,
  pathOrUrl: string,
  body?: unknown,
  maxAttempts = 5
): Promise<FabricRequestResult<T>> {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${FABRIC_API}${pathOrUrl}`;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as T) : null;

    if (response.ok) {
      return { body: parsed, headers: response.headers, status: response.status };
    }

    const retryAfterSeconds = Number(response.headers.get('retry-after') ?? 0);
    const transient = response.status === 429 || response.status >= 500;
    if (transient && attempt < maxAttempts) {
      const delay = retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : Math.min(30_000, 1000 * 2 ** attempt);
      await wait(delay);
      continue;
    }

    throw new Error(`${method} ${url} failed (${response.status}): ${text || response.statusText}`);
  }
  throw new Error(`${method} ${url} exhausted retries.`);
}

export async function waitForFabricOperation(token: string, headers: Headers) {
  const location = headers.get('location');
  if (!location) return;
  let retryAfterSeconds = Number(headers.get('retry-after') ?? 5);

  for (let attempt = 0; attempt < 90; attempt += 1) {
    await wait(Math.max(1, retryAfterSeconds) * 1000);
    const operation = await fabricRequest<{
      status: string;
      error?: unknown;
    }>(token, 'GET', location, undefined, 5);
    const status = operation.body?.status;
    if (status === 'Succeeded') return;
    if (status === 'Failed' || status === 'Cancelled') {
      throw new Error(`Fabric operation ${status}: ${JSON.stringify(operation.body?.error ?? operation.body)}`);
    }
    retryAfterSeconds = Number(operation.headers.get('retry-after') ?? 5);
  }
  throw new Error(`Fabric operation did not complete within the polling window: ${location}`);
}

export async function resolveWorkspaceId(token: string, workspaceId?: string, workspaceName?: string) {
  if (workspaceId) return workspaceId;
  if (!workspaceName) throw new Error('Provide --workspace-id or --workspace-name.');

  let url: string | null = `${FABRIC_API}/workspaces`;
  const matches: Array<{ id: string; displayName: string }> = [];
  while (url) {
    const page = await fabricRequest<{
      value: Array<{ id: string; displayName: string }>;
      continuationUri?: string;
    }>(token, 'GET', url);
    matches.push(
      ...(page.body?.value ?? []).filter(
        (workspace) => workspace.displayName.toLowerCase() === workspaceName.toLowerCase()
      )
    );
    url = page.body?.continuationUri ?? null;
  }
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `Fabric workspace '${workspaceName}' was not found.`
        : `Fabric workspace name '${workspaceName}' is ambiguous; use --workspace-id.`
    );
  }
  return matches[0].id;
}

export interface FabricItem {
  id: string;
  displayName: string;
  properties?: Record<string, unknown>;
}

export interface EnsuredFabricItem {
  item: FabricItem;
  created: boolean;
}

export async function findFabricItem(
  token: string,
  workspaceId: string,
  endpoint: string,
  displayName: string
) {
  const response = await fabricRequest<{ value: FabricItem[] }>(
    token,
    'GET',
    `/workspaces/${workspaceId}/${endpoint}`
  );
  const matches = (response.body?.value ?? []).filter(
    (item) => item.displayName.toLowerCase() === displayName.toLowerCase()
  );
  if (matches.length > 1) {
    throw new Error(`Multiple ${endpoint} items named '${displayName}' were found.`);
  }
  return matches[0] ?? null;
}

export async function ensureFabricItem(
  token: string,
  workspaceId: string,
  endpoint: string,
  displayName: string,
  createBody: unknown
): Promise<EnsuredFabricItem> {
  const existing = await findFabricItem(token, workspaceId, endpoint, displayName);
  if (existing) {
    console.log(`Reusing ${displayName} (${existing.id}).`);
    return { item: existing, created: false };
  }

  console.log(`Creating ${displayName}...`);
  const created = await fabricRequest<FabricItem>(
    token,
    'POST',
    `/workspaces/${workspaceId}/${endpoint}`,
    createBody
  );
  if (created.status === 202) await waitForFabricOperation(token, created.headers);
  if (created.body?.id) return { item: created.body, created: true };

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await wait(3000);
    const item = await findFabricItem(token, workspaceId, endpoint, displayName);
    if (item) return { item, created: true };
  }
  throw new Error(`Fabric created '${displayName}', but it was not discoverable after provisioning.`);
}

export async function updateFabricDefinition(
  token: string,
  workspaceId: string,
  endpoint: string,
  itemId: string,
  definition: unknown
) {
  const updated = await fabricRequest(
    token,
    'POST',
    `/workspaces/${workspaceId}/${endpoint}/${itemId}/updateDefinition`,
    { definition }
  );
  if (updated.status === 202) await waitForFabricOperation(token, updated.headers);
}