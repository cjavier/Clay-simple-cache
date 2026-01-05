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

        // Add protocol if missing to parsing
        if (!cleanUrl.startsWith('http')) {
            cleanUrl = 'https://' + cleanUrl;
        }

        const urlObj = new URL(cleanUrl);
        const pathSegments = urlObj.pathname.split('/').filter(Boolean);

        // Find 'in' segment and get the next one
        const inIndex = pathSegments.indexOf('in');
        if (inIndex !== -1 && pathSegments[inIndex + 1]) {
            return pathSegments[inIndex + 1];
        }

        // Fallback? The requirement says "linkedin.com/in/juan-perez", so the above covers it.
        // What if it's just "juan-perez"? The requirements lists:
        // "Entradas válidas: juan-perez" -> No, it lists inputs as URLs mostly, but "linkedin.com/in/juan-perez"

        // If the input doesn't look like a URL but just a slug (no slashes), maybe return it as is?
        // "Entradas válidas: ... linkedin.com/in/juan-perez"
        // Let's assume if we can't parse a URL, maybe it's already a slug? 
        // But safely, let's just stick to extracting from URL structures or return the input if it looks like a simple slug (no dots, no slashes).

        if (!url.includes('/') && !url.includes('.')) {
            return url.trim().toLowerCase(); // It's already a slug
        }

        return null;
    } catch (e) {
        // If URL parsing fails, check if simple slug
        if (!url.includes('/') && !url.includes('.')) {
            return url.trim().toLowerCase();
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
 * Normalizes domain: trim, toLowerCase, remove protocol/www
 * e.g. "https://www.google.com/" -> "google.com"
 */
export function normalizeDomain(domain: string): string | null {
    try {
        let cleanDomain = domain.trim().toLowerCase();

        // Remove protocol
        if (cleanDomain.startsWith('http://')) cleanDomain = cleanDomain.slice(7);
        if (cleanDomain.startsWith('https://')) cleanDomain = cleanDomain.slice(8);

        // Remove www.
        if (cleanDomain.startsWith('www.')) cleanDomain = cleanDomain.slice(4);

        // Remove trailing slash
        if (cleanDomain.endsWith('/')) cleanDomain = cleanDomain.slice(0, -1);

        // Basic validation: should have at least one dot
        if (!cleanDomain.includes('.')) return null;

        return cleanDomain;
    } catch (e) {
        return null;
    }
}
