import { Response } from 'express';
import { slugifyHandle } from '../services/normalization';
import { clientService } from '../services/client.service';
import { Client } from '../types';

/**
 * Send the standard "client not found" 404, including similar-handle
 * suggestions. Shared by every client-scoped endpoint so the error shape
 * stays consistent.
 */
export async function sendClientNotFound(res: Response, handle: string): Promise<void> {
    const suggestions = await clientService.suggestHandles(handle);
    res.status(404).json({
        error: 'client_not_found',
        message: `No client found with handle "${handle}".`,
        handle,
        suggestions,
    });
}

/**
 * Resolve a client by (raw) handle, writing a 400/404 response when missing.
 * Returns the client on success, or null when a response was already sent.
 */
export async function resolveClientOr404(res: Response, rawHandle: unknown): Promise<Client | null> {
    if (!rawHandle || typeof rawHandle !== 'string' || !rawHandle.trim()) {
        res.status(400).json({ error: 'handle is required.' });
        return null;
    }

    const handle = slugifyHandle(rawHandle);
    const client = await clientService.findByHandle(handle);

    if (!client) {
        await sendClientNotFound(res, handle);
        return null;
    }

    return client;
}
