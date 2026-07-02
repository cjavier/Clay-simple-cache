import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

function timingSafeEqualStrings(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    // timingSafeEqual throws if buffer lengths differ, and a length mismatch
    // itself leaks information via early-exit comparisons, so check it first
    // (this branch is on public info - token length isn't secret) and bail out.
    if (bufA.length !== bufB.length) {
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

export const authMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers['authorization'];
    const validKey = process.env.API_KEY;

    if (!validKey) {
        console.error('API_KEY is not defined in environment variables');
        res.status(500).json({ error: 'Internal Server Error: Security configuration missing' });
        return;
    }

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Unauthorized: Missing or malformed Authorization header' });
        return;
    }

    const token = authHeader.slice(7);
    if (!timingSafeEqualStrings(token, validKey)) {
        res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
        return;
    }

    next();
};
