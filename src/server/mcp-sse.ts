import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TokenClaims } from '../types.js'
import { HttpError } from '../services/errors.js'
import { type ToolAccess, isToolVisible } from './tool-access.js'

export interface SseTool {
  name: string
  description: string
  inputSchema?: Record<string, unknown>
  access?: ToolAccess
  handler: (params: unknown, claims: TokenClaims) => Promise<unknown>
}

interface Session {
  transport: SSEServerTransport
  heartbeat: ReturnType<typeof setInterval>
}

/**
 * Manages MCP SSE sessions over the existing HTTP server.
 *
 * Each GET /mcp/sse creates one session (one Server + one SSEServerTransport)
 * with the token claims bound at connection time. POST /mcp/message routes
 * to the correct session by sessionId query param.
 */
export class McpSseManager {
  private readonly sessions = new Map<string, Session>()

  constructor(private readonly tools: SseTool[]) {}

  /**
   * Called from the HTTP server after auth is validated.
   * Creates the SSE session and starts streaming.
   */
  handleSse(req: IncomingMessage, res: ServerResponse, claims: TokenClaims): void {
    const transport = new SSEServerTransport('/mcp/message', res)
    const server = this.buildServer(claims)

    const heartbeat = setInterval(() => {
      // SSE comment keeps the connection alive through proxies/load balancers.
      res.write(': ping\n\n')
    }, 25_000)

    transport.onclose = () => {
      clearInterval(heartbeat)
      this.sessions.delete(transport.sessionId)
    }

    this.sessions.set(transport.sessionId, { transport, heartbeat })

    // connect() calls transport.start() which writes SSE headers and the
    // endpoint event. Must be last — after the session is registered — so
    // a fast client POST can't arrive before the session is in the map.
    server.connect(transport).catch((err: unknown) => {
      clearInterval(heartbeat)
      this.sessions.delete(transport.sessionId)
      console.error('[mcp-sse] connect error', err)
    })
  }

  /**
   * Called from the HTTP server for POST /mcp/message?sessionId=xxx.
   * Returns false if the session is not found (caller sends 404).
   */
  async handleMessage(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
  ): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    await session.transport.handlePostMessage(req, res)
    return true
  }

  get activeSessions(): number {
    return this.sessions.size
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
