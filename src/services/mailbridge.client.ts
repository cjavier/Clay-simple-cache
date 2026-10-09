/**
 * Thin REST client for MailBridge (the agency's inbox/CRM, repo sistema-outbound).
 *
 * Only what the list builder needs: resolve a client, name and create its
 * tables, and upsert rows into them. Auth is MailBridge's `x-api-key`; the key
 * must be agency-wide (or scoped to the client) — a key scoped to another
 * client gets 404 on the table, never someone else's data.
 */

const DEFAULT_URL = "https://api-production-0f81.up.railway.app";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class MailBridgeError extends Error {
  constructor(
    message: string,
    /** HTTP status MailBridge answered with; 0 when it never answered. */
    public readonly status: number,
  ) {
    super(message);
    this.name = "MailBridgeError";
  }

  /** Worth retrying later: MailBridge down, deploying, or rate-limiting us. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export interface MailBridgeClient {
  id: string;
  name: string;
}

export interface UpsertRow {
  ref: string;
  data: Record<string, unknown>;
  sources?: Record<string, string>;
}

export function mailbridgeConfigured(): boolean {
  return Boolean(process.env.MAILBRIDGE_API_KEY);
}

async function call<T>(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
  const key = process.env.MAILBRIDGE_API_KEY;
  if (!key) throw new MailBridgeError("MAILBRIDGE_API_KEY is not set", 0);
  const base = (process.env.MAILBRIDGE_API_URL || DEFAULT_URL).replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(base + path, {
      method,
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: any) {
    throw new MailBridgeError(`MailBridge ${method} ${path} did not answer: ${err?.message || err}`, 0);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new MailBridgeError(`MailBridge ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export const mailbridge = {
  /** A client by UUID, or by its exact name (case-insensitive). Ambiguity is an error, not a guess. */
  async resolveClient(ref: string): Promise<MailBridgeClient> {
    if (UUID.test(ref)) {
      const c = await call<any>("GET", `/clients/${ref}`);
      return { id: c.id, name: c.name };
    }
    const d = await call<any>("GET", `/clients?search=${encodeURIComponent(ref)}`);
    const list: any[] = d?.data || d?.clients || (Array.isArray(d) ? d : []);
    const exact = list.filter((c) => String(c?.name || "").trim().toLowerCase() === ref.trim().toLowerCase());
    if (exact.length !== 1) {
      const names = list.map((c) => c?.name).filter(Boolean);
      throw new MailBridgeError(
        `MailBridge client '${ref}' ${exact.length ? "is ambiguous" : "has no exact match"}${names.length ? ` (similar: ${names.join(", ")})` : ""}; pass its exact name or UUID`,
        404,
      );
    }
    return { id: exact[0].id, name: exact[0].name };
  },

  async tableNames(clientId: string): Promise<Set<string>> {
    const d = await call<any>("GET", `/tables?clientId=${clientId}`);
    return new Set((d?.tables || []).map((t: any) => t.name));
  },

  async createTable(clientId: string, name: string, sourceConfig: Record<string, unknown>): Promise<{ id: string; name: string }> {
    const t = await call<any>("POST", "/tables", {
      clientId,
      name,
      // `webhook` is MailBridge's source for "rows arrive from outside"; no
      // auto-run so no paid enrichment column fires on rows we just paid for.
      sourceKind: "webhook",
      autoRun: false,
      sourceConfig,
    });
    return { id: t.id, name: t.name };
  },

  /** Upsert by `ref`: resending a batch updates the same rows instead of duplicating them. */
  async upsertRows(tableId: string, rows: UpsertRow[]): Promise<{ inserted: number; updated: number; rowCount: number }> {
    const r = await call<any>("POST", `/tables/${tableId}/rows`, { rows }, 120_000);
    return { inserted: r.inserted ?? 0, updated: r.updated ?? 0, rowCount: r.rowCount ?? 0 };
  },

  async tableRowCount(tableId: string): Promise<number> {
    const t = await call<any>("GET", `/tables/${tableId}`);
    return t?.rowCount ?? 0;
  },
};
