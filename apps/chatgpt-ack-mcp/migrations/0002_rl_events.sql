-- Canonical telemetry / elementary RL facts. No rewards. No secrets.

CREATE TABLE IF NOT EXISTS enforcement_events (
  event_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  installation_id TEXT,
  event_type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  session_id TEXT,
  episode_id TEXT,
  task_id TEXT,
  run_id TEXT,
  agent_id TEXT,
  sequence INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  component TEXT,
  parent_event_id TEXT,
  schema_version TEXT NOT NULL DEFAULT '1',
  payload TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_ws_ts ON enforcement_events (workspace_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_events_ws_type ON enforcement_events (workspace_id, event_type);
CREATE INDEX IF NOT EXISTS idx_events_user_ts ON enforcement_events (workspace_id, owner_user_id, timestamp);
