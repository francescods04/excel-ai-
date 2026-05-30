-- Migration 003: Create admin user demo@excelai.test
-- Run this in the Supabase SQL Editor (https://app.supabase.com)
--
-- This inserts (or updates) the demo admin account with plan = 'admin'.
-- Password is hashed with bcrypt (Supabase default).

INSERT INTO auth.users (
  id,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  created_at,
  updated_at
)
VALUES (
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',  -- deterministic UUID (optional, remove if you want random)
  'demo@excelai.test',
  crypt('Demo1234!', gen_salt('bf')),
  now(),
  '{"plan":"admin"}'::jsonb,
  now(),
  now()
)
ON CONFLICT (email) DO UPDATE SET
  encrypted_password = EXCLUDED.encrypted_password,
  raw_app_meta_data = EXCLUDED.raw_app_meta_data,
  email_confirmed_at = COALESCE(auth.users.email_confirmed_at, now()),
  updated_at = now();

-- Also ensure the user profile exists in user_settings (optional but clean)
INSERT INTO user_settings (user_id, settings_json, updated_at)
SELECT
  (SELECT id FROM auth.users WHERE email = 'demo@excelai.test'),
  '{}'::jsonb,
  now()
ON CONFLICT (user_id) DO NOTHING;
