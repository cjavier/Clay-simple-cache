# Identity Cache & Enrichment API

Service to ingest, normalize, and enrich identity data (Email, LinkedIn, Phone). It allows upserting profiles based on any normalized key and merging data into a unified profile.

## Features
- **Normalization**: Automatically cleans and formats:
  - Email (lowercase, trim)
  - LinkedIn URLs (extracts slugs)
  - Phone numbers (E.164 and national formats)
- **Identity Resolution**: Resolves profiles by Email > LinkedIn > Phone.
- **Data Merging**: Merges JSON data safely.
- **ORM**: Builds on **Prisma** for type-safe database interactions.

## Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Environment Variables**:
   Copy `.env.example` to `.env` and add your keys:
   ```bash
   cp .env.example .env
   ```
   
   Required variables:
   - `PORT`: Server port (default 3000)
   - `DATABASE_URL`: Connection Pool URL (Transaction Mode, Port 6543)
   - `DIRECT_URL`: Direct Connection URL (Session Mode, Port 5432)

3. **Database Setup**:
   Push the schema to your database:
   ```bash
   npm run prisma:push
   ```

## Usage

**Start Development Server**:
```bash
npm run dev
```

**Production Build**:
```bash
npm run build
npm start
```

**Prisma Tools**:
- `npm run prisma:studio`: Open database GUI.
- `npm run prisma:generate`: Regenerate Prisma Client.

**API Endpoints**:

- `POST /profiles`: Upsert/Enrich a profile.
- `GET /profiles`: Query a profile by `email`, `linkedin`, or `phone`.

## Testing Normalization
Run the verification script:
```bash
npx ts-node src/verify_normalization.ts
```
