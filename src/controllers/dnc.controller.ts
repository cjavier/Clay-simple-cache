import { Request, Response } from 'express';
import { slugifyHandle } from '../services/normalization';
import { clientService } from '../services/client.service';
import { dncService } from '../services/dnc.service';
import { DncListType } from '../types';

const VALID_LIST_TYPES: DncListType[] = ['individual', 'domain'];

/**
 * Resolve a client by handle, writing a 400/404 response when missing.
 * Returns the client id on success, or null when a response was already sent.
 */
async function resolveClientOr404(
    res: Response,
    rawHandle: unknown
): Promise<{ id: string; handle: string } | null> {
    if (!rawHandle || typeof rawHandle !== 'string' || !rawHandle.trim()) {
        res.status(400).json({ error: 'handle is required.' });
        return null;
    }

    const handle = slugifyHandle(rawHandle);
    const client = await clientService.findByHandle(handle);

    if (!client) {
        const suggestions = await clientService.suggestHandles(handle);
        res.status(404).json({
            error: 'client_not_found',
            message: `No client found with handle "${handle}".`,
            handle,
            suggestions,
        });
        return null;
    }

    return { id: client.id, handle: client.handle };
}

export const dncController = {
    /**
     * POST /dnc
     * Upload entries to a client's Do Not Contact list.
     *
     * Body:
     *   handle:    client handle (required)
     *   list_type: 'individual' | 'domain' (required)
     *   entries:   string[]  (or single `entry`/`email`/`domain`)
     */
    async upload(req: Request, res: Response): Promise<void> {
        try {
            const { handle, list_type, entries, entry, email, domain } = req.body;

            if (!list_type || !VALID_LIST_TYPES.includes(list_type)) {
                res.status(400).json({
                    error: `list_type is required and must be one of: ${VALID_LIST_TYPES.join(', ')}.`,
                });
                return;
            }

            // Accept a flexible set of input shapes.
            let rawValues: string[] = [];
            if (Array.isArray(entries)) rawValues = entries;
            else if (typeof entries === 'string') rawValues = [entries];

            for (const single of [entry, email, domain]) {
                if (typeof single === 'string' && single.trim()) rawValues.push(single);
            }

            if (rawValues.length === 0) {
                res.status(400).json({ error: 'At least one entry is required (use `entries` array or `entry`/`email`/`domain`).' });
                return;
            }

            const client = await resolveClientOr404(res, handle);
            if (!client) return;

            const result = await dncService.upload(client.id, list_type, rawValues);

            res.status(200).json({
                status: 'ok',
                handle: client.handle,
                list_type,
                ...result,
            });
        } catch (error: any) {
            console.error('DNC Upload Error:', error);
            res.status(500).json({ error: error.message || 'Internal Server Error' });
        }
    },

    /**
     * POST /dnc/check
     * Check whether an email is on a client's Do Not Contact list.
     * Always returns 200 with `do_not_contact: true|false` when the client
     * exists; returns an error when handle/email is missing or unknown.
     */
    async check(req: Request, res: Response): Promise<void> {
        try {
            const { handle, email } = req.body;

            if (!email || typeof email !== 'string' || !email.trim()) {
                res.status(400).json({ error: 'email is required.' });
                return;
            }

            const client = await resolveClientOr404(res, handle);
            if (!client) return;

            const result = await dncService.check(client.id, email);

            res.status(200).json({
                handle: client.handle,
                email: email.trim().toLowerCase(),
                do_not_contact: result.do_not_contact,
                matched_by: result.matched_by,
            });
        } catch (error: any) {
            console.error('DNC Check Error:', error);
            res.status(500).json({ error: error.message || 'Internal Server Error' });
        }
    },

    /**
     * GET /dnc
     * List a client's DNC entries (optionally filtered by ?list_type=).
     */
    async list(req: Request, res: Response): Promise<void> {
        try {
            const { handle, list_type } = req.query;

            if (list_type && !VALID_LIST_TYPES.includes(list_type as DncListType)) {
                res.status(400).json({
                    error: `list_type must be one of: ${VALID_LIST_TYPES.join(', ')}.`,
                });
                return;
            }

            const client = await resolveClientOr404(res, handle);
            if (!client) return;

            const items = await dncService.listEntries(client.id, list_type as DncListType | undefined);

            res.json({
                handle: client.handle,
                result: items.length,
                entries: items,
            });
        } catch (error: any) {
            console.error('DNC List Error:', error);
            res.status(500).json({ error: error.message || 'Internal Server Error' });
        }
    }
};
