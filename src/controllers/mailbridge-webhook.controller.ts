import { Request, Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { ingestOutcomes, OutcomeRowInput } from "../email-finder/outcomes";

/**
 * Receiver for MailBridge's org-wide `email_outcomes` webhook.
 *
 * MailBridge sends the current state of every contact whose bounce, reply or
 * send history changed: one row per MailBridge contact. That state is what
 * teaches the finder which addresses exist (see email-finder/outcomes.ts).
 *
 * Authenticated by MailBridge's webhook signature, not by our API key:
 * `x-mailbridge-signature: sha256=HMAC_SHA256(secret, "${x-mailbridge-timestamp}.${raw body}")`,
 * with the timestamp in milliseconds. The secret lives in MAILBRIDGE_WEBHOOK_SECRET.
 */

export const OUTCOMES_EVENT = "email_outcomes";
// MailBridge stamps a fresh timestamp on every delivery attempt, so a retry is not penalised.
export const MAX_SKEW_MS = 5 * 60 * 1000;

export interface MailbridgeOutcomeRow {
  contact_id: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  linkedin_url?: string | null;
  bounced_at?: string | null;
  bounce_type?: string | null;
  human_replied_at?: string | null;
  positive_replied_at?: string | null;
  auto_replied?: boolean | null;
  first_visible_send_at?: string | null;
}

export function verifySignature(
  secret: string,
  timestamp: string | undefined,
  rawBody: Buffer | undefined,
  signature: string | undefined,
  now: number = Date.now()
): boolean {
  if (!timestamp || !rawBody || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_SKEW_MS) return false;
  const expected =
    "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${rawBody.toString("utf8")}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function toOutcomeRows(rows: MailbridgeOutcomeRow[]): OutcomeRowInput[] {
  return rows.map((r) => ({
    source: "mailbridge",
    source_ref: r.contact_id,
    email: r.email,
    first_name: r.first_name,
    last_name: r.last_name,
    linkedin_url: r.linkedin_url,
    bounced_at: r.bounced_at,
    bounce_type: r.bounce_type,
    // Only the human and positive replies: MailBridge's plain `replied_at`
    // also counts threads classified as a missed bounce.
    replied_at: r.human_replied_at,
    positive_at: r.positive_replied_at,
    auto_replied: r.auto_replied,
    first_visible_send_at: r.first_visible_send_at,
  }));
}

export const mailbridgeWebhookController = {
  async receive(req: Request, res: Response) {
    const secret = process.env.MAILBRIDGE_WEBHOOK_SECRET;
    if (!secret) {
      res.status(503).json({ error: "MAILBRIDGE_WEBHOOK_SECRET is not configured" });
      return;
    }
    const ok = verifySignature(
      secret,
      req.header("x-mailbridge-timestamp"),
      (req as any).rawBody,
      req.header("x-mailbridge-signature")
    );
    if (!ok) {
      res.status(401).json({ error: "invalid signature" });
      return;
    }

    const body = req.body || {};
    if (body.event_type !== OUTCOMES_EVENT) {
      // Subscribed to something we don't use: acknowledge so MailBridge doesn't retry.
      res.json({ ok: true, ignored: body.event_type ?? null });
      return;
    }
    const rows: MailbridgeOutcomeRow[] = Array.isArray(body.data?.rows) ? body.data.rows : [];
    try {
      const result = await ingestOutcomes(toOutcomeRows(rows));
      res.json({ ok: true, ...result });
    } catch (err: any) {
      console.error("MailBridge outcomes ingest failed:", err?.message || err);
      // 5xx so MailBridge retries with backoff.
      res.status(500).json({ error: "ingest failed" });
    }
  },
};
