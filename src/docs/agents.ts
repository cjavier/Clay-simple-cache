/**
 * Shared "for AI agents" content.
 *
 * This is the single source of truth for the machine-readable summaries used
 * by both the human-readable API docs (`src/docs/content.ts`, section
 * "For AI Agents") and the machine-readable `GET /llms.txt` endpoint. Keeping
 * them in one place means the two surfaces can't drift out of sync.
 *
 * Every string below may contain the literal placeholder `{{BASE_URL}}`;
 * callers substitute it with the live request's protocol+host before sending
 * a response.
 */

/** One line per REST endpoint: method, path, body/query shape, response shape. */
export const REST_ENDPOINTS_SUMMARY = `GET  /profiles?email|linkedin|phone&dnc_client? -> {result,...fields,id,email,linkedin_slug,phone,updated_at} | {result:null,message,search_criteria} | {do_not_contact,matched_by}
POST /profiles {email?,linkedin_url?,linkedin_profile?,phone?,...extra} (>=1 of email/linkedin_url/phone) -> {status,resolved_by,profile_id,saved_data}
GET  /companies?domain|linkedin&dnc_client? -> {result,...fields,id,domain,linkedin_slug,updated_at} | {result:null,message,search_criteria} | {do_not_contact,matched_by}
POST /companies {domain?,linkedin_url?,...extra} (>=1 of domain/linkedin_url) -> {status,resolved_by,company_id,saved_data}
POST /find {domain,first_name?,last_name?,full_name?,max_tier?=2,dnc_client?} (domain required, >=1 name field) -> {success,email,status,confidence,method,pattern,domain_info,serp_info,permutations_tried,cost_usd,duration_ms,do_not_contact?} | {do_not_contact,matched_by}
POST /verify {email,max_tier?=2,dnc_client?} -> {email,status,confidence,method,domain_info,cost_usd,duration_ms,do_not_contact?} | {do_not_contact,matched_by}
GET  /stats -> {total_searches,total_valid_found,success_rate,methods_breakdown,total_cost_usd,avg_cost_per_email,domains_in_cache,patterns_learned,catch_all_domains}
POST /detect-tech {url} -> {success:true,url,cms,ecommerce,analytics[],tag_managers[],frameworks[],marketing[],advertising[],payments[],cdn[],seo[],privacy[],otros[],resumen} | {success:false,url,reason,http_status?,message,technologies,scripts[],links[],meta[]}
POST /find-linkedin {url|domain} -> {success:true,input,domain,linkedin_url,linkedin_slug,match_type,candidates[],cost_usd} | {success:false,input,domain,linkedin_url:null,linkedin_slug:null,reason,message,cost_usd}
POST /clients {name,...extra} -> 201 {status,client:{id,handle,name,data,created_at,updated_at}} | 409 {error:"client_already_exists",handle,client}
GET  /clients?handle? -> {result,clients:[...]} | {result:1,client} | 404 {error:"client_not_found",handle,suggestions[]}
POST /dnc {handle,list_type:"individual"|"domain",entries[]|entry|email|domain} -> {status,handle,list_type,added,skipped_duplicates,invalid[],entries[]}
POST /dnc/check {handle,email} -> {handle,email,do_not_contact,matched_by:"email"|"domain"|null}
GET  /dnc?handle,list_type? -> {handle,result,entries[]}
POST /copy {prompt,system?,model?="deepseek-v4-flash",temperature?,max_tokens?,response_schema?} -> {response,model,usage:{prompt_tokens,completion_tokens,total_tokens,prompt_cache_hit_tokens,prompt_cache_miss_tokens,cost_usd},duration_ms,warning?} | 503/502/400 {error}
POST /explore {prompt,max_steps?=8(cap 15),model?,reasoning?=true,response_schema?} -> {message,steps:[{step,tool,input,output_summary,reasoning?}],total_steps,usage:{prompt_tokens,completion_tokens,total_tokens,prompt_cache_hit_tokens,prompt_cache_miss_tokens,cost_usd},duration_ms} | 503/502/400 {error}
GET  /health -> "OK" (no auth)`;

/** One line per MCP tool: name, input shape, one-line behavior. */
export const MCP_TOOLS_SUMMARY = `find_email {first_name?,last_name?,full_name?,domain,max_tier?=2,dnc_client?} -> finds + verifies a person's most likely email at a domain. Costs real money per call; DNC-gated when dnc_client is set.
verify_email {email,max_tier?=2,dnc_client?} -> verifies deliverability of an existing email address. Costs real money per call; DNC-gated.
get_profile {email?,linkedin?,phone?,dnc_client?} -> read-only cache lookup for a person profile by any known identifier.
upsert_profile {email?,linkedin_url?,phone?,data?} -> save/enrich a person profile in the cache (merges into any existing record).
get_company {domain?,linkedin_slug?,dnc_client?} -> read-only cache lookup for a company by domain or LinkedIn slug.
upsert_company {domain?,linkedin_slug?,data?} -> save/enrich a company in the cache (merges into any existing record).
detect_tech {url} -> fingerprints a site's CMS/ecommerce/analytics/ads/CRM/payments stack.
find_linkedin {domain} -> resolves a company domain to its LinkedIn company page URL.
list_clients {} -> read-only list of registered clients and their handles.
create_client {name,handle?} -> registers a new client; handle is derived from name when omitted.
dnc_check {client,email} -> read-only Do Not Contact check. Call this before contacting anyone in a client's campaign; treat a true result as a hard stop.
dnc_add {client,list_type:"individual"|"domain",entries[]} -> adds emails or domains to a client's Do Not Contact list.
dnc_list {client,list_type?} -> read-only listing of a client's Do Not Contact entries.
generate_copy {prompt,system?,temperature?,max_tokens?,response_schema?} -> generates B2B outbound copy via DeepSeek; returns token usage + cost_usd; when response_schema is set, response is a parsed JSON object matching it instead of a string. Requires DEEPSEEK_API_KEY server-side.
explore {prompt,max_steps?,response_schema?} -> runs a web-research agent (Google SERP + page fetch) and returns its final answer plus a step trace and token usage + cost_usd; when response_schema is set, message is a parsed JSON object matching it. Requires DEEPSEEK_API_KEY server-side.
get_stats {} -> read-only aggregate usage/cost metrics for the email finder.`;

/** Operating rules shared by REST and MCP consumers. */
export const AGENT_RULES = `Rules for agents (REST and MCP alike): (1) always authenticate — REST via header "Authorization: Bearer <API_KEY>", MCP via the same Bearer header on the /mcp connection; (2) before contacting a lead, check that client's Do Not Contact list first — REST: GET /profiles, GET /companies, POST /find, or POST /verify with dnc_client=<handle>, or POST /dnc/check directly; MCP: call dnc_check (or pass dnc_client to find_email/verify_email/get_profile/get_company) — and treat any {"do_not_contact":true,...} result as a hard stop. Do not retry without the DNC gate to "get around" a block; (3) find_email/verify_email (REST: /find, /verify) and generate_copy/explore (REST: /copy, /explore) cost real money or third-party API usage per call — prefer get_profile/get_company (REST: GET /profiles, GET /companies) cache lookups first, and check get_stats (REST: GET /stats) for running totals; (4) all POST bodies/tool inputs are JSON, max 1mb on the REST side; (5) back off and retry with delay on HTTP 429 (rate limited).`;
