-- Migration 001: Core schema for Excel AI
-- Da eseguire nella SQL Editor di Supabase (https://app.supabase.com)

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- TURNS
-- ============================================================
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'planning',
  input_message_length INTEGER,
  input_language TEXT,
  plan_json JSONB,
  task_count INTEGER,
  action_count INTEGER,
  error_type TEXT,
  error_message TEXT,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  model TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  total_latency_ms INTEGER
);

CREATE INDEX idx_turns_user ON turns(user_id);
CREATE INDEX idx_turns_status ON turns(status);
CREATE INDEX idx_turns_created ON turns(created_at);

-- ============================================================
-- ACTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  params_json JSONB,
  result_json JSONB,
  success BOOLEAN DEFAULT false,
  latency_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_actions_turn ON actions(turn_id);

-- ============================================================
-- USER SETTINGS
-- ============================================================
CREATE TABLE IF NOT EXISTS user_settings (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  settings_json JSONB DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- EVENTS (telemetry)
-- ============================================================
CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ DEFAULT now(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  session_id TEXT,
  event_type TEXT NOT NULL,
  properties JSONB,
  latency_ms INTEGER,
  tokens_in INTEGER,
  tokens_out INTEGER,
  model TEXT,
  success BOOLEAN
);

CREATE INDEX idx_events_ts ON events(ts);
CREATE INDEX idx_events_type ON events(event_type);
CREATE INDEX idx_events_user ON events(user_id);

-- ============================================================
-- USER QUOTAS
-- ============================================================
CREATE TABLE IF NOT EXISTS user_quotas (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  daily_limit INTEGER DEFAULT 10,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_quotas ENABLE ROW LEVEL SECURITY;

-- Users can read/write their own turns
CREATE POLICY "Users manage own turns" ON turns
  FOR ALL USING (auth.uid() = user_id);

-- Users can read/write their own actions (via turn ownership)
CREATE POLICY "Users manage own actions" ON actions
  FOR ALL USING (turn_id IN (SELECT id FROM turns WHERE user_id = auth.uid()));

-- Users can read/write their own settings
CREATE POLICY "Users manage own settings" ON user_settings
  FOR ALL USING (auth.uid() = user_id);

-- Users can read their own events
CREATE POLICY "Users read own events" ON events
  FOR SELECT USING (auth.uid() = user_id);

-- Users can read their own quota
CREATE POLICY "Users read own quota" ON user_quotas
  FOR SELECT USING (auth.uid() = user_id);

-- ============================================================
-- HELPER: count turns today for a user
-- ============================================================
CREATE OR REPLACE FUNCTION turns_today_for_user(uid UUID)
RETURNS INTEGER AS $$
  SELECT COUNT(*)::INTEGER FROM turns
  WHERE user_id = uid AND created_at::date = CURRENT_DATE;
$$ LANGUAGE sql STABLE;

-- ============================================================
-- HELPER: get or create user quota
-- ============================================================
CREATE OR REPLACE FUNCTION get_user_quota(uid UUID)
RETURNS INTEGER AS $$
  INSERT INTO user_quotas (user_id, daily_limit)
  VALUES (uid, 10)
  ON CONFLICT (user_id) DO NOTHING;
  SELECT daily_limit FROM user_quotas WHERE user_id = uid;
$$ LANGUAGE sql;

-- ============================================================
-- ADMIN: event counts in last 24 hours (bypass RLS for admin)
-- ============================================================
CREATE OR REPLACE FUNCTION admin_event_counts_24h()
RETURNS TABLE(event_type TEXT, count BIGINT) AS $$
  SELECT e.event_type, COUNT(*)::BIGINT
  FROM events e
  WHERE e.ts > now() - INTERVAL '24 hours'
  GROUP BY e.event_type
  ORDER BY count DESC;
$$ LANGUAGE sql STABLE SECURITY DEFINER;
