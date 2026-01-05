# Identity Cache & Enrichment API

Service to ingest, normalize, and enrich identity data (Email, LinkedIn, Phone). It allows upserting profiles based on any normalized key and merging data into a unified profile.

## Features
- **Normalization**: Automatically cleans and formats:
  - Email (lowercase, trim)
  - LinkedIn URLs (extracts slugs)
  - Phone numbers (E.164 and national formats)
- **Identity Resolution**: Resolves profiles by Email > LinkedIn > Phone.
- **Data Merging**: Merges JSON data safely.

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
   - `SUPABASE_URL`: Your Supabase Project URL
   - `SUPABASE_ANON_KEY`: Your Supabase Anon Key

3. **Database Setup**:
   Run the SQL found in `src/db/schema.sql` in your Supabase SQL Editor.

## Usage

**Start Development Server**:
```bash
npm run dev
```

**API Endpoints**:

- `POST /profiles`: Upsert/Enrich a profile.
- `GET /profiles`: Query a profile by `email`, `linkedin`, or `phone`.

## Testing Normalization
Run the verification script:
```bash
npx ts-node src/verify_normalization.ts
```
