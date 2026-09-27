import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ImportedMcpServer } from './types.js';
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
    values.push(server.url);
    try {
      const url = new URL(server.url);
      for (const value of [url.username, url.password, ...url.searchParams.values()]) {
        if (!value) continue;
        values.push(value);
        try { values.push(decodeURIComponent(value)); } catch { /* Keep the literal value if it is not URI-encoded. */ }
      }
    } catch { /* Invalid connection URLs fail when connecting, never enter error output. */ }
  }
  return Object.fromEntries([...new Set(values)].filter(Boolean).map((value, index) => [`connection_credential_${index}`, value]));
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
