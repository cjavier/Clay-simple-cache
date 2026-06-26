import prisma from '../db/prisma';
import { Client, CreateClientParams } from '../types';
import { levenshtein } from './normalization';

export const clientService = {
    /**
     * Find a client by its handle.
     */
    async findByHandle(handle: string): Promise<Client | null> {
        return await prisma.client.findUnique({ where: { handle } });
    },

    /**
     * List all clients (newest first).
     */
    async listClients(): Promise<Client[]> {
        return await prisma.client.findMany({ orderBy: { created_at: 'desc' } });
    },

    /**
     * Create a new client.
     */
    async createClient(params: CreateClientParams): Promise<Client> {
        return await prisma.client.create({
            data: {
                handle: params.handle,
                name: params.name,
                data: params.data ?? {},
            }
        });
    },

    /**
     * Suggest existing client handles similar to a (not found) handle.
     * Uses substring matching + Levenshtein distance.
     */
    async suggestHandles(handle: string, limit = 5): Promise<string[]> {
        const clients = await prisma.client.findMany({ select: { handle: true } });
        const target = handle.trim().toLowerCase();

        const scored = clients
            .map(c => {
                const h = c.handle;
                let score: number;
                if (h.includes(target) || target.includes(h)) {
                    // substring overlap is a strong signal
                    score = Math.abs(h.length - target.length);
                } else {
                    score = levenshtein(h, target);
                }
                return { handle: h, score };
            })
            // keep only reasonably close candidates
            .filter(c => c.score <= Math.max(3, Math.ceil(target.length / 2)))
            .sort((a, b) => a.score - b.score);

        return scored.slice(0, limit).map(c => c.handle);
    }
};
