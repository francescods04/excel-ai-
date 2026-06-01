-- Migration 005: Demo leads table
-- Richieste demo dal form di francescodelsesto.com

CREATE TABLE IF NOT EXISTS demo_leads (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now(),

  nome TEXT NOT NULL,
  cognome TEXT NOT NULL,
  email TEXT NOT NULL,
  azienda TEXT NOT NULL,
  ruolo TEXT NOT NULL,

  source TEXT DEFAULT 'landing',
  user_agent TEXT,
  referer TEXT,
  ip TEXT,

  status TEXT NOT NULL DEFAULT 'new',
  contacted_at TIMESTAMPTZ,
  notes TEXT
);

CREATE INDEX idx_demo_leads_created ON demo_leads(created_at DESC);
CREATE INDEX idx_demo_leads_email ON demo_leads(email);
CREATE INDEX idx_demo_leads_status ON demo_leads(status);
