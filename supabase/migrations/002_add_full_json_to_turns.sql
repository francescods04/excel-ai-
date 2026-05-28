-- Migration 002: Add full_json to turns for serverless state hydration
-- Da eseguire nella SQL Editor di Supabase (https://app.supabase.com)

-- ============================================================
-- TURNS: add full_json column for cross-instance state recovery
-- ============================================================
ALTER TABLE turns ADD COLUMN IF NOT EXISTS full_json JSONB;

-- Optional: index to speed up lookups by status when hydrating
CREATE INDEX IF NOT EXISTS idx_turns_full_json ON turns(id) WHERE full_json IS NOT NULL;

-- Update policy: full_json should be readable/writable by the owner
-- (already covered by "Users manage own turns" policy from 001)
