import path from 'node:path';
import { importedProcessEnvironment, runImportedProcess, redactEnvironmentValues, redactEnvironmentData } from './process.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { McpProvider } from '@cindy/maker-core';
import { resolveLiziMcpSessionContext } from '@cindy/mcps';
import { readCompanionSessionEnvironment } from './runtime.js';
import { withImportedConnection } from './connections.js';
import { fingerprint } from './files.js';
import { connectionRedactions, publicConnectionName, redactImportedTool } from './connectionCatalog.js';

export const COMPANION_CONNECTIONS_MCP_NAME = 'companion_connections';

/** The shared bridge recovers the caller for every operation, including tools/list. */
export function createCompanionConnectionsProvider(): McpProvider {
  return {
    name: COMPANION_CONNECTIONS_MCP_NAME,
    toClaudeSdkConfig(context) {
      const server = new McpServer({ name: COMPANION_CONNECTIONS_MCP_NAME, version: '1.0.0' }, { capabilities: { tools: {} } });
      const resolve = async () => {
        const session = resolveLiziMcpSessionContext(context);
        if (!session.sessionId) return undefined;
        return readCompanionSessionEnvironment(session.sessionId);
      };
      const toolName = (connection: string, tool: string, publicName = tool) => `c_${fingerprint(connection).slice(0, 12)}_${publicName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32)}_${fingerprint(tool).slice(0, 8)}`;
      server.server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
        const scope = await resolve();
        if (!scope) return { tools: [] };
        const tools: Tool[] = [{ name: 'run_command', description: 'Run a command with this companion’s imported environment and API credentials. Use this for imported skills and data queries that require their original environment. This executes arbitrary shell code with private credentials and may write files or use the network; it requires the current task’s command authorization. Output masking is not a security sandbox.', annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }, inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false } }];
        for (const connection of scope.environment.mcp.filter(connection => connection.enabled !== false)) {
          const secrets = connectionRedactions(connection, scope.environment.env);
          // Keep a failed or partially paginated catalog local to its connection.
          // Never swallow cancellation or an account change as an optional outage.
          try {
            const available = await withImportedConnection(connection, scope.environment.env, scope.assertOwner, async client => {
              const entries: Tool[] = [];
              let cursor: string | undefined;
              let pages = 0;
              do {
                if (++pages > 100) throw new Error('Connection page limit exceeded');
                const page = await client.listTools({ cursor }, { timeout: 15_000 });
                for (const tool of page.tools) {
                  const redacted = redactImportedTool({ ...tool, description: `${connection.name} · ${tool.name}\n${tool.description ?? ''}` }, secrets);
                  entries.push({ ...redacted, name: toolName(connection.name, tool.name, redacted.name) });
                }
                cursor = page.nextCursor;
                if (tools.length + entries.length > 1000) throw new Error('Connection tool limit exceeded');
              } while (cursor);
              return entries;
            }, { identity: scope.identity, signal: extra.signal });
            tools.push(...available);
          } catch {
            scope.assertOwner();
            extra.signal.throwIfAborted();
          }
        }
        scope.assertOwner();
        return { tools };
      });
      server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        const scope = await resolve();
        if (!scope) throw new Error('Companion connection unavailable');
        if (request.params.name === 'run_command') {
          const command = request.params.arguments?.command;
          if (typeof command !== 'string' || !command.trim() || command.length > 32000) throw new Error('Invalid command');
          const output = await runImportedProcess({ command: process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh',
            args: process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command],
            cwd: path.join(scope.userData, 'bots', scope.botId), env: importedProcessEnvironment(scope.environment.env), timeoutMs: 120_000,
            signal: extra.signal, assertOwner: scope.assertOwner });
          return { content: [{ type: 'text', text: redactEnvironmentValues(output.stdout, scope.environment.env) }], isError: output.exitCode !== 0 };
        }
        // Resolve against the actual catalog; an arbitrary model-supplied name cannot choose a server.
        for (const connection of scope.environment.mcp.filter(connection => connection.enabled !== false && request.params.name.startsWith(`c_${fingerprint(connection.name).slice(0, 12)}_`))) {
          const secrets = connectionRedactions(connection, scope.environment.env);
          const result = await withImportedConnection(connection, scope.environment.env, scope.assertOwner, async client => {
            let cursor: string | undefined;
            let count = 0; let pages = 0;
            do {
              if (++pages > 100) throw new Error('Connection page limit exceeded');
              const page = await client.listTools({ cursor }, { timeout: 15_000 });
              count += page.tools.length;
              const tool = page.tools.find(item => toolName(connection.name, item.name, publicConnectionName(item.name, secrets)) === request.params.name);
              if (tool) return client.callTool({ name: tool.name, arguments: request.params.arguments ?? {} }, undefined, { timeout: 120_000 });
              if (count > 1000) throw new Error('Connection tool limit exceeded');
              cursor = page.nextCursor;
            } while (cursor);
            return undefined;
          }, { identity: scope.identity, signal: extra.signal });
          if (result) {
            const redacted = redactEnvironmentData(result, secrets);
            // Preserve MCP content discriminators even if a source variable happens
            // to contain "text". Business strings and structured data stay redacted.
            const originalContent = result.content;
            if (Array.isArray(originalContent) && Array.isArray(redacted.content)) redacted.content = redacted.content.map((block, index) => ({ ...block, type: originalContent[index]!.type }));
            return redacted;
          }
        }
        throw new Error('Companion tool unavailable');
      });
      return { type: 'sdk', name: COMPANION_CONNECTIONS_MCP_NAME, instance: server };
    },
  };
}
