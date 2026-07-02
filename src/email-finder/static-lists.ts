import fs from "fs";
import path from "path";

// Resolve relative to this file (not process.cwd()) so the data/ files are
// found regardless of where the process was launched from. This file lives
// at src/email-finder/static-lists.ts (ts-node/vitest) and compiles to
// dist/email-finder/static-lists.js (outDir mirrors rootDir=src), so in
// both cases the repo root — where data/ lives — is two levels up.
const REPO_ROOT = path.join(__dirname, "..", "..");

function loadSet(filename: string): Set<string> {
  const filepath = path.join(REPO_ROOT, "data", filename);
  try {
    const content = fs.readFileSync(filepath, "utf-8");
    return new Set(
      content
        .split("\n")
        .map((line) => line.trim().toLowerCase())
        .filter(Boolean)
    );
  } catch {
    console.warn(`Warning: could not load ${filepath}`);
    return new Set();
  }
}

const disposableDomains = loadSet("disposable_domains.txt");
const freeProviders = loadSet("free_providers.txt");
const roleAccounts = loadSet("role_accounts.txt");

export function checkDisposable(domain: string): boolean {
  return disposableDomains.has(domain.toLowerCase());
}

export function checkFreeProvider(domain: string): boolean {
  return freeProviders.has(domain.toLowerCase());
}

export function checkRoleAccount(localPart: string): boolean {
  return roleAccounts.has(localPart.toLowerCase());
}
