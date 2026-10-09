import { Blitz, blitzConfigured } from "../blitz.client";
import { junkReason } from "../table-build";
import { isPersonalEmail } from "./cache";

/**
 * The only email finder this cache still calls on its own: Blitz, which is
 * free on our flat plan (an email not found costs 0). Paid finders (Prospeo,
 * Findymail) and validators run as columns of MailBridge's people tables.
 */

export interface CascadePerson {
  linkedin_url?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  company_domain?: string | null;
  company_name?: string | null;
}

export { blitzConfigured };

export function bareDomain(v: string | null | undefined): string {
  return String(v || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#:]/)[0] || "";
}

export function fullName(p: CascadePerson): string {
  return (p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ")).trim();
}

/** A usable address: has an @, isn't masked, isn't junk (rule 5). */
export function usable(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const e = email.trim().toLowerCase();
  if (!e.includes("@") || e.includes("*")) return null;
  return junkReason(e) || isPersonalEmail(e) ? null : e;
}

let sharedBlitz: Promise<Blitz> | null = null;
/** One client for every build, so all of them share the plan's rate limit. */
export function blitzClient(): Promise<Blitz> {
  sharedBlitz ??= new Blitz().init().catch((e) => {
    sharedBlitz = null;
    throw e;
  });
  return sharedBlitz;
}
