CREATE TABLE IF NOT EXISTS music_events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  played_at INTEGER NOT NULL,
  played_ms INTEGER NOT NULL CHECK (played_ms >= 0),
  name TEXT NOT NULL,
  artist TEXT NOT NULL,
  album TEXT NOT NULL,
  track_key TEXT NOT NULL,
  album_key TEXT NOT NULL,
  artists TEXT NOT NULL,
  image TEXT NOT NULL,
  url TEXT NOT NULL,
  album_image TEXT NOT NULL,
  album_url TEXT NOT NULL,
  metadata_missing INTEGER NOT NULL DEFAULT 0,
  fingerprint TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS music_events_time ON music_events(played_at);
CREATE INDEX IF NOT EXISTS music_events_source ON music_events(source);
CREATE TABLE IF NOT EXISTS music_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
