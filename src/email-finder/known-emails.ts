import prisma from "../db/prisma";
import { normalizeName } from "./permutator";
import { namePartsFromSlug } from "./identity";

/**
 * The 168,523 addresses already in `profiles` — most of them paid for at another
 * provider — read back before we spend anything.
 *
 * 75.8% of recent searches land on a domain we already hold an address for, and
 * 7.4% were for a person whose address was already sitting in the table when the
 * search ran: $192 spent re-deriving answers we owned. The finder never looked,
 * because it only ever consulted `verification_cache` (13,194 rows).
 */

export interface KnownEmail {
  email: string;
  first: string;
  last: string;
  slug_parts: string[];
}

/**
 * Every address we hold at this domain, with the names attached.
 *
 * Backed by `profiles_email_domain_idx` on `split_part(lower(email),'@',2)` —
 * without it this is a sequential scan of the whole table on every search.
 * Capped because a handful of domains hold thousands of rows and the caller
 * only needs enough to recognize a person or infer a convention.
 */
export async function getKnownEmailsForDomain(
  domain: string,
  limit: number = 60
): Promise<KnownEmail[]> {
  try {
    const rows = await prisma.$queryRaw<
      { email: string; first_name: string | null; last_name: string | null; linkedin_slug: string | null }[]
    >`
      SELECT email,
             data->>'first_name' AS first_name,
             data->>'last_name'  AS last_name,
             linkedin_slug
      FROM profiles
      WHERE split_part(lower(email), '@', 2) = ${domain}
      LIMIT ${limit}
    `;

    return rows.map((r) => ({
      email: (r.email || "").toLowerCase(),
      first: r.first_name || "",
      last: r.last_name || "",
      slug_parts: r.linkedin_slug ? namePartsFromSlug(r.linkedin_slug) : [],
    }));
  } catch {
    // A cache read is never worth failing a search over.
    return [];
  }
}

/**
 * Is one of these rows the person we were asked about?
 *
 * Matching is on the given name plus *any* surname we resolved, which is what
 * makes it work for LATAM names: the row may be filed under the maternal
 * surname while the request carries the paternal one, or the other way round.
 */
export function matchPerson(
  known: KnownEmail[],
  first: string,
  surnames: string[]
): KnownEmail | null {
  const f = normalizeName(first);
  if (!f) return null;
  const wanted = new Set(
    surnames.flatMap((s) => s.split(/\s+/).map(normalizeName)).filter(Boolean)
  );
  if (wanted.size === 0) return null;

  for (const row of known) {
    const rowFirst = normalizeName((row.first || "").split(/\s+/)[0]);
    const rowNames = new Set(
      [
        ...(row.last || "").split(/\s+/).map(normalizeName),
        ...row.slug_parts,
      ].filter(Boolean)
    );
    const rowFirstFromSlug = row.slug_parts[0] || "";

    if (rowFirst !== f && rowFirstFromSlug !== f) continue;
    for (const w of wanted) {
      if (rowNames.has(w)) return row;
    }
  }

  return null;
}

/**
 * Is this exact address one we already hold?
 *
 * `/find` reads `profiles` before spending; `/verify` did not, so re-checking
 * an address this service itself delivered last week cost a paid call. An
 * address sitting in `profiles` reached us because a provider found it and
 * Clay stored it — that is a stronger signal than a fresh SMTP probe, and it
 * is free.
 */
export async function isKnownAddress(email: string): Promise<boolean> {
  try {
    const rows = await prisma.$queryRaw<{ one: number }[]>`
      SELECT 1 AS one FROM profiles WHERE lower(email) = ${email.toLowerCase()} LIMIT 1
    `;
    return rows.length > 0;
  } catch {
    return false;
  }
}
