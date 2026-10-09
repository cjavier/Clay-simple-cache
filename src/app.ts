import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import router from './routes';

const app = express();
// Railway puts one proxy in front of us. Without this every request looks like
// it comes from the proxy, so all callers (Clay, MailBridge, scripts) shared a
// single rate-limit bucket, and express-rate-limit logged ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
app.set('trust proxy', 1);

// CORS: restrict to ALLOWED_ORIGINS (comma-separated) when configured; otherwise
// keep the current open behavior so existing server-side integrations don't break.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

app.use(cors(allowedOrigins.length > 0 ? { origin: allowedOrigins } : undefined));

// Lists arrive as up to 5,000 rows per POST /tables/:id/rows; everything else
// keeps the 1 MB cap.
const jsonSmall = express.json({ limit: '1mb' });
const jsonLarge = express.json({ limit: '15mb' });
// MailBridge's outcome webhook is verified against the exact bytes it signed,
// so its parser keeps the raw body alongside the parsed one.
const jsonSigned = express.json({
    limit: '15mb',
    verify: (req, _res, buf) => {
        (req as any).rawBody = buf;
    },
});
app.use((req, res, next) => {
    if (req.path === '/webhooks/mailbridge') return jsonSigned(req, res, next);
    return (/^\/tables\/[^/]+\/rows$/.test(req.path) ? jsonLarge : jsonSmall)(req, res, next);
});

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

// POST /emails/lookup is a free cache read that MailBridge calls once per row
// of a table's email column: it gets its own, larger bucket instead of eating
// the global one.
const LOOKUP_RATE_LIMIT_PER_MIN = Number(process.env.LOOKUP_RATE_LIMIT_PER_MIN) || 1200;
const lookupLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: LOOKUP_RATE_LIMIT_PER_MIN,
    standardHeaders: true,
    legacyHeaders: false,
});

app.use('/emails/lookup', lookupLimiter);
app.use((req, res, next) => (req.path === '/emails/lookup' ? next() : globalLimiter(req, res, next)));
app.use(COSTLY_PATHS, costlyLimiter);

app.use(router);

// Health check
app.get('/health', (req, res) => {
    res.send('OK');
});

export default app;
