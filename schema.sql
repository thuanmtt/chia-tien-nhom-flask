-- Run this once against your Vercel/Neon Postgres database.
CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    event_code TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    members TEXT NOT NULL,
    expenses TEXT NOT NULL,
    bank_info TEXT,
    couples TEXT NOT NULL DEFAULT '[]',
    rates TEXT NOT NULL DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_events_event_code ON events (event_code);
CREATE INDEX IF NOT EXISTS idx_events_updated_at ON events (updated_at DESC);

-- Migration an toàn cho DB đã deploy (chạy lại nhiều lần không sao):
ALTER TABLE events ADD COLUMN IF NOT EXISTS couples TEXT NOT NULL DEFAULT '[]';
ALTER TABLE events ADD COLUMN IF NOT EXISTS rates TEXT NOT NULL DEFAULT '{}';
