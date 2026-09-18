import dns from "dns";
import { promisify } from "util";
import prisma from "../db/prisma";
import { config } from "./config";
import { DomainInfo, ProviderType } from "./types";
import { checkDisposable, checkFreeProvider } from "./static-lists";

const resolveMx = promisify(dns.resolveMx);

function detectProvider(mxRecords: string[]): ProviderType {
  const lowered = mxRecords.map((mx) => mx.toLowerCase());

  for (const mx of lowered) {
    if (mx.includes("google.com") || mx.includes("googlemail.com"))
      return ProviderType.google_workspace;
  }
  for (const mx of lowered) {
    if (
      mx.includes("outlook.com") ||
      mx.includes("protection.outlook.com") ||
      mx.includes("microsoft.com")
    )
      return ProviderType.office365;
  }
  for (const mx of lowered) {
    if (mx.includes("yahoo.com") || mx.includes("yahoodns.net"))
      return ProviderType.yahoo;
  }
  return ProviderType.other;
}

export async function analyzeDomain(domain: string): Promise<DomainInfo> {
  // 1. Check cache
  const cached = await prisma.domainIntel.findUnique({
    where: { domain },
  });

  if (cached && cached.expires_at > new Date()) {
    return {
      domain: cached.domain,
      has_mx: cached.has_mx,
      mx_records: cached.mx_records as string[],
      provider: cached.provider as ProviderType,
      is_catch_all: cached.is_catch_all,
      is_disposable: cached.is_disposable,
      is_free_provider: cached.is_free_provider,
      smtp_verifiable: cached.provider === "other",
    };
  }

  // 2. MX Lookup
  let mxRecords: string[] = [];
  let hasMx = false;

  try {
    const records = await resolveMx(domain);
    records.sort((a, b) => a.priority - b.priority);
    mxRecords = records.map((r) => r.exchange.replace(/\.$/, ""));
    hasMx = mxRecords.length > 0;
  } catch {
    hasMx = false;
  }

  // 3. Detect provider
  const provider = detectProvider(mxRecords);

  // 4-5. Static checks
  const isDisposable = checkDisposable(domain);
  const isFreeProvider = checkFreeProvider(domain);

  // 6. SMTP verifiable
  const smtpVerifiable = provider === ProviderType.other;

  const expiresAt = new Date(Date.now() + config.domain_cache_ttl * 1000);

  // `is_catch_all` is discovered by the verifier, not by DNS — so a refresh of
  // the MX facts must not erase it. Writing `false` here unconditionally is why
  // all 63,291 rows in `domain_intel` said `false`: the column existed, was
  // read by the pipeline, and could never become true. Every search on a known
  // catch-all domain re-discovered it from scratch, five paid calls at a time.
  const isCatchAll = cached?.is_catch_all ?? false;

  // 7. Cache in DB (upsert)
  await prisma.domainIntel.upsert({
    where: { domain },
    update: {
      has_mx: hasMx,
      mx_records: mxRecords,
      provider,
      is_disposable: isDisposable,
      is_free_provider: isFreeProvider,
      checked_at: new Date(),
      expires_at: expiresAt,
    },
    create: {
      domain,
      has_mx: hasMx,
      mx_records: mxRecords,
      provider,
      is_catch_all: false,
      is_disposable: isDisposable,
      is_free_provider: isFreeProvider,
      checked_at: new Date(),
      expires_at: expiresAt,
    },
  });

  return {
    domain,
    has_mx: hasMx,
    mx_records: mxRecords,
    provider,
    is_catch_all: isCatchAll,
    is_disposable: isDisposable,
    is_free_provider: isFreeProvider,
    smtp_verifiable: smtpVerifiable,
  };
}

/**
 * Persist what the verifier just told us about the domain.
 *
 * Called the first time a candidate at this domain comes back `catch_all`.
 * From then on the pipeline knows, before spending anything, that probing
 * individual addresses here cannot discriminate — a catch-all server accepts
 * every local part by definition — and goes straight to the domain's pattern
 * instead of buying five identical "yes".
 */
export async function markDomainCatchAll(domain: string): Promise<void> {
  try {
    await prisma.domainIntel.updateMany({
      where: { domain },
      data: { is_catch_all: true },
    });
  } catch {
    // Learning is a side effect; never fail a search over it.
  }
}
