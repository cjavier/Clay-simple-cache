interface Pattern {
  name: string;
  build: (f: string, l: string) => string;
  prevalence: number;
}

// Prevalence measured over the 149,208 verified emails already in our own
// `profiles` table (Aug 2026), not estimated. Ordering matters: the pipeline
// truncates to config.max_permutations_to_try, so anything mis-ranked here is
// an email we never test. "f-last" was previously emitted by the SERP pattern
// detector but had no builder, so it could never be generated.
const PATTERNS: Pattern[] = [
  { name: "first.last", build: (f, l) => `${f}.${l}`, prevalence: 0.2316 },
  { name: "flast", build: (f, l) => `${f[0]}${l}`, prevalence: 0.1529 },
  { name: "first", build: (f) => `${f}`, prevalence: 0.1102 },
  { name: "firstlast", build: (f, l) => `${f}${l}`, prevalence: 0.0186 },
  { name: "f.last", build: (f, l) => `${f[0]}.${l}`, prevalence: 0.0135 },
  { name: "firstl", build: (f, l) => `${f}${l[0]}`, prevalence: 0.0090 },
  { name: "last", build: (_f, l) => `${l}`, prevalence: 0.0088 },
  { name: "first_last", build: (f, l) => `${f}_${l}`, prevalence: 0.0084 },
  { name: "lastf", build: (f, l) => `${l}${f[0]}`, prevalence: 0.0042 },
  { name: "first.l", build: (f, l) => `${f}.${l[0]}`, prevalence: 0.0030 },
  { name: "last.first", build: (f, l) => `${l}.${f}`, prevalence: 0.0024 },
  { name: "f-last", build: (f, l) => `${f[0]}-${l}`, prevalence: 0.0012 },
  { name: "last.f", build: (f, l) => `${l}.${f[0]}`, prevalence: 0.0006 },
  { name: "first-last", build: (f, l) => `${f}-${l}`, prevalence: 0.0003 },
  { name: "f_last", build: (f, l) => `${f[0]}_${l}`, prevalence: 0.0003 },
  { name: "last_first", build: (f, l) => `${l}_${f}`, prevalence: 0.0001 },
];

/**
 * Build the local-part an email would have under a given named pattern,
 * for a specific (first, last) pair. Returns null if the pattern doesn't
 * apply to this pair (e.g. missing name parts) or would build an invalid
 * local-part. Shared by generatePermutations, identifyPattern, and
 * prioritizePermutations so all three agree on what each pattern produces.
 */
function buildLocalPart(patternName: string, f: string, l: string): string | null {
  const pattern = PATTERNS.find((p) => p.name === patternName);
  if (!pattern) return null;

  if (!f && pattern.name !== "last") return null;
  if (!l && !["first"].includes(pattern.name)) return null;
  if ((!f || f.length === 0) && pattern.build.toString().includes("f[0]")) return null;
  if ((!l || l.length === 0) && pattern.build.toString().includes("l[0]")) return null;

  try {
    const local = pattern.build(f, l);
    if (!local || local.includes("undefined")) return null;
    return local;
  } catch {
    return null;
  }
}

export function normalizeName(name: string): string {
  return name
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\-]/g, "");
}

/**
 * Like normalizeName but keeps word boundaries. The pipeline must use this
 * instead of normalizeName: normalizeName() strips spaces, which collapsed
 * "Pérez García" to "perezgarcia" before lastNameVariants() ever saw it and
 * made the whole compound-surname path dead code in the /find flow.
 */
export function normalizeNameKeepingSpaces(name: string): string {
  return normalizeKeepingSpaces(name);
}

function normalizeKeepingSpaces(name: string): string {
  return name
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\- ]/g, "");
}

/**
 * Particles that are never a surname on their own — they glue onto the word
 * that follows ("de la Torre" -> "delatorre"). Without this the permutator
 * happily treats "de" or "la" as the surname: 3,121 searches in search_log
 * were run against a bare particle.
 */
const SURNAME_PARTICLES = new Set([
  "de", "del", "la", "las", "los", "y", "da", "do", "dos", "della", "di",
  "van", "von", "der", "ter", "ten", "le", "el", "san", "santa", "mac", "mc",
  "st", "bin", "al", "du", "af", "av",
]);

function isParticle(word: string): boolean {
  return SURNAME_PARTICLES.has(normalizeName(word));
}

export function parseFullName(fullName: string): [string, string] {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return ["", ""];
  if (parts.length === 1) return [parts[0], ""];
  if (parts.length === 2) return [parts[0], parts[1]];

  // 3 words: first + second. 4+ words: first + penultimate — in Spanish the
  // paternal surname sits before the maternal one.
  const idx = parts.length === 3 ? 1 : parts.length - 2;

  // The picked token may be a particle ("Javier de la Cruz" lands on "la").
  // Absorb the particle run that introduces the surname and the word it
  // belongs to, so we return "de la Cruz" rather than the meaningless "la".
  let start = idx;
  while (start > 1 && isParticle(parts[start - 1])) start--;
  let end = idx;
  while (end < parts.length - 1 && isParticle(parts[end])) end++;

  return [parts[0], parts.slice(start, end + 1).join(" ")];
}

function lastNameVariants(rawLast: string): string[] {
  const normalized = normalizeKeepingSpaces(rawLast);
  if (!normalized) return [];

  // Glue particles onto the following word.
  const words = normalized.split(/\s+/).filter(Boolean);
  const parts: string[] = [];
  let pending: string[] = [];
  for (const word of words) {
    if (SURNAME_PARTICLES.has(word)) {
      pending.push(word);
      continue;
    }
    parts.push(pending.length ? pending.join("") + word : word);
    pending = [];
  }
  // All-particle input (e.g. a mis-parsed "de la"): keep it rather than drop it.
  if (parts.length === 0 && pending.length > 0) parts.push(pending.join(""));

  const variants: string[] = [];
  if (parts.length >= 2) {
    variants.push(parts[0]);                       // paternal — most common
    variants.push(parts.join(""));                 // both, concatenated
    variants.push(parts[parts.length - 1]);        // maternal
    variants.push(parts[0] + parts[1][0]);         // paternal + maternal initial
  } else if (parts.length === 1) {
    variants.push(parts[0]);
    if (parts[0].includes("-")) variants.push(parts[0].replace(/-/g, ""));
  }

  return variants.map(normalizeName).filter(Boolean);
}

function firstNameVariants(rawFirst: string): string[] {
  const normalized = normalizeName(rawFirst);
  const variants: string[] = [normalized];

  if (normalized.includes("-")) {
    variants.push(normalized.replace(/-/g, ""));
  }

  return variants.filter(Boolean);
}

export function generatePermutations(
  first: string,
  last: string,
  domain: string
): string[] {
  if (!first && !last) return [];

  const fVariants = firstNameVariants(first);
  const lVariants = lastNameVariants(last);
  const seen = new Set<string>();
  const result: string[] = [];

  const addEmail = (f: string, l: string) => {
    for (const pattern of PATTERNS) {
      const local = buildLocalPart(pattern.name, f, l);
      if (local === null) continue;
      const email = `${local}@${domain}`;
      if (!seen.has(email)) {
        seen.add(email);
        result.push(email);
      }
    }
  };

  // Primary combination first
  if (fVariants.length > 0 && lVariants.length > 0) {
    addEmail(fVariants[0], lVariants[0]);
  }

  // Other variant combinations
  for (const fv of fVariants) {
    for (const lv of lVariants) {
      if (fv === fVariants[0] && lv === lVariants[0]) continue;
      addEmail(fv, lv);
    }
  }

  return result;
}

export function generatePermutationsFromFullName(
  fullName: string,
  domain: string
): string[] {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 3) return [];

  const firstName = parts[0];
  const extras: string[] = [];
  const seen = new Set<string>();

  // Try each intermediate/last word as potential last name
  for (let i = 1; i < parts.length; i++) {
    const word = parts[i];
    if (word.endsWith(".")) continue;
    if (isParticle(word)) continue;
    const normalized = normalizeName(word);
    if (normalized.length < 2) continue;

    const perms = generatePermutations(
      normalizeName(firstName),
      normalized,
      domain
    );
    for (const p of perms) {
      if (!seen.has(p)) {
        seen.add(p);
        extras.push(p);
      }
    }
  }

  return extras;
}

export interface KnownPattern {
  pattern: string;
  confidence: number;
  sample_count: number;
}

/**
 * Reorder permutations so that emails matching known domain patterns come
 * first (highest confidence/sample_count pattern first). `first`/`last`
 * are the raw name parts used to generate `permutations` — they're needed
 * to reconstruct the exact local-part each known pattern would produce.
 */
export function prioritizePermutations(
  permutations: string[],
  knownPatterns: KnownPattern[],
  first: string = "",
  last: string = ""
): string[] {
  if (knownPatterns.length === 0) return permutations;

  const fVariants = firstNameVariants(first);
  const lVariants = lastNameVariants(last);

  const sorted = [...knownPatterns].sort(
    (a, b) => b.confidence - a.confidence || b.sample_count - a.sample_count
  );

  const prioritized: string[] = [];
  const remaining = [...permutations];

  for (const kp of sorted) {
    for (let i = 0; i < remaining.length; i++) {
      const local = remaining[i].split("@")[0];
      // Check if this email's local-part matches what this known pattern
      // would actually produce for this person's name.
      if (matchesPattern(local, kp.pattern, fVariants, lVariants)) {
        prioritized.push(remaining[i]);
        remaining.splice(i, 1);
        break;
      }
    }
  }

  return [...prioritized, ...remaining];
}

function matchesPattern(
  localPart: string,
  patternName: string,
  fVariants: string[],
  lVariants: string[]
): boolean {
  for (const f of fVariants) {
    for (const l of lVariants) {
      if (buildLocalPart(patternName, f, l) === localPart) return true;
    }
  }
  return false;
}

export function identifyPattern(
  email: string,
  firstName: string,
  lastName: string
): string | null {
  const localPart = email.split("@")[0];
  const fVariants = firstNameVariants(firstName);
  const lVariants = lastNameVariants(lastName);

  for (const f of fVariants) {
    for (const l of lVariants) {
      for (const pattern of PATTERNS) {
        if (buildLocalPart(pattern.name, f, l) === localPart) return pattern.name;
      }
    }
  }

  return null;
}
