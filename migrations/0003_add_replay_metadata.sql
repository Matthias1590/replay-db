-- Migration number: 0003 	 2026-09-18T22:46:31.632Z

ALTER TABLE replays ADD COLUMN map TEXT;
ALTER TABLE replays ADD COLUMN game_version TEXT;
ALTER TABLE replays ADD COLUMN duration_ms INTEGER;
ALTER TABLE replays ADD COLUMN processing_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE replays ADD COLUMN processed_at INTEGER;

CREATE TABLE replay_players (
    replay_hash TEXT NOT NULL,
    player_id TEXT NOT NULL,
    team INTEGER NOT NULL,
    agent TEXT NOT NULL,

    PRIMARY KEY (replay_hash, player_id),
    FOREIGN KEY (replay_hash) REFERENCES replays(verified_hash)
);
