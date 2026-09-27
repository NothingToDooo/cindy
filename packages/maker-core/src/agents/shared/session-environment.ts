/** Keep the host's model route and control channels authoritative when adding tool credentials. */
export function mergeSessionEnvironment<T extends Record<string, string | undefined>>(
  runtime: T,
  imported: Record<string, string> | undefined,
): T {
  if (!imported) return runtime;
  const result = { ...runtime };
  for (const [key, value] of Object.entries(imported)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes('\0')) throw new Error('Invalid companion environment');
    // These names configure the runtime itself. Keep their imported values in
    // the Bot's encrypted environment for explicit scripts, not the model proxy.
    if (/^(CINDY_|XDT_|CODEX_|CLAUDE_|PI_CODING_AGENT_DIR$|HOME$|USERPROFILE$|ELECTRON_|NODE_OPTIONS$|NODE_PATH$)/.test(key)) continue;
    if (['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'].includes(key)) continue;
    Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return result;
}
