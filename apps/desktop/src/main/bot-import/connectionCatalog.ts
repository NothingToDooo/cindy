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

/** Executable credentials plus private masks for known values embedded in selected originals. */
export function importedContentRedactions(environment: Pick<CompanionEnvironment, 'env' | 'mcp' | 'credentials' | 'contentRedactions'>, monitorUrls: string[] = []): Record<string, string> {
  const values = [...Object.values(environmentRedactions(environment.env)),
    ...Object.values(environment.contentRedactions ?? {}),
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

const schemaMaps = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies']);
const schemaChildren = new Set(['items', 'prefixItems', 'additionalItems', 'contains', 'additionalProperties', 'unevaluatedItems',
  'unevaluatedProperties', 'propertyNames', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'contentSchema']);
const schemaKeywords = new Set([...schemaMaps, ...schemaChildren,
  '$schema', '$id', 'id', '$ref', '$anchor', '$dynamicRef', '$dynamicAnchor', '$recursiveRef', '$recursiveAnchor', '$vocabulary', '$comment',
  'type', 'enum', 'const', 'default', 'examples', 'title', 'description', 'required', 'dependentRequired',
  'multipleOf', 'maximum', 'exclusiveMaximum', 'minimum', 'exclusiveMinimum', 'maxLength', 'minLength', 'pattern',
  'maxItems', 'minItems', 'uniqueItems', 'maxContains', 'minContains', 'maxProperties', 'minProperties',
  'format', 'contentEncoding', 'contentMediaType', 'readOnly', 'writeOnly', 'deprecated']);

function redactSchema(value: unknown, secrets: Record<string, string>, dictionary = false): unknown {
  if (Array.isArray(value)) return value.map(child => redactSchema(child, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    // Names in property/definition maps are data even when named "type" or
    // "properties". Schema keywords themselves must retain their wire spelling.
    if (dictionary) return [redactEnvironmentValues(key, secrets), redactSchema(child, secrets)];
    // JSON Schema type discriminators are protocol syntax, not business values.
    // An imported variable containing "object" must not invalidate the catalog.
    const types = Array.isArray(child) ? child : [child];
    if (key === 'type' && types.every(type => ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type))) return [key, child];
    const projected = schemaMaps.has(key) ? redactSchema(child, secrets, true)
      : schemaChildren.has(key) ? redactSchema(child, secrets) : redactEnvironmentData(child, secrets);
    return [schemaKeywords.has(key) ? key : redactEnvironmentValues(key, secrets), projected];
  }));
  return redactEnvironmentData(value, secrets);
}

/** Restore only schema-defined aliases, privately at the upstream call boundary. */
export function restoreImportedArguments(value: Record<string, unknown>, schema: unknown, secrets: Record<string, string>): Record<string, unknown> {
  const keys = new Map<string, string>();
  const scalars = new Map<string, string>();
  const literal = (value: unknown): void => {
    if (typeof value === 'string') {
      const alias = redactEnvironmentValues(value, secrets);
      if (scalars.has(alias) && scalars.get(alias) !== value) throw new Error('Ambiguous imported schema');
      // Include unchanged literals to detect collisions with an existing alias.
      scalars.set(alias, value);
    } else if (value && typeof value === 'object') Object.values(value).forEach(literal);
  };
  const collect = (node: unknown, dictionary = false): void => {
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      const publicKey = redactEnvironmentValues(key, secrets);
      if (keys.has(publicKey) && keys.get(publicKey) !== key) throw new Error('Ambiguous imported schema');
      keys.set(publicKey, key);
      if (!dictionary && (key === 'enum' || key === 'const' || key === 'default')) literal(child);
      collect(child, !dictionary && ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'].includes(key));
    }
  };
  collect(schema);
  const restore = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(restore);
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, child]) => [keys.get(key) ?? key, restore(child)]));
    return typeof node === 'string' ? scalars.get(node) ?? node : node;
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

/** The SDK has validated content block fields. Preserve wire syntax only at
 * those protocol positions; arbitrary structured payload/meta keys stay private. */
export function redactImportedResult<T extends Record<string, unknown>>(result: T, secrets: Record<string, string>): T {
  const envelope = new Set(['content', 'structuredContent', 'isError', '_meta', 'toolResult']);
  const redacted = Object.fromEntries(Object.entries(result).map(([key, value]) => [
    envelope.has(key) ? key : redactEnvironmentValues(key, secrets), redactEnvironmentData(value, secrets),
  ]));
  const fields = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value)
    .map(([key, child]) => [key, redactEnvironmentData(child, secrets)]));
  if (Array.isArray(result.content)) redacted.content = result.content.map(block => {
    const content = fields(block);
    content.type = block.type;
    if (block.resource) content.resource = fields(block.resource);
    if (block.annotations) {
      content.annotations = { ...fields(block.annotations),
        ...(block.annotations.audience === undefined ? {} : { audience: [...block.annotations.audience] }) };
    }
    if (Array.isArray(block.icons)) content.icons = block.icons.map((icon: Record<string, unknown>) => ({
      ...fields(icon), ...(icon.theme === undefined ? {} : { theme: icon.theme }),
    }));
    return content;
  });
  return redacted as T;
}
