import { Request, Response, NextFunction } from 'express';

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
    if (token !== validKey) {
        res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
        return;
    }

    next();
};
