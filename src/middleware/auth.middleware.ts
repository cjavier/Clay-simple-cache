import { Request, Response, NextFunction } from 'express';

export const authMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    const apiKey = req.headers['x-api-key'];
    const validKey = process.env.API_KEY;

    if (!validKey) {
        console.error('API_KEY is not defined in environment variables');
        res.status(500).json({ error: 'Internal Server Error: Security configuration missing' });
        return;
    }

    if (!apiKey || apiKey !== validKey) {
        res.status(401).json({ error: 'Unauthorized: Invalid or missing API Key' });
        return;
    }

    next();
};
