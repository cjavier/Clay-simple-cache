/**
 * BlitzAPI client (https://docs.blitz-api.ai) for building lists in the background.
 *
 * Port of `scripts/create-table/blitz_lib.py` in Clientes-Improvitz: same
 * endpoints, same per-endpoint throttle at 80% of the plan's rate, same retries
 * on 429/500/503. The filters it receives are ALREADY in Blitz's shape — the
 * translation from a campaign recipe stays in the skill, where a person
 * calibrates it with counts before anything is downloaded.
 *
 * Plan facts (2026-10-08): counting costs 1 record; an email not found costs 0;
 * a search returns at most 1,000 pages / 50k results.
 */

const BASE = "https://api.blitz-api.ai";

export class BlitzError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "BlitzError";
  }
}

export function blitzConfigured(): boolean {
  return Boolean(process.env.BLITZAPI_KEY);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Blitz rejects empty filter objects; send only the ones that say something. */
function filters(company: object, people: object): Record<string, object> {
  const out: Record<string, object> = {};
  if (company && Object.keys(company).length) out.company = company;
  if (people && Object.keys(people).length) out.people = people;
  return out;
}

export class Blitz {
  recordsUsed = 0;
  private rps = 5;
  private windows = new Map<string, number[]>();

  constructor(private readonly key = process.env.BLITZAPI_KEY || "") {
    if (!key) throw new BlitzError("BLITZAPI_KEY is not set", 0);
  }

  /** Reads the plan's rate limit; call once before heavy use. */
  async init(): Promise<this> {
    const info = await this.request("GET", "/v2/account/key-info");
    this.rps = Math.max(1, Math.floor((info?.max_requests_per_seconds || 5) * 0.8));
    return this;
  }

  private async throttle(path: string) {
    for (;;) {
      const now = Date.now();
      const win = (this.windows.get(path) || []).filter((t) => now - t < 1000);
      if (win.length < this.rps) {
        win.push(now);
        this.windows.set(path, win);
        return;
      }
      this.windows.set(path, win);
      await sleep(Math.max(1000 - (now - win[0]), 10));
    }
  }

  async request(method: string, path: string, body?: unknown, retries = 4): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      await this.throttle(path);
      let res: Response;
      try {
        res = await fetch(BASE + path, {
          method,
          headers: { "x-api-key": this.key, "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (err: any) {
        // A read timeout may already have been billed; only retry when the
        // request never got an answer at all, a bounded number of times.
        if (attempt < retries) {
          await sleep(Math.min(2 ** attempt * 1000, 20_000));
          continue;
        }
        throw new BlitzError(`Blitz ${path}: ${err?.message || err}`, 0);
      }
      const text = await res.text();
      let json: any = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { message: text.slice(0, 300) };
      }
      if (res.ok) {
        this.recordsUsed += json?.fair_usage?.records_used || 0;
        return json;
      }
      if ([429, 500, 503].includes(res.status) && attempt < retries) {
        await sleep(Math.min(2 ** attempt * 1000, 20_000));
        continue;
      }
      throw new BlitzError(`Blitz ${path} → HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`, res.status);
    }
  }

  async countCompanies(company: object): Promise<number> {
    return (await this.request("POST", "/v2/search/companies", { company, max_results: 1 }))?.total_results ?? 0;
  }

  async countPeople(company: object, people: object): Promise<number> {
    return (await this.request("POST", "/v2/search/people", { ...filters(company, people), max_results: 1 }))?.total_results ?? 0;
  }

  async companiesPage(company: object, size: number, cursor: string | null): Promise<{ results: any[]; cursor: string | null }> {
    const r = await this.request("POST", "/v2/search/companies", { company, max_results: size, ...(cursor ? { cursor } : {}) });
    return { results: r?.results || [], cursor: r?.cursor || null };
  }

  /** Every person matching `people` at the given companies (no per-company cap: decision 2026-10-05). */
  async allPeople(company: object, people: object): Promise<any[]> {
    const out: any[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 1000; page++) {
      const r = await this.request("POST", "/v2/search/people", { ...filters(company, people), max_results: 50, ...(cursor ? { cursor } : {}) });
      out.push(...(r?.results || []));
      cursor = r?.cursor || null;
      if (!cursor || !(r?.results || []).length) break;
    }
    return out;
  }

  async findEmail(personLinkedinUrl: string): Promise<any> {
    return this.request("POST", "/v2/enrichment/email", { person_linkedin_url: personLinkedinUrl });
  }
}
