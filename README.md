# Identity Cache & Enrichment API

Service to ingest, normalize, and enrich identity data (Profiles & Companies). It allows upserting records based on normalized keys and merging data into a unified record.

## Features
- **Profiles**:
  - Normalization: Email, LinkedIn (Slug & Full URL), Phone.
  - Resolution: Email > LinkedIn URL > LinkedIn Slug > Phone.
- **Companies**:
  - Normalization: Domain (trim, lowercase, remove www/protocol), LinkedIn.
  - Resolution: Domain > LinkedIn.
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

**API Endpoints**:

See full documentation at `GET /docs/api` or visit `http://localhost:3000/docs/api` locally.

- **Profiles**
  - `POST /profiles`: Upsert/Enrich a profile.
  - `GET /profiles`: Query by `email`, `linkedin`, or `phone`.

- **Companies**
  - `POST /companies`: Upsert/Enrich a company.
  - `GET /companies`: Query by `domain` or `linkedin`.

## Testing Normalization
Run the verification scripts:
```bash
npx ts-node src/verify_normalization.ts # Profiles
npx ts-node src/verify_companies.ts     # Companies
```
