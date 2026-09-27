import { fingerprint } from './files.js';
import { CompanionImportError, type ImportItem } from './types.js';
import { importedContentRedactions } from './connectionCatalog.js';

const variableName = (name: string) => process.platform === 'win32' ? name.toUpperCase() : name;

/** Never choose an account by file order, including older/command clients bypassing checkboxes. */
export function selectedImportEnvironment(items: ImportItem[]): Record<string, string> {
  const values = new Map<string, string>();
  const environment: Record<string, string> = {};
  for (const item of items) for (const [name, value] of Object.entries(item.env ?? {})) {
    const key = variableName(name);
    if (values.has(key) && values.get(key) !== value) throw new CompanionImportError('INVALID_SELECTION');
    values.set(key, value);
    environment[name] = value;
  }
  return environment;
}

export function resolveImportReferences(value: unknown, env: Record<string, string>, allowMissing = false): unknown {
  if (typeof value === 'string') return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, key: string) => {
    if (Object.hasOwn(env, key)) return env[key]!;
    if (allowMissing) return match;
    throw new CompanionImportError('AUTOMATION_DEPENDENCY_NOT_SELECTED');
  });
  if (Array.isArray(value)) return value.map(child => resolveImportReferences(child, env, allowMissing));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolveImportReferences(child, env, allowMissing)]));
  return value;
}

export function selectedImportRedactions(items: ImportItem[]): Record<string, string> {
  const env = selectedImportEnvironment(items);
  // Missing variables do not supply a known credential. Actual connection imports
  // still require every selected dependency and use strict reference resolution.
  const resolve = (value: unknown) => resolveImportReferences(value, env, true);
  return importedContentRedactions({ env,
    mcp: items.flatMap(item => item.mcp ? [resolve(item.mcp) as NonNullable<typeof item.mcp>] : []),
    credentials: items.flatMap(item => item.credential ? [{ id: item.view.id, ...item.credential, value: resolve(item.credential.value) }] : []),
  });
}

/** Public alternatives contain only opaque entry IDs, never credential values. */
export function markImportEnvironmentChoices(items: ImportItem[]): void {
  const providers = new Map<string, Array<{ item: ImportItem; value: string }>>();
  for (const item of items) for (const [name, value] of Object.entries(item.env ?? {})) {
    const key = variableName(name);
    const group = providers.get(key) ?? [];
    group.push({ item, value }); providers.set(key, group);
  }
  for (const group of providers.values()) for (const { item, value } of group) {
    const conflicts = group.filter(other => other.value !== value).map(other => other.item.view.id);
    if (!conflicts.length) continue;
    item.view.exclusiveWith = [...new Set([...(item.view.exclusiveWith ?? []), ...conflicts])];
    item.view.selected = false;
  }
}

/** Resolve variables against the final selection, preserving mandatory skills/connections. */
export function resolveImportEnvironmentDependencies(items: ImportItem[], providers: ImportItem[] = items): ImportItem[] {
  return items.map(item => {
    if (!item.envDependencies) return item;
    const { names, entries } = item.envDependencies;
    const ids = names.map(name => providers.find(provider => Object.keys(provider.env ?? {}).some(key => variableName(key) === variableName(name)))?.view.id
      ?? `env-${fingerprint(name).slice(0, 20)}`);
    return { ...item, view: { ...item.view, dependsOn: [...new Set([...entries, ...ids])] } };
  });
}
