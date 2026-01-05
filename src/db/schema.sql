-- Enable pgcrypto for UUID generation if not enabled
create extension if not exists "pgcrypto";

create table if not exists profiles (
  id uuid primary key default gen_random_uuid(),

  email text unique,
  linkedin_slug text unique,
  phone_e164 text unique,

  data jsonb not null default '{}'::jsonb,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Indices
create unique index if not exists profiles_email_idx on profiles(email) where email is not null;
create unique index if not exists profiles_linkedin_idx on profiles(linkedin_slug) where linkedin_slug is not null;
create unique index if not exists profiles_phone_idx on profiles(phone_e164) where phone_e164 is not null;
