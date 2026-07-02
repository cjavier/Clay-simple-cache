import { describe, it, expect, vi, beforeAll } from "vitest";
import request from "supertest";

vi.mock("../../src/services/client.service", () => ({
  clientService: {
    listClients: vi.fn(),
    findByHandle: vi.fn(),
    createClient: vi.fn(),
    suggestHandles: vi.fn(),
  },
}));

import app from "../../src/app";
import { clientService } from "../../src/services/client.service";

const mockClientService = clientService as unknown as {
  listClients: ReturnType<typeof vi.fn>;
  findByHandle: ReturnType<typeof vi.fn>;
  createClient: ReturnType<typeof vi.fn>;
  suggestHandles: ReturnType<typeof vi.fn>;
};

const API_KEY = "test-mcp-key";

// The Streamable HTTP transport requires both media types on Accept, and a
// JSON Content-Type on every POST.
const MCP_HEADERS = {
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
};

function initializeBody(id: number = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    },
  };
}

describe("MCP server (POST /mcp, GET /llms.txt)", () => {
  beforeAll(() => {
    process.env.API_KEY = API_KEY;
  });

  it("rejects POST /mcp without an Authorization header (401)", async () => {
    const res = await request(app).post("/mcp").set(MCP_HEADERS).send(initializeBody());

    expect(res.status).toBe(401);
  });

  it("responds to the initialize handshake with serverInfo", async () => {
    const res = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${API_KEY}`)
      .set(MCP_HEADERS)
      .send(initializeBody());

    expect(res.status).toBe(200);
    expect(res.body.jsonrpc).toBe("2.0");
    expect(res.body.result.serverInfo).toMatchObject({ name: "clay-cache" });
    expect(typeof res.body.result.serverInfo.version).toBe("string");
  });

  it("tools/list returns all 16 registered tools", async () => {
    const res = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${API_KEY}`)
      .set(MCP_HEADERS)
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

    expect(res.status).toBe(200);
    const tools = res.body.result.tools;
    expect(tools).toHaveLength(16);

    const names = tools.map((t: any) => t.name).sort();
    expect(names).toEqual(
      [
        "create_client",
        "detect_tech",
        "dnc_add",
        "dnc_check",
        "dnc_list",
        "explore",
        "find_email",
        "find_linkedin",
        "generate_copy",
        "get_company",
        "get_profile",
        "get_stats",
        "list_clients",
        "upsert_company",
        "upsert_profile",
        "verify_email",
      ].sort()
    );

    // Every tool should carry a non-trivial, prescriptive description.
    for (const tool of tools) {
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });

  it("tools/call list_clients returns the mocked service's JSON", async () => {
    mockClientService.listClients.mockResolvedValue([
      { id: "cl1", handle: "acme", name: "Acme", data: {}, created_at: new Date(), updated_at: new Date() },
    ]);

    const res = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${API_KEY}`)
      .set(MCP_HEADERS)
      .send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "list_clients", arguments: {} },
      });

    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBeFalsy();
    const payload = JSON.parse(res.body.result.content[0].text);
    expect(payload.result).toBe(1);
    expect(payload.clients).toHaveLength(1);
    expect(payload.clients[0].handle).toBe("acme");
    expect(mockClientService.listClients).toHaveBeenCalled();
  });

  it("tools/call surfaces business errors as isError text, not a stack trace", async () => {
    const res = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${API_KEY}`)
      .set(MCP_HEADERS)
      .send({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "find_email", arguments: { domain: "empresa.com" } },
      });

    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.content[0].text).toMatch(/first_name|last_name|full_name/);
    expect(res.body.result.content[0].text).not.toMatch(/at Object|node_modules|\.ts:\d+/);
  });

  it("GET /mcp returns 405 (stateless — nothing to open a session on)", async () => {
    const res = await request(app).get("/mcp").set("Authorization", `Bearer ${API_KEY}`);

    expect(res.status).toBe(405);
    expect(res.body.error).toBeDefined();
  });

  it("DELETE /mcp returns 405 (stateless — no session to close)", async () => {
    const res = await request(app).delete("/mcp").set("Authorization", `Bearer ${API_KEY}`);

    expect(res.status).toBe(405);
  });

  it("GET /llms.txt returns 200 text/plain without auth and mentions /mcp", async () => {
    const res = await request(app).get("/llms.txt");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.text).toContain("/mcp");
    expect(res.text).toContain("find_email");
    expect(res.text).toContain("dnc_check");
  });
});
