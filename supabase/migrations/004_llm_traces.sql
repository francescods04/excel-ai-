-- Migration 004: persist LLM traces to Supabase so prod (Vercel ephemeral fs) survives cold-starts.
-- Stores the FULL Q/A text for every LLM call indexed by turn_id, so we can replay any production turn.

CREATE TABLE IF NOT EXISTS llm_traces (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  turn_id TEXT,
  trace_id TEXT,
  parent_turn_id TEXT,
  user_id UUID,
  event_type TEXT NOT NULL,             -- llm.request | llm.response | llm.error | llm.fallback
  label TEXT,
  role TEXT,                             -- triage | architect | worker | critic | etc.
  phase TEXT,                            -- planning | execution | architect | slice:<id>
  provider TEXT,
  model TEXT,
  attempt TEXT DEFAULT 'primary',
  workflow TEXT,
  source TEXT,
  latency_ms INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  json_mode BOOLEAN,
  message_summary JSONB,                 -- {count, chars, byRole}
  messages JSONB,                        -- truncated text per role
  response_text TEXT,                    -- full LLM output (truncated by writer)
  response_json JSONB,                   -- parsed response when JSON-mode
  error_json JSONB,
  extra_json JSONB,                      -- {jsonError, repaired, etc.}
  context_json JSONB
);

CREATE INDEX IF NOT EXISTS idx_llm_traces_turn ON llm_traces(turn_id);
CREATE INDEX IF NOT EXISTS idx_llm_traces_trace ON llm_traces(trace_id);
CREATE INDEX IF NOT EXISTS idx_llm_traces_ts ON llm_traces(ts DESC);
CREATE INDEX IF NOT EXISTS idx_llm_traces_label ON llm_traces(label);

-- Optional: TTL via cron (drop rows older than 14 days) — set up later if storage grows.
