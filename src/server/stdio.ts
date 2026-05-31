import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { TokenClaims } from '../types.js'
import { HttpError } from '../services/errors.js'

interface ToolHandler {
  (params: unknown, claims: TokenClaims): Promise<unknown>
}

/**
 * Re-exposes the same handlers as the HTTP server (`CardService.*`) via
 * MCP stdio transport. Authentication is fixed for the process lifetime —
 * the token is read once from KANBAN_MCP_TOKEN at startup, validated, and
 * the resulting TokenClaims is reused for every tool call in the session.
 */
export class StdioMcpServer {
  private readonly server: Server
  private readonly tools = new Map<string, { description: string; inputSchema: Record<string, unknown>; handler: ToolHandler }>()

  constructor(private readonly claims: TokenClaims) {
    this.server = new Server(
      { name: 'obsidiankanban-mcp', version: '0.1.0' },
      { capabilities: { tools: {} } },
    )

    this.server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [...this.tools.entries()].map(([name, t]) => ({
        name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    }))

    this.server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const entry = this.tools.get(req.params.name)
      if (!entry) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: 'not_implemented', tool: req.params.name }) }],
        }
      }
      try {
        const result = await entry.handler((req.params.arguments ?? {}) as unknown, this.claims)
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        }
      } catch (err) {
        if (err instanceof HttpError) {
          return {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify({ status: err.status, ...err.body }) }],
          }
        }
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'internal_error', message: (err as Error).message }),
            },
          ],
        }
      }
    })
  }

  registerTool(name: string, description: string, handler: ToolHandler, inputSchema?: Record<string, unknown>): void {
    this.tools.set(name, {
      description,
      inputSchema: inputSchema ?? { type: 'object', additionalProperties: true },
      handler,
    })
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport()
    await this.server.connect(transport)
  }
}
