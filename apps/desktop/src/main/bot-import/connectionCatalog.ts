import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ImportedMcpServer } from './types.js';
import type { CompanionEnvironment } from './environment.js';
import { fingerprint } from './files.js';
import { environmentRedactions, redactEnvironmentData, redactEnvironmentValues } from './process.js';

/** Include resolved connection-local values without overwriting same-named imports. */
export function connectionRedactions(server: ImportedMcpServer, environment: Record<string, string>): Record<string, string> {
  const values = [...Object.values(environmentRedactions(environment)), ...Object.values(environmentRedactions(server.env ?? {})), ...Object.values(server.headers ?? {})];
  for (const [name, value] of Object.entries(server.headers ?? {})) {
    if (/^(proxy-)?authorization$/i.test(name)) {
      const credential = /^\S+\s+(.+)$/.exec(value)?.[1];
      if (credential) values.push(credential);
    }
  }
  if (server.url) {
    values.push(...urlCredentialValues(server.url, true));
  }
  return Object.fromEntries([...new Set(values)].filter(Boolean).map((value, index) => [`connection_credential_${index}`, value]));
}

/** URL credentials can be echoed in encoded or decoded form by a remote service. */
function urlCredentialValues(raw: string, includePath = false): string[] {
  const values = [raw];
  try {
    const url = new URL(raw);
    values.push(url.username, url.password, ...url.searchParams.values());
    // URLSearchParams already decodes once; retain the wire representation too.
    for (const pair of url.search.slice(1).split('&')) if (pair.includes('=')) values.push(pair.slice(pair.indexOf('=') + 1));
    if (includePath) values.push(url.pathname, ...url.pathname.split('/').filter(Boolean));
  } catch { /* Invalid URLs fail at execution; never publish the literal in errors. */ }
  return [...new Set(values.filter(value => value && value !== '/').flatMap(value => {
    try { return [value, decodeURIComponent(value)]; } catch { return [value]; }
  }))];
}

/** Known selected credentials only; keep originals in the private environment. */
export function importedContentRedactions(environment: Pick<CompanionEnvironment, 'env' | 'mcp' | 'credentials'>, monitorUrls: string[] = []): Record<string, string> {
  const values = [...Object.values(environmentRedactions(environment.env)),
    ...environment.mcp.flatMap(server => Object.values(connectionRedactions(server, environment.env))),
    ...monitorUrls.flatMap(url => urlCredentialValues(url, true))];
  const collect = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === 'string' && /^(?:key|api[_-]?key|.*token|.*secret|.*password|authorization|access|refresh)$/i.test(key)) values.push(child);
      else collect(child);
    }
  };
  for (const credential of environment.credentials) collect(credential.value);
  const named = environmentRedactions(environment.env);
  const namedValues = new Set(Object.values(named));
  let index = 0;
  for (const value of new Set(values)) {
    if (!value || namedValues.has(value)) continue;
    while (Object.hasOwn(named, `imported_credential_${index}`)) index++;
    named[`imported_credential_${index++}`] = value;
  }
  return named;
}

/** Keep readable identities unless the upstream embeds a credential in the name. */
export function publicConnectionName(name: string, secrets: Record<string, string>): string {
  return redactEnvironmentValues(name, secrets) === name ? name : `imported_${fingerprint(name).slice(0, 20)}`;
}

function redactSchema(value: unknown, secrets: Record<string, string>): unknown {
  if (Array.isArray(value)) return value.map(child => redactSchema(child, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    // JSON Schema type discriminators are protocol syntax, not business values.
    // An imported variable containing "object" must not invalidate the catalog.
    const types = Array.isArray(child) ? child : [child];
    if (key === 'type' && types.every(type => ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type))) return [key, child];
    return [redactEnvironmentValues(key, secrets), redactSchema(child, secrets)];
  }));
  return redactEnvironmentData(value, secrets);
}

/** Restore schema-defined argument keys only, privately at the upstream call boundary. */
export function restoreImportedArguments(value: Record<string, unknown>, schema: unknown, secrets: Record<string, string>): Record<string, unknown> {
  const keys = new Map<string, string>();
  const collect = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      const publicKey = redactEnvironmentValues(key, secrets);
      if (keys.has(publicKey) && keys.get(publicKey) !== key) throw new Error('Ambiguous imported schema');
      keys.set(publicKey, key);
      collect(child);
    }
  };
  collect(schema);
  const restore = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(restore);
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, child]) => [keys.get(key) ?? key, restore(child)]));
    return node;
  };
  return restore(value) as Record<string, unknown>;
}

/** Redact tool metadata and schema keys/strings while preserving protocol syntax. */
export function redactImportedTool(tool: Tool, secrets: Record<string, string>): Tool {
  const result = redactEnvironmentData(tool, secrets);
  result.name = publicConnectionName(tool.name, secrets);
  result.inputSchema = redactSchema(tool.inputSchema, secrets) as Tool['inputSchema'];
  if (tool.outputSchema) result.outputSchema = redactSchema(tool.outputSchema, secrets) as Tool['outputSchema'];
  return result;
}
