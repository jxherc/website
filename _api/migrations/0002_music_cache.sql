CREATE TABLE IF NOT EXISTS music_cache (
  key TEXT PRIMARY KEY,
  generation TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO music_settings(key,value)
VALUES('generation',lower(hex(randomblob(16))));
CREATE TRIGGER IF NOT EXISTS music_events_pause_insert AFTER INSERT ON music_events
BEGIN
  UPDATE music_settings SET value='paused' WHERE key='active' AND value='true';
END;
CREATE TRIGGER IF NOT EXISTS music_events_pause_update AFTER UPDATE ON music_events
BEGIN
  UPDATE music_settings SET value='paused' WHERE key='active' AND value='true';
END;
CREATE TRIGGER IF NOT EXISTS music_events_pause_delete AFTER DELETE ON music_events
BEGIN
  UPDATE music_settings SET value='paused' WHERE key='active' AND value='true';
END;
