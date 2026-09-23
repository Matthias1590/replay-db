UPDATE replays
SET game_version = substr(
    game_version,
    instr(game_version, 'release-') + length('release-')
)
WHERE game_version IS NOT NULL
  AND instr(game_version, 'release-') > 0;
