import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ImportedMcpServer } from './types.js';
import { CompanionImportError } from './types.js';
import { fingerprint } from './files.js';

interface Connection { client: Client; close(): Promise<void>; users: number; idle?: ReturnType<typeof setTimeout> }
const connections = new Map<string, Promise<Connection>>();

/** Uses the imported connection on the owning computer, with its private headers/env. */
export async function withImportedConnection<T>(
  server: ImportedMcpServer,
  environment: Record<string, string>,
  assertOwner: () => void,
  run: (client: Client) => Promise<T>,
  scope?: { identity: string; signal: AbortSignal },
): Promise<T> {
  assertOwner();
  scope?.signal.throwIfAborted();
  const key = scope ? fingerprint([scope.identity, server]) : undefined;
  const connect = async (): Promise<Connection> => {
  const client = new Client({ name: 'cindy-companion', version: '1.0.0' });
  const transport = server.command
    ? new StdioClientTransport({ command: server.command, args: server.args ?? [],
      env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), ...environment, ...server.env }, stderr: 'ignore' })
    : server.transport === 'sse'
      ? new SSEClientTransport(new URL(server.url!), { requestInit: { headers: server.headers } })
      : new StreamableHTTPClientTransport(new URL(server.url!), { requestInit: { headers: server.headers } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = async () => { await client.close().catch(() => {}); await transport.close().catch(() => {}); };
  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CompanionImportError('CONNECTION_TIMEOUT')), 15_000); }),
    ]);
    assertOwner();
    return { client, close, users: 0 };
  } catch { await close(); throw new CompanionImportError('CONNECTION_FAILED'); }
  finally { clearTimeout(timer); }
  };
  let pending = key ? connections.get(key) : undefined;
  if (!pending) {
    if (key && connections.size >= 128) throw new CompanionImportError('CONNECTION_LIMIT');
    pending = connect();
    if (key) {
      connections.set(key, pending);
      void pending.catch(() => { if (connections.get(key) === pending) connections.delete(key); });
    }
  }
  const connection = await pending;
  clearTimeout(connection.idle); connection.users++;
  let invalid = false;
  let rejectBoundary: ((error: Error) => void) | undefined;
  const discard = () => {
    invalid = true;
    if (key && connections.get(key) === pending) connections.delete(key);
    void connection.close();
    rejectBoundary?.(new CompanionImportError('CONNECTION_CANCELLED'));
  };
  const timer = setInterval(() => { try { assertOwner(); } catch { discard(); } }, 250);
  timer.unref();
  scope?.signal.addEventListener('abort', discard, { once: true });
  try {
    assertOwner(); scope?.signal.throwIfAborted();
    const result = await Promise.race([run(connection.client), new Promise<never>((_, reject) => { rejectBoundary = reject; })]);
    assertOwner(); return result;
  } catch {
    discard();
    // Foreign errors can contain headers/tokens; do not return their message.
    throw new CompanionImportError('CONNECTION_FAILED');
  } finally {
    clearInterval(timer); scope?.signal.removeEventListener('abort', discard);
    connection.users--;
    if (!key || invalid) await connection.close();
    else if (connection.users === 0) {
      connection.idle = setTimeout(() => {
        if (connections.get(key) === pending) connections.delete(key);
        void connection.close();
      }, 5 * 60_000);
      connection.idle.unref();
    }
  }
}
