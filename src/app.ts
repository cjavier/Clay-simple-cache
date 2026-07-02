import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import router from './routes';

const app = express();

// CORS: restrict to ALLOWED_ORIGINS (comma-separated) when configured; otherwise
// keep the current open behavior so existing server-side integrations don't break.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

app.use(cors(allowedOrigins.length > 0 ? { origin: allowedOrigins } : undefined));

app.use(express.json({ limit: '1mb' }));

// Rate limiting: a generous global limit for all requests, plus a stricter
// limit on the costly/external-API-backed endpoints.
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN) || 300;
const COSTLY_RATE_LIMIT_PER_MIN = Number(process.env.COSTLY_RATE_LIMIT_PER_MIN) || 30;

const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: RATE_LIMIT_PER_MIN,
    standardHeaders: true,
    legacyHeaders: false,
});

const costlyLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: COSTLY_RATE_LIMIT_PER_MIN,
    standardHeaders: true,
    legacyHeaders: false,
});

const COSTLY_PATHS = ['/find', '/verify', '/detect-tech', '/copy', '/explore', '/find-linkedin'];

app.use(globalLimiter);
app.use(COSTLY_PATHS, costlyLimiter);

app.use(router);

// Health check
app.get('/health', (req, res) => {
    res.send('OK');
});

export default app;
