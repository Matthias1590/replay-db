-- Migration number: 0005 	 2026-09-18T23:30:04.324Z

PRAGMA foreign_keys = OFF;

CREATE TABLE uploaders_new (
    token TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    successful_uploads INTEGER NOT NULL DEFAULT 0,
    duplicate_uploads INTEGER NOT NULL DEFAULT 0,
    invalid_uploads INTEGER NOT NULL DEFAULT 0
);

INSERT INTO uploaders_new
SELECT
    token,
    strftime('%s', created_at),
    successful_uploads,
    duplicate_uploads,
    invalid_uploads
FROM uploaders;

CREATE TABLE replays_new (
    verified_hash TEXT PRIMARY KEY,
    storage_key TEXT NOT NULL,
    uploader_token TEXT NOT NULL REFERENCES uploaders_new(token),
    size_bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO replays_new
SELECT
    verified_hash,
    storage_key,
    uploader_token,
    size_bytes,
    strftime('%s', created_at)
FROM replays;

DROP TABLE replays;
DROP TABLE uploaders;

ALTER TABLE uploaders_new RENAME TO uploaders;
ALTER TABLE replays_new RENAME TO replays;

PRAGMA foreign_keys = ON;
