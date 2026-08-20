import fs from "fs";
import path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import prisma from "../db/prisma";
import { checkAllCredits } from "../services/credit-monitor.service";
import { Client, DncListType } from "../types";
import {
  normalizeEmail,
  normalizeLinkedIn,
  normalizePhone,
  normalizeDomain,
  slugifyHandle,
} from "../services/normalization";
import { profileService } from "../services/profile.service";
import { companyService } from "../services/company.service";
import { dncService } from "../services/dnc.service";
import { clientService } from "../services/client.service";
import { findEmail, verifySingleEmail } from "../email-finder";
import { detectTechnologies, FetchFailError } from "../services/tech-detector.service";
import { findLinkedInForDomain } from "../services/linkedin-finder.service";
import { DeepSeekApiError, DeepSeekConfigError } from "../services/deepseek.service";
import { runExploreAgent } from "../services/explore-agent.service";
import { generateCopy } from "../services/copy.service";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface ToolTextResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

function ok(data: unknown): ToolTextResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function fail(message: string): ToolTextResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Wraps a tool handler so any thrown error becomes a clean `isError` text
 * result (message only — never a stack trace) instead of crashing the
 * MCP request.
 */
function safe<Args>(
  fn: (args: Args) => Promise<ToolTextResult>
): (args: Args) => Promise<ToolTextResult> {
  return async (args: Args) => {
    try {
      return await fn(args);
    } catch (error: any) {
      console.error("MCP tool error:", error);
      return fail(error?.message || "Internal error while running this tool.");
    }
  };
}

/** Resolve a client handle, or a useful error message (with suggestions) if not found. */
async function findClientOrError(
  rawHandle: unknown
): Promise<{ client: Client } | { error: string }> {
  if (!rawHandle || typeof rawHandle !== "string" || !rawHandle.trim()) {
    return { error: "client handle is required." };
  }
  const handle = slugifyHandle(rawHandle);
  const client = await clientService.findByHandle(handle);
  if (!client) {
    const suggestions = await clientService.suggestHandles(handle);
    return {
      error:
        `client_not_found: no client with handle "${handle}".` +
        (suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : ""),
    };
  }
  return { client };
}

function readPackageVersion(): string {
  try {
    const pkgPath = path.join(__dirname, "../../package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ---------------------------------------------------------------------------
// buildMcpServer
// ---------------------------------------------------------------------------

export function buildMcpServer(): McpServer {
  const server = new McpServer({
    name: "clay-cache",
    version: readPackageVersion(),
  });

  // -- find_email ------------------------------------------------------------
  server.registerTool(
    "find_email",
    {
      title: "Find Email",
      description:
        "Find and verify the most likely email address for a person at a company domain. " +
        "Use this when you know a person's name and their company's domain but not their email. " +
        "This spends real money per call (SERP + email verification providers) — prefer get_profile first " +
        "to check the cache. Pass dnc_client to gate the call behind that client's Do Not Contact list: the " +
        "domain is checked BEFORE spending money, and the found email is checked again before returning it.",
      inputSchema: {
        first_name: z.string().optional().describe("Person's first name. At least one of first_name/last_name/full_name is required."),
        last_name: z.string().optional().describe("Person's last name."),
        full_name: z.string().optional().describe("Person's full name (parsed with LATAM-aware name-splitting logic)."),
        domain: z.string().describe("Company domain to search, e.g. 'empresa.com'. Required."),
        max_tier: z.number().int().min(1).max(2).optional().describe("Max verification tier to use (1 or 2). Default 2."),
        dnc_client: z
          .string()
          .optional()
          .describe(
            "Client handle. When set, this call is refused before spending money if the domain is on that " +
              "client's Do Not Contact list, and refused again if the found email is blocked."
          ),
      },
      annotations: {
        title: "Find Email",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    safe(async ({ first_name, last_name, full_name, domain, max_tier, dnc_client }) => {
      if (!domain) return fail("domain is required");
      if (!first_name && !last_name && !full_name) {
        return fail("At least one of first_name, last_name, or full_name is required");
      }

      let dncClientId: string | undefined;
      const dncRequested = !!dnc_client;
      if (dncRequested) {
        const resolved = await findClientOrError(dnc_client);
        if ("error" in resolved) return fail(resolved.error);
        dncClientId = resolved.client.id;

        const domainCheck = await dncService.checkDomain(dncClientId, domain);
        if (domainCheck.do_not_contact) {
          return ok({ do_not_contact: true, matched_by: domainCheck.matched_by });
        }
      }

      const result = await findEmail({
        first_name,
        last_name,
        domain,
        full_name,
        max_tier: max_tier || 2,
      });

      if (dncClientId && result.email) {
        const emailCheck = await dncService.check(dncClientId, result.email);
        if (emailCheck.do_not_contact) {
          return ok({ do_not_contact: true, matched_by: emailCheck.matched_by });
        }
      }

      return ok({
        success: true,
        email: result.email,
        status: result.status,
        confidence: result.confidence,
        method: result.method,
        pattern: result.pattern,
        domain_info: result.domain_info,
        serp_info: result.serp_info,
        permutations_tried: result.permutations_tried,
        cost_usd: result.cost_usd,
        duration_ms: result.duration_ms,
        ...(dncRequested ? { do_not_contact: false } : {}),
      });
    })
  );

  // -- verify_email ------------------------------------------------------------
  server.registerTool(
    "verify_email",
    {
      title: "Verify Email",
      description:
        "Verify the deliverability of an email address you already have. Use this instead of find_email " +
        "when you already have a candidate email and just need to confirm it's valid. Costs real money per " +
        "call. Pass dnc_client to refuse the call if the email is on that client's Do Not Contact list.",
      inputSchema: {
        email: z.string().describe("The email address to verify. Required."),
        max_tier: z.number().int().min(1).max(2).optional().describe("Max verification tier to use (1 or 2). Default 2."),
        dnc_client: z.string().optional().describe("Client handle to gate this check behind that client's Do Not Contact list."),
      },
      annotations: {
        title: "Verify Email",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    safe(async ({ email, max_tier, dnc_client }) => {
      if (!email) return fail("email is required");

      const dncRequested = !!dnc_client;
      if (dncRequested) {
        const resolved = await findClientOrError(dnc_client);
        if ("error" in resolved) return fail(resolved.error);
        const emailCheck = await dncService.check(resolved.client.id, email);
        if (emailCheck.do_not_contact) {
          return ok({ do_not_contact: true, matched_by: emailCheck.matched_by });
        }
      }

      const result = await verifySingleEmail(email, max_tier || 2);

      return ok({
        email: result.email,
        status: result.status,
        confidence: result.confidence,
        method: result.method,
        domain_info: result.domain_info,
        cost_usd: result.cost_usd,
        duration_ms: result.duration_ms,
        ...(dncRequested ? { do_not_contact: false } : {}),
      });
    })
  );

  // -- get_profile ------------------------------------------------------------
  server.registerTool(
    "get_profile",
    {
      title: "Get Profile",
      description:
        "Read-only lookup of a cached person profile by email, LinkedIn (URL or slug), or phone. " +
        "Use this FIRST, before find_email or any paid enrichment call, to check whether the contact is " +
        "already known. Pass dnc_client to also gate the result behind that client's Do Not Contact list.",
      inputSchema: {
        email: z.string().optional().describe("Email to look up."),
        linkedin: z.string().optional().describe("LinkedIn profile URL or slug to look up."),
        phone: z.string().optional().describe("Phone number to look up (any format; normalized to E.164)."),
        dnc_client: z
          .string()
          .optional()
          .describe(
            "Client handle. When set and the contact is on that client's Do Not Contact list, the response " +
              "is only {do_not_contact:true,...} — no profile data is returned."
          ),
      },
      annotations: {
        title: "Get Profile",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    safe(async ({ email, linkedin, phone, dnc_client }) => {
      if (!email && !linkedin && !phone) {
        return fail("At least one of email, linkedin, or phone is required.");
      }

      const normalizedEmail = email ? normalizeEmail(email) : undefined;

      let linkedinUrl: string | undefined;
      let linkedinSlug: string | undefined;
      if (linkedin) {
        if (linkedin.includes("linkedin.com/")) linkedinUrl = linkedin;
        linkedinSlug = normalizeLinkedIn(linkedin) || undefined;
      }

      let phoneE164: string | undefined;
      if (phone) {
        const p = normalizePhone(phone);
        if (p) phoneE164 = p.e164;
      }

      const { profile } = await profileService.findProfile({
        email: normalizedEmail,
        linkedin_url: linkedinUrl,
        linkedin_slug: linkedinSlug,
        phone_e164: phoneE164,
      });

      const dncRequested = !!dnc_client;
      if (dncRequested) {
        const resolved = await findClientOrError(dnc_client);
        if ("error" in resolved) return fail(resolved.error);

        const emailToCheck = normalizedEmail || profile?.email || undefined;
        if (emailToCheck) {
          const dncResult = await dncService.check(resolved.client.id, emailToCheck);
          if (dncResult.do_not_contact) {
            return ok({ do_not_contact: true, matched_by: dncResult.matched_by });
          }
        }
      }

      if (!profile) {
        return ok({
          result: null,
          message: "No records found",
          search_criteria: {
            email: normalizedEmail,
            linkedin_url: linkedinUrl,
            linkedin_slug: linkedinSlug,
            phone_e164: phoneE164,
          },
          ...(dncRequested ? { do_not_contact: false } : {}),
        });
      }

      return ok({
        result: 1,
        ...(profile.data as object),
        id: profile.id,
        email: profile.email,
        linkedin_slug: profile.linkedin_slug,
        phone: profile.phone_e164,
        updated_at: profile.updated_at,
        ...(dncRequested ? { do_not_contact: false } : {}),
      });
    })
  );

  // -- upsert_profile ------------------------------------------------------------
  server.registerTool(
    "upsert_profile",
    {
      title: "Upsert Profile",
      description:
        "Save or enrich a person profile in the cache. Looks up an existing record by any provided " +
        "identifier (priority: email > linkedin_url > linkedin_slug > phone) and merges new fields into it, " +
        "or creates a new profile. Use this to persist enrichment data (title, company, etc.) you've gathered " +
        "so future lookups (get_profile) are free cache hits instead of paid re-enrichment.",
      inputSchema: {
        email: z.string().optional().describe("Person's email. At least one of email/linkedin_url/phone is required."),
        linkedin_url: z.string().optional().describe("Full LinkedIn profile URL."),
        phone: z.string().optional().describe("Phone number (any format; normalized to E.164)."),
        data: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Free-form object of extra fields to store/merge (e.g. {title, company, seniority})."),
      },
      annotations: {
        title: "Upsert Profile",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    safe(async ({ email, linkedin_url, phone, data }) => {
      const extraData = (data ?? {}) as Record<string, unknown>;

      const normalizedEmail = email ? normalizeEmail(email) : null;
      const normalizedLinkedin = linkedin_url ? normalizeLinkedIn(linkedin_url) : null;
      const normalizedPhone = phone ? normalizePhone(phone) : null;
      const fullLinkedinUrl = linkedin_url;

      if (!normalizedEmail && !normalizedLinkedin && !normalizedPhone) {
        return fail("At least one identity key (email, linkedin_url, phone) is required.");
      }

      const identityKeys = {
        email: normalizedEmail || undefined,
        linkedin_slug: normalizedLinkedin || undefined,
        linkedin_url: fullLinkedinUrl || undefined,
        phone_e164: normalizedPhone?.e164 || undefined,
      };

      const { profile: existingProfile, resolvedBy } = await profileService.findProfile(identityKeys);

      let finalProfileId: string | undefined;
      let resolutionType: string | null | undefined;

      const mergedExtra = {
        ...extraData,
        ...(fullLinkedinUrl ? { linkedin_url: fullLinkedinUrl } : {}),
        ...(normalizedPhone?.national ? { phone_national: normalizedPhone.national } : {}),
      };

      if (existingProfile) {
        const updates: any = {};
        if (normalizedEmail && !existingProfile.email) updates.email = normalizedEmail;
        if (normalizedLinkedin && !existingProfile.linkedin_slug) updates.linkedin_slug = normalizedLinkedin;
        if (fullLinkedinUrl && !existingProfile.linkedin_url) updates.linkedin_url = fullLinkedinUrl;
        if (normalizedPhone?.e164 && !existingProfile.phone_e164) updates.phone_e164 = normalizedPhone.e164;
        updates.data = profileService.mergeData(existingProfile.data, mergedExtra);

        if (Object.keys(updates).length > 0) {
          try {
            await profileService.updateProfile(existingProfile.id, updates);
          } catch (error: any) {
            if (error?.code === "P2002") {
              const { profile: refreshed, resolvedBy: refreshedResolvedBy } = await profileService.findProfile(identityKeys);
              if (!refreshed) throw error;
              resolutionType = refreshedResolvedBy || resolvedBy;
              finalProfileId = refreshed.id;
            } else {
              throw error;
            }
          }
        }

        if (finalProfileId === undefined) {
          finalProfileId = existingProfile.id;
          resolutionType = resolvedBy;
        }
      } else {
        try {
          const newProfile = await profileService.createProfile({
            email: normalizedEmail,
            linkedin_slug: normalizedLinkedin,
            linkedin_url: fullLinkedinUrl,
            phone_e164: normalizedPhone?.e164,
            data: mergedExtra,
          });
          finalProfileId = newProfile.id;
          resolutionType = "new";
        } catch (error: any) {
          if (error?.code === "P2002") {
            const { profile: raceProfile, resolvedBy: raceResolvedBy } = await profileService.findProfile(identityKeys);
            if (!raceProfile) throw error;

            const raceUpdates: any = {};
            if (normalizedEmail && !raceProfile.email) raceUpdates.email = normalizedEmail;
            if (normalizedLinkedin && !raceProfile.linkedin_slug) raceUpdates.linkedin_slug = normalizedLinkedin;
            if (fullLinkedinUrl && !raceProfile.linkedin_url) raceUpdates.linkedin_url = fullLinkedinUrl;
            if (normalizedPhone?.e164 && !raceProfile.phone_e164) raceUpdates.phone_e164 = normalizedPhone.e164;
            raceUpdates.data = profileService.mergeData(raceProfile.data, mergedExtra);

            let mergedProfile = raceProfile;
            try {
              mergedProfile = await profileService.updateProfile(raceProfile.id, raceUpdates);
            } catch (mergeError: any) {
              if (mergeError?.code !== "P2002") throw mergeError;
            }

            finalProfileId = mergedProfile.id;
            resolutionType = raceResolvedBy || "race";
          } else {
            throw error;
          }
        }
      }

      return ok({
        status: "ok",
        resolved_by: resolutionType,
        profile_id: finalProfileId,
        saved_data: {
          id: finalProfileId,
          email: normalizedEmail,
          linkedin_slug: normalizedLinkedin,
          linkedin_url: fullLinkedinUrl,
          phone_e164: normalizedPhone?.e164,
          data: mergedExtra,
        },
      });
    })
  );

  // -- get_company ------------------------------------------------------------
  server.registerTool(
    "get_company",
    {
      title: "Get Company",
      description:
        "Read-only lookup of a cached company by domain or LinkedIn slug. Use this before detect_tech or " +
        "find_linkedin to check whether the company is already enriched. Pass dnc_client to also gate the " +
        "result behind that client's Do Not Contact list (checked against the company's domain).",
      inputSchema: {
        domain: z.string().optional().describe("Company domain to look up."),
        linkedin_slug: z.string().optional().describe("Company LinkedIn slug or URL to look up."),
        dnc_client: z
          .string()
          .optional()
          .describe(
            "Client handle. When set and the company's domain is on that client's Do Not Contact list, the " +
              "response is only {do_not_contact:true,...}."
          ),
      },
      annotations: {
        title: "Get Company",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    safe(async ({ domain, linkedin_slug, dnc_client }) => {
      const normalizedDomain = domain ? normalizeDomain(domain) || undefined : undefined;
      const normalizedLinkedin = linkedin_slug ? normalizeLinkedIn(linkedin_slug) || undefined : undefined;

      const { company } = await companyService.findCompany({
        domain: normalizedDomain,
        linkedin_slug: normalizedLinkedin,
      });

      const dncRequested = !!dnc_client;
      if (dncRequested) {
        const resolved = await findClientOrError(dnc_client);
        if ("error" in resolved) return fail(resolved.error);

        const domainToCheck = normalizedDomain || company?.domain || undefined;
        if (domainToCheck) {
          const dncResult = await dncService.checkDomain(resolved.client.id, domainToCheck);
          if (dncResult.do_not_contact) {
            return ok({ do_not_contact: true, matched_by: dncResult.matched_by });
          }
        }
      }

      if (!company) {
        return ok({
          result: null,
          message: "No records found",
          search_criteria: { domain: normalizedDomain, linkedin_slug: normalizedLinkedin },
          ...(dncRequested ? { do_not_contact: false } : {}),
        });
      }

      return ok({
        result: 1,
        ...(company.data as object),
        id: company.id,
        domain: company.domain,
        linkedin_slug: company.linkedin_slug,
        updated_at: company.updated_at,
        ...(dncRequested ? { do_not_contact: false } : {}),
      });
    })
  );

  // -- upsert_company ------------------------------------------------------------
  server.registerTool(
    "upsert_company",
    {
      title: "Upsert Company",
      description:
        "Save or enrich a company in the cache. Looks up an existing record by domain or LinkedIn slug and " +
        "merges new fields into it, or creates a new company. Use this to persist enrichment data (industry, " +
        "employee count, tech stack, etc.) so future lookups (get_company) are free cache hits.",
      inputSchema: {
        domain: z.string().optional().describe("Company domain. At least one of domain/linkedin_slug is required."),
        linkedin_slug: z.string().optional().describe("Company LinkedIn slug or full URL."),
        data: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Free-form object of extra fields to store/merge (e.g. {industry, employee_count})."),
      },
      annotations: {
        title: "Upsert Company",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    safe(async ({ domain, linkedin_slug, data }) => {
      const extraData = (data ?? {}) as Record<string, unknown>;

      const normalizedDomain = domain ? normalizeDomain(domain) : null;
      const normalizedLinkedin = linkedin_slug ? normalizeLinkedIn(linkedin_slug) : null;

      if (!normalizedDomain && !normalizedLinkedin) {
        return fail("At least one identifier (domain, linkedin_slug) is required.");
      }

      const identityKeys = {
        domain: normalizedDomain || undefined,
        linkedin_slug: normalizedLinkedin || undefined,
      };

      const { company: existingCompany, resolved_by } = await companyService.findCompany(identityKeys);

      let finalCompanyId: string | undefined;
      let resolutionType: string | undefined;

      const mergedExtra = {
        ...extraData,
        ...(linkedin_slug ? { linkedin_url: linkedin_slug } : {}),
      };

      if (existingCompany) {
        const updates: any = {};
        if (normalizedDomain && !existingCompany.domain) updates.domain = normalizedDomain;
        if (normalizedLinkedin && !existingCompany.linkedin_slug) updates.linkedin_slug = normalizedLinkedin;
        updates.data = companyService.mergeData(existingCompany.data, mergedExtra);

        if (Object.keys(updates).length > 0) {
          try {
            await companyService.updateCompany(existingCompany.id, updates);
          } catch (error: any) {
            if (error?.code === "P2002") {
              const { company: refreshed, resolved_by: refreshedResolvedBy } = await companyService.findCompany(identityKeys);
              if (!refreshed) throw error;
              resolutionType = refreshedResolvedBy || resolved_by;
              finalCompanyId = refreshed.id;
            } else {
              throw error;
            }
          }
        }

        if (finalCompanyId === undefined) {
          finalCompanyId = existingCompany.id;
          resolutionType = resolved_by;
        }
      } else {
        try {
          const newCompany = await companyService.createCompany({
            domain: normalizedDomain,
            linkedin_slug: normalizedLinkedin,
            data: mergedExtra,
          });
          finalCompanyId = newCompany.id;
          resolutionType = "new";
        } catch (error: any) {
          if (error?.code === "P2002") {
            const { company: raceCompany, resolved_by: raceResolvedBy } = await companyService.findCompany(identityKeys);
            if (!raceCompany) throw error;

            const raceUpdates: any = {};
            if (normalizedDomain && !raceCompany.domain) raceUpdates.domain = normalizedDomain;
            if (normalizedLinkedin && !raceCompany.linkedin_slug) raceUpdates.linkedin_slug = normalizedLinkedin;
            raceUpdates.data = companyService.mergeData(raceCompany.data, mergedExtra);

            let mergedCompany = raceCompany;
            try {
              mergedCompany = await companyService.updateCompany(raceCompany.id, raceUpdates);
            } catch (mergeError: any) {
              if (mergeError?.code !== "P2002") throw mergeError;
            }

            finalCompanyId = mergedCompany.id;
            resolutionType = raceResolvedBy || "race";
          } else {
            throw error;
          }
        }
      }

      return ok({
        status: "ok",
        resolved_by: resolutionType,
        company_id: finalCompanyId,
        saved_data: {
          id: finalCompanyId,
          domain: normalizedDomain,
          linkedin_slug: normalizedLinkedin,
          data: mergedExtra,
        },
      });
    })
  );

  // -- detect_tech ------------------------------------------------------------
  server.registerTool(
    "detect_tech",
    {
      title: "Detect Tech",
      description:
        "Fetch a URL and fingerprint the site's technology stack (CMS, ecommerce platform, analytics, tag " +
        "managers, marketing/CRM tools, advertising pixels, payments, CDN, SEO plugins, privacy tools). Use " +
        "this to qualify a lead's website stack, e.g. to detect their ecommerce platform or CRM before outreach.",
      inputSchema: {
        url: z.string().describe("The URL to fingerprint, e.g. 'https://example.com' (protocol is added if missing)."),
      },
      annotations: {
        title: "Detect Tech",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    safe(async ({ url }) => {
      if (!url) return fail("url is required");
      let normalizedUrl = url.trim();
      if (!/^https?:\/\//i.test(normalizedUrl)) {
        normalizedUrl = `https://${normalizedUrl}`;
      }
      try {
        new URL(normalizedUrl);
      } catch {
        return fail("Invalid URL format");
      }

      try {
        const result = await detectTechnologies(normalizedUrl);
        return ok({ success: true, url: normalizedUrl, ...result });
      } catch (error: any) {
        if (error instanceof FetchFailError) {
          return ok({
            success: false,
            url: normalizedUrl,
            reason: error.reason,
            ...(error.httpStatus !== undefined && { http_status: error.httpStatus }),
            message: error.message,
            technologies: "",
            scripts: [],
            links: [],
            meta: [],
          });
        }
        throw error;
      }
    })
  );

  // -- find_linkedin ------------------------------------------------------------
  server.registerTool(
    "find_linkedin",
    {
      title: "Find LinkedIn",
      description:
        "Resolve a company domain to its LinkedIn company page URL via Google search. Use this to find a " +
        "prospect company's LinkedIn presence when you only have their website domain.",
      inputSchema: {
        domain: z.string().describe("Company domain to resolve, e.g. 'empresa.com'."),
      },
      annotations: {
        title: "Find LinkedIn",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    safe(async ({ domain }) => {
      if (!domain) return fail("domain is required");
      const result = await findLinkedInForDomain(domain);
      if (!result.success && result.reason === "missing_api_key") {
        return fail(`LinkedIn finder is not configured: ${result.message}`);
      }
      return ok(result);
    })
  );

  // -- list_clients ------------------------------------------------------------
  server.registerTool(
    "list_clients",
    {
      title: "List Clients",
      description:
        "Read-only list of all registered clients and their handles. Use this to discover valid `client`/" +
        "`dnc_client` handles before calling dnc_check, dnc_add, dnc_list, or any tool that accepts dnc_client.",
      inputSchema: {},
      annotations: {
        title: "List Clients",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    safe(async () => {
      const clients = await clientService.listClients();
      return ok({ result: clients.length, clients });
    })
  );

  // -- create_client ------------------------------------------------------------
  server.registerTool(
    "create_client",
    {
      title: "Create Client",
      description:
        "Register a new client so you can maintain a Do Not Contact list for their campaigns. The handle " +
        "(a stable id used by dnc_check/dnc_add/dnc_list/dnc_client) is derived from `name` unless you pass " +
        "an explicit `handle`.",
      inputSchema: {
        name: z.string().describe("Client display name, e.g. 'Acme Corp México'. Required."),
        handle: z
          .string()
          .optional()
          .describe("Optional explicit handle; otherwise derived from `name` (lowercased, hyphenated, accents stripped)."),
      },
      annotations: {
        title: "Create Client",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    safe(async ({ name, handle }) => {
      if (!name || !name.trim()) return fail("name is required.");

      const derivedHandle = slugifyHandle(handle && handle.trim() ? handle : name);
      if (!derivedHandle) {
        return fail("name/handle must contain at least one alphanumeric character.");
      }

      const existing = await clientService.findByHandle(derivedHandle);
      if (existing) {
        return fail(`client_already_exists: a client with handle "${derivedHandle}" already exists.`);
      }

      try {
        const client = await clientService.createClient({
          handle: derivedHandle,
          name: name.trim(),
          data: {},
        });
        return ok({ status: "ok", client });
      } catch (error: any) {
        if (error?.code === "P2002") {
          return fail(`client_already_exists: a client with handle "${derivedHandle}" already exists.`);
        }
        throw error;
      }
    })
  );

  // -- dnc_check ------------------------------------------------------------
  server.registerTool(
    "dnc_check",
    {
      title: "DNC Check",
      description:
        "Read-only check of whether an email is on a client's Do Not Contact list. YOU MUST CALL THIS (or " +
        "pass dnc_client to find_email/verify_email/get_profile/get_company) BEFORE contacting anyone as part " +
        "of that client's campaign. Treat do_not_contact:true as a hard stop — never contact that person or " +
        "domain regardless of what other data you have.",
      inputSchema: {
        client: z.string().describe("Client handle (see list_clients)."),
        email: z.string().describe("Email address to check."),
      },
      annotations: {
        title: "DNC Check",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    safe(async ({ client, email }) => {
      if (!email || !email.trim()) return fail("email is required.");
      const resolved = await findClientOrError(client);
      if ("error" in resolved) return fail(resolved.error);

      const result = await dncService.check(resolved.client.id, email);
      return ok({
        handle: resolved.client.handle,
        email: email.trim().toLowerCase(),
        do_not_contact: result.do_not_contact,
        matched_by: result.matched_by,
      });
    })
  );

  // -- dnc_add ------------------------------------------------------------
  server.registerTool(
    "dnc_add",
    {
      title: "DNC Add",
      description:
        "Add emails or domains to a client's Do Not Contact list. Use `list_type: \"individual\"` for " +
        "specific person emails, or `\"domain\"` to block an entire company (an email passed to a domain " +
        "list is decomposed: the domain is blocked and the original email kept for reference). Invalid " +
        "values are skipped and reported; duplicates are skipped silently.",
      inputSchema: {
        client: z.string().describe("Client handle (see list_clients)."),
        list_type: z.enum(["individual", "domain"]).describe("Which list to add to."),
        entries: z.array(z.string()).min(1).describe("Emails (individual) or domains/emails (domain) to add."),
      },
      annotations: {
        title: "DNC Add",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    safe(async ({ client, list_type, entries }) => {
      if (!entries || entries.length === 0) {
        return fail("At least one entry is required.");
      }
      const resolved = await findClientOrError(client);
      if ("error" in resolved) return fail(resolved.error);

      const result = await dncService.upload(resolved.client.id, list_type as DncListType, entries);
      return ok({ status: "ok", handle: resolved.client.handle, list_type, ...result });
    })
  );

  // -- dnc_list ------------------------------------------------------------
  server.registerTool(
    "dnc_list",
    {
      title: "DNC List",
      description:
        "Read-only listing of a client's Do Not Contact entries, optionally filtered by list_type. Use this " +
        "to audit or export what's currently blocked for a client.",
      inputSchema: {
        client: z.string().describe("Client handle (see list_clients)."),
        list_type: z.enum(["individual", "domain"]).optional().describe("Filter to just this list type."),
      },
      annotations: {
        title: "DNC List",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    safe(async ({ client, list_type }) => {
      const resolved = await findClientOrError(client);
      if ("error" in resolved) return fail(resolved.error);

      const items = await dncService.listEntries(resolved.client.id, list_type as DncListType | undefined);
      return ok({ handle: resolved.client.handle, result: items.length, entries: items });
    })
  );

  // -- generate_copy ------------------------------------------------------------
  server.registerTool(
    "generate_copy",
    {
      title: "Generate Copy",
      description:
        "Generate B2B outbound copy (cold email, LinkedIn message, ad copy, etc.) from a prompt, via " +
        "DeepSeek. Defaults to a direct-response B2B copywriter persona; override with `system` for a " +
        "different voice. Requires DEEPSEEK_API_KEY configured server-side.",
      inputSchema: {
        prompt: z.string().describe("The brief/prompt describing the copy to generate."),
        system: z.string().optional().describe("Override the default B2B copywriter system prompt."),
        temperature: z.number().optional().describe("Sampling temperature, passed through to DeepSeek."),
        max_tokens: z.number().optional().describe("Max output tokens, passed through to DeepSeek."),
        response_schema: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "A JSON structure/shape describing the desired output (e.g. {\"description\": \"string\", " +
              "\"top_problems\": [\"string\",\"string\",\"string\"]}). When set, `response` is returned as a " +
              "parsed JSON object matching it instead of a plain string (best-effort, not schema-validated)."
          ),
      },
      annotations: {
        title: "Generate Copy",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    safe(async ({ prompt, system, temperature, max_tokens, response_schema }) => {
      if (!prompt || !prompt.trim()) return fail("prompt is required");

      try {
        const result = await generateCopy({ prompt, system, temperature, max_tokens, response_schema });
        return ok(result);
      } catch (error: any) {
        if (error instanceof DeepSeekConfigError) {
          return fail(`DeepSeek is not configured: ${error.message}`);
        }
        if (error instanceof DeepSeekApiError) {
          return fail(`DeepSeek API error: ${error.message}`);
        }
        throw error;
      }
    })
  );

  // -- explore ------------------------------------------------------------
  server.registerTool(
    "explore",
    {
      title: "Explore",
      description:
        "Run a tool-using research agent that can search Google (SERP) and fetch/read web pages to answer " +
        "an open-ended question, e.g. 'what CRM does empresa.com use?'. Returns the agent's final answer plus " +
        "a step-by-step trace of what it searched/read. Requires DEEPSEEK_API_KEY configured server-side.",
      inputSchema: {
        prompt: z.string().describe("The research question or task."),
        max_steps: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max tool calls before forcing a final answer. Default 8, hard-capped at 15."),
        response_schema: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "A JSON structure/shape describing the desired final answer. When set, `message` is returned " +
              "as a parsed JSON object matching it instead of a plain string (best-effort, not schema-validated)."
          ),
      },
      annotations: {
        title: "Explore",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    safe(async ({ prompt, max_steps, response_schema }) => {
      if (!prompt || !prompt.trim()) return fail("prompt is required");
      if (max_steps !== undefined && (!Number.isFinite(max_steps) || max_steps <= 0)) {
        return fail("max_steps must be a positive number");
      }

      try {
        const result = await runExploreAgent({ prompt, max_steps, response_schema });
        return ok(result);
      } catch (error: any) {
        if (error instanceof DeepSeekConfigError) {
          return fail(`DeepSeek is not configured: ${error.message}`);
        }
        if (error instanceof DeepSeekApiError) {
          return fail(`DeepSeek API error: ${error.message}`);
        }
        throw error;
      }
    })
  );

  // -- get_stats ------------------------------------------------------------
  server.registerTool(
    "get_stats",
    {
      title: "Get Stats",
      description:
        "Read-only aggregate usage/cost metrics for the email finder (total searches, success rate, cost " +
        "breakdown by method, cache sizes). Use this to check running costs before/after a batch of " +
        "find_email calls.",
      inputSchema: {},
      annotations: {
        title: "Get Stats",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    safe(async () => {
      const [
        totalSearches,
        validFound,
        totalCost,
        methodBreakdown,
        domainsCached,
        patternsLearned,
        catchAllCount,
      ] = await Promise.all([
        prisma.searchLog.count(),
        prisma.searchLog.count({ where: { result_status: "valid" } }),
        prisma.searchLog.aggregate({ _sum: { cost_usd: true } }),
        prisma.searchLog.groupBy({
          by: ["method_used"],
          where: { result_status: "valid" },
          _count: true,
        }),
        prisma.domainIntel.count(),
        prisma.domainPattern.count(),
        prisma.searchLog.count({ where: { result_status: "catch_all" } }),
      ]);

      const methods: Record<string, number> = {};
      for (const m of methodBreakdown as any[]) {
        if (m.method_used) methods[m.method_used] = m._count;
      }

      const total = totalCost._sum.cost_usd || 0;

      return ok({
        total_searches: totalSearches,
        total_valid_found: validFound,
        success_rate: totalSearches > 0 ? validFound / totalSearches : 0,
        methods_breakdown: methods,
        total_cost_usd: total,
        avg_cost_per_email: totalSearches > 0 ? total / totalSearches : 0,
        domains_in_cache: domainsCached,
        patterns_learned: patternsLearned,
        catch_all_domains: catchAllCount,
      });
    })
  );

  // -- check_credits --------------------------------------------------------
  server.registerTool(
    "check_credits",
    {
      title: "Check Provider Credits",
      description:
        "Live green/yellow/red balance check of every paid provider (EmailListVerify, DeBounce, Serper, " +
        "DeepSeek). Call this FIRST when find_email or verify_email keep returning status \"unknown\": a " +
        "provider with no balance returns \"unknown\", which is indistinguishable from \"this email does " +
        "not exist\". A provider that cannot be read is reported red, never green.",
      inputSchema: {},
      annotations: {
        title: "Check Provider Credits",
        readOnlyHint: true,
        destructiveHint: false,
        // Hits each provider's balance API, so this reaches outside the service.
        openWorldHint: true,
      },
    },
    safe(async () => {
      const report = await checkAllCredits();
      return ok({
        status: report.worst,
        checked_at: report.checked_at.toISOString(),
        burn_per_day: {
          searches: Math.round(report.burn.searches),
          verifications: Math.round(report.burn.verifications),
        },
        providers: report.checks.map((c) => ({
          provider: c.provider,
          label: c.label,
          status: c.status,
          balance: c.balance,
          unit: c.unit,
          days_left: c.days_left === null ? null : Math.round(c.days_left * 10) / 10,
          error: c.error,
          impact: c.impact,
        })),
      });
    })
  );

  return server;
}
