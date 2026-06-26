import { Request, Response } from 'express';
import { slugifyHandle } from '../services/normalization';
import { clientService } from '../services/client.service';
import { sendClientNotFound } from './client-resolver';

export const clientsController = {
    /**
     * POST /clients
     * Create a client. The handle is derived from the name (lowercased,
     * spaces -> hyphens) so it acts as a stable, unified client id.
     */
    async create(req: Request, res: Response): Promise<void> {
        try {
            const { name, ...extraData } = req.body;

            if (!name || typeof name !== 'string' || !name.trim()) {
                res.status(400).json({ error: 'name is required.' });
                return;
            }

            const handle = slugifyHandle(name);
            if (!handle) {
                res.status(400).json({ error: 'name must contain at least one alphanumeric character.' });
                return;
            }

            const existing = await clientService.findByHandle(handle);
            if (existing) {
                res.status(409).json({
                    error: 'client_already_exists',
                    message: `A client with handle "${handle}" already exists.`,
                    handle,
                    client: existing,
                });
                return;
            }

            let client;
            try {
                client = await clientService.createClient({
                    handle,
                    name: name.trim(),
                    data: extraData,
                });
            } catch (error: any) {
                // Two concurrent creates can both pass the check above; the unique
                // constraint on `handle` then rejects the loser with P2002.
                if (error?.code === 'P2002') {
                    const conflicting = await clientService.findByHandle(handle);
                    res.status(409).json({
                        error: 'client_already_exists',
                        message: `A client with handle "${handle}" already exists.`,
                        handle,
                        client: conflicting,
                    });
                    return;
                }
                throw error;
            }

            res.status(201).json({
                status: 'ok',
                client,
            });
        } catch (error: any) {
            console.error('Create Client Error:', error);
            res.status(500).json({ error: error.message || 'Internal Server Error' });
        }
    },

    /**
     * GET /clients
     * List all clients, or fetch a single one when ?handle= is provided.
     */
    async list(req: Request, res: Response): Promise<void> {
        try {
            const { handle } = req.query;

            if (handle) {
                const normalizedHandle = slugifyHandle(handle as string);
                const client = await clientService.findByHandle(normalizedHandle);
                if (!client) {
                    await sendClientNotFound(res, normalizedHandle);
                    return;
                }
                res.json({ result: 1, client });
                return;
            }

            const clients = await clientService.listClients();
            res.json({ result: clients.length, clients });
        } catch (error: any) {
            console.error('List Clients Error:', error);
            res.status(500).json({ error: error.message || 'Internal Server Error' });
        }
    }
};
