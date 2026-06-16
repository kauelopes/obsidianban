import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TokenClaims } from '@obsidiankan/types'
import { HttpError } from '../services/errors.js'
import { type ToolAccess, isToolVisible } from './tool-access.js'

export interface McpTool {
  name: string
  description: string
  inputSchema?: Record<string, unknown>
  access?: ToolAccess
  handler: (params: unknown, claims: TokenClaims) => Promise<unknown>
}

/**
 * Serves MCP over the modern Streamable HTTP transport on a single `/mcp`
 * endpoint (POST). Runs **stateless**: one ephemeral Server + transport per
 * request, with no session map.
 *
 * This fits our auth model — the Bearer token (validated by the HTTP layer
 * before this is called) carries the agent's identity on every request, so
 * there is no cross-request state to keep. It replaces the deprecated
 * HTTP+SSE transport (GET /mcp/sse + POST /mcp/message).
 */
export class McpHttpManager {
  constructor(private readonly tools: McpTool[]) {}

  /**
   * Handle one POST /mcp request. Auth must already be validated; `claims`
   * are bound to the ephemeral server so tool visibility and handlers run as
   * the calling agent. `body` is the pre-parsed JSON-RPC payload.
   */
  async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    claims: TokenClaims,
    body: unknown,
  ): Promise<void> {
    const server = this.buildServer(claims)
    // sessionIdGenerator: undefined → stateless. No session id is emitted and
    // no session validation is performed; each request is fully isolated.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })

    res.on('close', () => {
      void transport.close()
      void server.close()
    })

    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  }

  private buildServer(claims: TokenClaims): Server {
    const server = new Server(
      { name: 'obsidiankanban-mcp', version: '0.1.0' },
      { capabilities: { tools: {} } },
    )

    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: this.tools
        .filter((t) => isToolVisible(t.access ?? 'all', claims))
        .map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema ?? { type: 'object', additionalProperties: true },
        })),
    }))

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const tool = this.tools.find((t) => t.name === req.params.name)
      if (!tool) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: 'not_implemented', tool: req.params.name }) }],
        }
      }
      try {
        const result = await tool.handler(req.params.arguments ?? {}, claims)
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      } catch (err) {
        if (err instanceof HttpError) {
          return {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify({ status: err.status, ...err.body }) }],
          }
        }
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: 'internal_error', message: (err as Error).message }) }],
        }
      }
    })

    return server
  }
}
