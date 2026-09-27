import path from 'node:path';
import { runImportedProcess, redactEnvironmentValues } from './process.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { McpProvider } from '@cindy/maker-core';
import { resolveLiziMcpSessionContext } from '@cindy/mcps';
import { readCompanionSessionEnvironment } from './runtime.js';
import { withImportedConnection } from './connections.js';
import { fingerprint } from './files.js';

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
      const toolName = (connection: string, tool: string) => `c_${fingerprint(connection).slice(0, 12)}_${tool.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32)}_${fingerprint(tool).slice(0, 8)}`;
      server.server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
        const scope = await resolve();
        if (!scope) return { tools: [] };
        const tools: Tool[] = [{ name: 'run_command', description: 'Run a command with this companion’s imported environment and API credentials. Use this for imported skills and data queries that require their original environment. Secrets are injected on the owning computer; do not print them.', inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false } }];
        for (const connection of scope.environment.mcp.filter(connection => connection.enabled !== false)) {
          await withImportedConnection(connection, scope.environment.env, scope.assertOwner, async client => {
            let cursor: string | undefined;
            let pages = 0;
            do {
              if (++pages > 100) throw new Error('Connection page limit exceeded');
              const page = await client.listTools({ cursor }, { timeout: 15_000 });
              for (const tool of page.tools) tools.push({ ...tool, name: toolName(connection.name, tool.name), description: `${connection.name} · ${tool.name}\n${tool.description ?? ''}` });
              cursor = page.nextCursor;
              if (tools.length > 1000) throw new Error('Connection tool limit exceeded');
            } while (cursor);
          }, { identity: scope.identity, signal: extra.signal });
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
            cwd: path.join(scope.userData, 'bots', scope.botId), env: { ...process.env, ...scope.environment.env }, timeoutMs: 120_000,
            signal: extra.signal, assertOwner: scope.assertOwner });
          return { content: [{ type: 'text', text: redactEnvironmentValues(output.stdout, scope.environment.env) }], isError: output.exitCode !== 0 };
        }
        // Resolve against the actual catalog; an arbitrary model-supplied name cannot choose a server.
        for (const connection of scope.environment.mcp.filter(connection => connection.enabled !== false && request.params.name.startsWith(`c_${fingerprint(connection.name).slice(0, 12)}_`))) {
          const result = await withImportedConnection(connection, scope.environment.env, scope.assertOwner, async client => {
            let cursor: string | undefined;
            let count = 0; let pages = 0;
            do {
              if (++pages > 100) throw new Error('Connection page limit exceeded');
              const page = await client.listTools({ cursor }, { timeout: 15_000 });
              count += page.tools.length;
              const tool = page.tools.find(item => toolName(connection.name, item.name) === request.params.name);
              if (tool) return client.callTool({ name: tool.name, arguments: request.params.arguments ?? {} }, undefined, { timeout: 120_000 });
              if (count > 1000) throw new Error('Connection tool limit exceeded');
              cursor = page.nextCursor;
            } while (cursor);
            return undefined;
          }, { identity: scope.identity, signal: extra.signal });
          if (result) return JSON.parse(redactEnvironmentValues(JSON.stringify(result), scope.environment.env));
        }
        throw new Error('Companion tool unavailable');
      });
      return { type: 'sdk', name: COMPANION_CONNECTIONS_MCP_NAME, instance: server };
    },
  };
}
