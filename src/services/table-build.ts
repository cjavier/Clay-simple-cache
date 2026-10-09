/**
 * Pure pieces of the Blitz list build: turning Blitz records into the
 * canonical rows that POST /tables/:id/rows accepts. Kept apart from the loop
 * so they can be tested without network or database, and kept in step with
 * `scripts/create-table/create_table.py` (the skill's local sample run).
 */

/** Rule 5 of the agency: placeholders, no-reply and generic inboxes are never activated. */
const JUNK_LOCAL = new RegExp(
  "^(info|ventas|venta|contacto|contact|sales|hola|hello|admin|administracion|" +
    "facturacion|facturas|recepcion|rh|rrhh|recursoshumanos|soporte|support|" +
    "marketing|compras|atencion|atencionaclientes|servicio|servicios|office|" +
    "mail|email|correo|webmaster|postmaster|jobs|empleo|empleos|careers|" +
    "noreply|no-reply|no\\.reply|donotreply|test|prueba)$",
  "i"
);
const JUNK_PARTS = ["placeholder", "noreply", "no-reply", "example.", "test@"];

export function junkReason(email: string | null | undefined): string {
  const e = (email || "").trim().toLowerCase();
  if (!e || !e.includes("@")) return "sin_correo";
  for (const p of JUNK_PARTS) if (e.includes(p)) return `basura:${p}`;
  const local = e.split("@")[0];
  return JUNK_LOCAL.test(local) ? `generico:${local}@` : "";
}

export function normLi(url: string | null | undefined): string {
  if (!url) return "";
  const u = url.trim().toLowerCase().split("?")[0].replace(/\/+$/, "");
  return u.replace(/^https?:\/\/([a-z]+\.)?linkedin\.com/, "https://www.linkedin.com");
}

/** The person's current job, preferring one at a company in this batch. */
export function currentExperience(person: any, companyLis?: Set<string>): any {
  const exps: any[] = person?.experiences || [];
  const cur = exps.filter((x) => x?.job_is_current);
  if (companyLis) {
    const hit = cur.find((x) => companyLis.has(normLi(x?.company_linkedin_url)));
    if (hit) return hit;
  }
  return (cur.length ? cur : exps)[0] || {};
}

export type EmailStatus = "valido" | "no_encontrado" | "descartado" | "error" | "no_buscado";

export function emailOutcome(em: any): { status: EmailStatus; found: string; reason: string; others: string[] } {
  if (!em) return { status: "no_buscado", found: "", reason: "", others: [] };
  const found = typeof em.email === "string" ? em.email : "";
  const others = (em.all_emails || []).filter((x: unknown) => typeof x === "string" && x !== found);
  if (em.error) return { status: "error", found, reason: String(em.error), others };
  if (!em.found) return { status: "no_encontrado", found, reason: "", others };
  const junk = junkReason(found);
  return junk ? { status: "descartado", found, reason: junk, others } : { status: "valido", found, reason: "", others };
}

/** A people row (canonical fields). The email travels with its source, always. */
export function personRow(person: any, exp: any, company: any, em: any, source = "blitzapi") {
  const o = emailOutcome(em);
  const companyDomain = String(company?.domain || exp?.company_domain || "").toLowerCase();
  const emailDomain = o.found.includes("@") ? o.found.split("@")[1].toLowerCase() : "";
  const loc = person?.location || {};
  const hq = company?.hq || {};
  const row: Record<string, unknown> = {
    first_name: person?.first_name,
    last_name: person?.last_name,
    full_name: person?.full_name,
    job_title: exp?.job_title,
    job_start_date: exp?.job_start_date,
    company: company?.name || exp?.company_name,
    domain: company?.domain || exp?.company_domain,
    company_linkedin_url: company?.linkedin_url || exp?.company_linkedin_url,
    linkedin_url: person?.linkedin_url,
    city: loc.city,
    country: loc.country_code,
    connections: person?.connections_count,
    email: o.status === "valido" ? o.found : "",
    email_source: o.found ? source : "",
    email_status: o.status,
    email_found: o.found,
    // "no" = the address is on another domain (another job, the group, an agency): check by eye.
    domain_match: emailDomain ? (companyDomain && emailDomain.endsWith(companyDomain) ? "si" : "no") : "",
    discard_reason: o.reason,
    other_emails: o.others.join(";"),
    industry: company?.industry,
    company_size: company?.size,
    employees_on_linkedin: company?.employees_on_linkedin,
    company_state: hq.state,
    company_description: (company?.about || "").replace(/\n/g, " "),
  };
  return clean(row);
}

export function companyRow(company: any, contacts: number, withEmail: number) {
  const hq = company?.hq || {};
  return clean({
    company: company?.name,
    domain: company?.domain,
    website: company?.website,
    linkedin_url: company?.linkedin_url,
    industry: company?.industry,
    company_size: company?.size,
    employees_on_linkedin: company?.employees_on_linkedin,
    followers: company?.followers,
    founded_year: company?.founded_year,
    company_type: company?.type,
    state: hq.state,
    city: hq.city,
    country: hq.country_code,
    description: (company?.about || "").replace(/\n/g, " "),
    specialties: (company?.specialties || []).join(";"),
    contacts_found: contacts,
    contacts_with_email: withEmail,
  });
}

/** Drop empty values: a field that isn't sent never overwrites one MailBridge already has. */
function clean(row: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined && v !== null && v !== ""));
}
