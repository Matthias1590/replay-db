-- Migration number: 0006 	 2026-09-18T23:33:56.363Z

ALTER TABLE replays ADD COLUMN map TEXT;
ALTER TABLE replays ADD COLUMN game_version TEXT;
ALTER TABLE replays ADD COLUMN duration_ms INTEGER;
ALTER TABLE replays ADD COLUMN processing_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE replays ADD COLUMN processed_at INTEGER;
