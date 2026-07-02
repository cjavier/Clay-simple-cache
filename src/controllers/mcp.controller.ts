import { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer } from "../mcp/server";

export const mcpController = {
  /**
   * POST /mcp — JSON-RPC (MCP Streamable HTTP) entrypoint.
   *
   * Stateless: a brand-new McpServer + transport pair is created for every
   * request (sessionIdGenerator: undefined), so there is no session state to
   * keep across calls and no session id in the response. This matches how
   * this service already scales (each request is authenticated and handled
   * independently) and avoids leaking per-connection state across requests
   * on a horizontally-scaled deployment.
   */
  async handle(req: Request, res: Response): Promise<void> {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error: any) {
      console.error("MCP request handling error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  },

  /**
   * GET/DELETE /mcp — this server runs in stateless mode (no sessions), so
   * there is nothing to open an SSE stream on (GET) or tear down (DELETE).
   */
  methodNotAllowed(_req: Request, res: Response): void {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message:
          "Method not allowed: this MCP server is stateless (Streamable HTTP, POST-only JSON-RPC). " +
          "There is no session to open (GET) or close (DELETE).",
      },
      id: null,
    });
  },
};
