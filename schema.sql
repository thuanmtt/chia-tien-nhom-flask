-- Run this once against your Vercel/Neon Postgres database.
CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    event_code TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    members TEXT NOT NULL,
    expenses TEXT NOT NULL,
    bank_info TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_events_event_code ON events (event_code);
CREATE INDEX IF NOT EXISTS idx_events_updated_at ON events (updated_at DESC);
