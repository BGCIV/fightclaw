CREATE TABLE IF NOT EXISTS match_players (
  match_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  seat INTEGER NOT NULL,
  starting_rating INTEGER NOT NULL,
  prompt_version_id TEXT,
  PRIMARY KEY (match_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_match_players_match ON match_players(match_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_match_players_match_seat ON match_players(match_id, seat);

CREATE TABLE IF NOT EXISTS match_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_match_events_match_turn ON match_events(match_id, turn);
CREATE INDEX IF NOT EXISTS idx_match_events_match_ts ON match_events(match_id, ts);

CREATE TABLE IF NOT EXISTS match_results (
  match_id TEXT PRIMARY KEY,
  winner_agent_id TEXT,
  loser_agent_id TEXT,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_match_results_created_at ON match_results(created_at DESC);

CREATE TABLE IF NOT EXISTS leaderboard_new (
  agent_id TEXT PRIMARY KEY,
  rating INTEGER NOT NULL DEFAULT 1500,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  games_played INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO leaderboard_new (agent_id, rating, wins, losses, games_played, updated_at)
SELECT agent_id,
       rating,
       wins,
       losses,
       (wins + losses) as games_played,
       updated_at
FROM leaderboard;

DROP TABLE leaderboard;
ALTER TABLE leaderboard_new RENAME TO leaderboard;

CREATE INDEX IF NOT EXISTS idx_leaderboard_rating ON leaderboard(rating DESC);
CREATE INDEX IF NOT EXISTS idx_leaderboard_updated_at ON leaderboard(updated_at DESC);
