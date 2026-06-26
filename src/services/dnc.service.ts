import prisma from '../db/prisma';
import { DncEntry, DncListType } from '../types';
import { normalizeEmail, normalizeDomain, extractEmailDomain } from './normalization';

export interface DncUploadResult {
    added: number;
    skipped_duplicates: number;
    invalid: string[];
    entries: { list_type: DncListType; email: string | null; domain: string | null }[];
}

export interface DncCheckResult {
    do_not_contact: boolean;
    matched_by: 'email' | 'domain' | null;
}

interface PreparedEntry {
    list_type: DncListType;
    email: string | null;
    domain: string | null;
}

export const dncService = {
    /**
     * Turns a raw input value into a normalized entry for the given list type.
     *
     * - individual: input must be an email; stored as { email }.
     * - domain: input may be a domain OR an email. If an email, the domain is
     *   extracted and blocked, while the original email is kept for reference.
     *
     * Returns null when the input is invalid for the list type.
     */
    prepareEntry(rawValue: string, listType: DncListType): PreparedEntry | null {
        const value = (rawValue ?? '').toString().trim();
        if (!value) return null;

        const isEmail = value.includes('@');

        if (listType === 'individual') {
            if (!isEmail) return null;
            const email = normalizeEmail(value);
            if (!extractEmailDomain(email)) return null; // malformed email
            return { list_type: 'individual', email, domain: null };
        }

        // domain list
        if (isEmail) {
            const email = normalizeEmail(value);
            const domain = extractEmailDomain(email);
            if (!domain) return null;
            return { list_type: 'domain', email, domain };
        }

        const domain = normalizeDomain(value);
        if (!domain) return null;
        return { list_type: 'domain', email: null, domain };
    },

    /**
     * Upload entries to a client's DNC list. Skips duplicates (same client,
     * list_type, email and domain).
     */
    async upload(clientId: string, listType: DncListType, rawValues: string[]): Promise<DncUploadResult> {
        const invalid: string[] = [];
        const prepared: PreparedEntry[] = [];

        for (const raw of rawValues) {
            const entry = this.prepareEntry(raw, listType);
            if (!entry) {
                invalid.push((raw ?? '').toString());
            } else {
                prepared.push(entry);
            }
        }

        // Dedup within the incoming batch
        const seen = new Set<string>();
        const deduped = prepared.filter(e => {
            const key = `${e.list_type}|${e.email ?? ''}|${e.domain ?? ''}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        // Dedup against existing rows
        const existing = await prisma.dncEntry.findMany({
            where: { client_id: clientId },
            select: { list_type: true, email: true, domain: true }
        });
        const existingKeys = new Set(
            existing.map(e => `${e.list_type}|${e.email ?? ''}|${e.domain ?? ''}`)
        );

        const toInsert = deduped.filter(e => {
            const key = `${e.list_type}|${e.email ?? ''}|${e.domain ?? ''}`;
            return !existingKeys.has(key);
        });

        if (toInsert.length > 0) {
            await prisma.dncEntry.createMany({
                data: toInsert.map(e => ({
                    client_id: clientId,
                    list_type: e.list_type,
                    email: e.email,
                    domain: e.domain,
                }))
            });
        }

        return {
            added: toInsert.length,
            skipped_duplicates: prepared.length - toInsert.length,
            invalid,
            entries: toInsert,
        };
    },

    /**
     * Check whether an email is on a client's DNC list.
     * Matches on the exact email OR on the email's domain.
     */
    async check(clientId: string, email: string): Promise<DncCheckResult> {
        const normalizedEmail = normalizeEmail(email);
        const domain = extractEmailDomain(normalizedEmail);

        const match = await prisma.dncEntry.findFirst({
            where: {
                client_id: clientId,
                OR: [
                    { email: normalizedEmail },
                    ...(domain ? [{ domain }] : []),
                ],
            },
        });

        if (!match) {
            return { do_not_contact: false, matched_by: null };
        }

        // Prefer the most specific reason: domain block vs exact email.
        const matchedBy: 'email' | 'domain' =
            domain && match.domain === domain ? 'domain' : 'email';

        return { do_not_contact: true, matched_by: matchedBy };
    },

    /**
     * List a client's DNC entries, optionally filtered by list type.
     */
    async listEntries(clientId: string, listType?: DncListType): Promise<DncEntry[]> {
        return await prisma.dncEntry.findMany({
            where: {
                client_id: clientId,
                ...(listType ? { list_type: listType } : {}),
            },
            orderBy: { created_at: 'desc' },
        });
    }
};
