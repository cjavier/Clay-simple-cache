import { parsePhoneNumber, CountryCode } from 'libphonenumber-js';

/**
 * Normalizes email: trim and toLowerCase
 */
export function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

/**
 * Normalizes LinkedIn URL to slug.
 * Rules:
 * - Remove protocol
 * - Remove query params
 * - Detect /in/
 * - Extract slug
 * - toLowerCase
 */
export function normalizeLinkedIn(url: string): string | null {
    try {
        let cleanUrl = url.trim().toLowerCase();

        // Remove common prefixes for easier parsing if not a full URL
        if (cleanUrl.startsWith('www.')) cleanUrl = 'https://' + cleanUrl;
        if (!cleanUrl.startsWith('http')) {
            cleanUrl = 'https://' + cleanUrl;
        }

        const urlObj = new URL(cleanUrl);
        // Ensure it's a linkedin domain
        if (!urlObj.hostname.includes('linkedin.com')) {
            // If not a linkedin domain, check if it's just a slug
            if (!url.includes('/') && !url.includes('.')) {
                return url.trim().toLowerCase();
            }
            return null;
        }

        const pathSegments = urlObj.pathname.split('/').filter(Boolean);

        // Find 'in', 'company', or 'school' segment and get the next one
        const lookup = ['in', 'company', 'school'];
        const foundIndex = pathSegments.findIndex(seg => lookup.includes(seg));

        if (foundIndex !== -1 && pathSegments[foundIndex + 1]) {
            return pathSegments[foundIndex + 1].split('?')[0].split('#')[0];
        }

        // If it's just linkedin.com/slug (less common but possible)
        if (pathSegments.length === 1 && !lookup.includes(pathSegments[0])) {
            return pathSegments[0].split('?')[0].split('#')[0];
        }

        return null;
    } catch (e) {
        // If URL parsing fails, check if simple slug
        const trimmed = url.trim().toLowerCase();
        if (!trimmed.includes('/') && !trimmed.includes('.') && trimmed.length > 0) {
            return trimmed;
        }
        return null;
    }
}

/**
 * Normalizes phone number to E.164
 * Default country: MX
 */
export function normalizePhone(phone: string, defaultCountry: CountryCode = 'MX'): { e164: string, national: string } | null {
    try {
        const phoneNumber = parsePhoneNumber(phone, defaultCountry);
        if (phoneNumber && phoneNumber.isValid()) {
            return {
                e164: phoneNumber.number, // E.164
                national: phoneNumber.nationalNumber as string // formatNational() might include spaces/dashes, we want digits usually?
                // User said: "phone_national (sin LADA)". 
                // library's .nationalNumber is usually the number without country code.
            };
        }
        return null;
    } catch (error) {
        return null;
    }
}

/**
 * Builds a client handle from a name.
 * Rules:
 * - trim & toLowerCase
 * - strip accents/diacritics
 * - collapse any run of non-alphanumeric chars into a single hyphen
 * - trim leading/trailing hyphens
 * e.g. "Acme Corp México" -> "acme-corp-mexico"
 */
export function slugifyHandle(name: string): string {
    return name
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '') // remove diacritics
        .replace(/[^a-z0-9]+/g, '-')     // non-alphanumeric -> hyphen
        .replace(/^-+|-+$/g, '');         // trim hyphens
}

/**
 * Extracts the domain part of an email address (lowercased).
 * Returns null if the value is not a valid-looking email.
 */
export function extractEmailDomain(email: string): string | null {
    const normalized = normalizeEmail(email);
    const atIndex = normalized.lastIndexOf('@');
    if (atIndex === -1) return null;
    const domain = normalized.slice(atIndex + 1);
    if (!domain || !domain.includes('.')) return null;
    return domain;
}

/**
 * Levenshtein edit distance between two strings.
 */
export function levenshtein(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;

    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    let curr = new Array(n + 1).fill(0);

    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(
                prev[j] + 1,      // deletion
                curr[j - 1] + 1,  // insertion
                prev[j - 1] + cost // substitution
            );
        }
        [prev, curr] = [curr, prev];
    }
    return prev[n];
}

/**
 * Normalizes domain: trim, toLowerCase, remove protocol/www, and strip any
 * path/query/hash/port so only the bare hostname remains.
 * e.g. "https://www.google.com/" -> "google.com"
 * e.g. "example.com/foo" -> "example.com"
 * e.g. "example.com:8080" -> "example.com"
 */
export function normalizeDomain(domain: string): string | null {
    try {
        let cleanDomain = domain.trim().toLowerCase();

        // Remove protocol
        if (cleanDomain.startsWith('http://')) cleanDomain = cleanDomain.slice(7);
        if (cleanDomain.startsWith('https://')) cleanDomain = cleanDomain.slice(8);

        // Remove www.
        if (cleanDomain.startsWith('www.')) cleanDomain = cleanDomain.slice(4);

        // Strip any path/query/hash (cut at first "/")
        const slashIndex = cleanDomain.indexOf('/');
        if (slashIndex !== -1) cleanDomain = cleanDomain.slice(0, slashIndex);

        // Strip any port (cut at first ":")
        const colonIndex = cleanDomain.indexOf(':');
        if (colonIndex !== -1) cleanDomain = cleanDomain.slice(0, colonIndex);

        // Remove trailing slash (defensive, in case cleanDomain ended up empty after slicing)
        if (cleanDomain.endsWith('/')) cleanDomain = cleanDomain.slice(0, -1);

        // Basic validation: should have at least one dot
        if (!cleanDomain.includes('.')) return null;

        return cleanDomain;
    } catch (e) {
        return null;
    }
}
