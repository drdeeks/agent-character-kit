-- Provider-neutral telemetry registry and canonical event metadata.
-- Raw events remain facts; rewards and datasets are downstream concerns.

ALTER TABLE enforcement_events ADD COLUMN model_id TEXT;
ALTER TABLE enforcement_events ADD COLUMN model_version TEXT;
ALTER TABLE enforcement_events ADD COLUMN component_version TEXT;
ALTER TABLE enforcement_events ADD COLUMN action TEXT;
ALTER TABLE enforcement_events ADD COLUMN observation TEXT;
ALTER TABLE enforcement_events ADD COLUMN decision TEXT;
ALTER TABLE enforcement_events ADD COLUMN outcome TEXT;
ALTER TABLE enforcement_events ADD COLUMN metadata TEXT;
ALTER TABLE enforcement_events ADD COLUMN redaction_status TEXT NOT NULL DEFAULT 'redacted';

CREATE TABLE IF NOT EXISTS telemetry_components (
  workspace_id TEXT NOT NULL,
  component_id TEXT NOT NULL,
  version TEXT NOT NULL,
  display_name TEXT NOT NULL,
  capabilities TEXT NOT NULL DEFAULT '[]',
  event_types TEXT NOT NULL DEFAULT '[]',
  attribute_namespaces TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, component_id, version)
);

CREATE TABLE IF NOT EXISTS telemetry_attributes (
  workspace_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  data_type TEXT NOT NULL,
  schema TEXT NOT NULL,
  sensitivity TEXT NOT NULL DEFAULT 'metadata',
  required INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, namespace, name, version)
);

CREATE TABLE IF NOT EXISTS telemetry_event_schemas (
  workspace_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  version TEXT NOT NULL,
  schema TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, event_type, version)
);

CREATE TABLE IF NOT EXISTS telemetry_interventions (
  intervention_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  component_id TEXT NOT NULL,
  component_version TEXT,
  policy_id TEXT,
  policy_version TEXT,
  decision TEXT NOT NULL,
  requirements TEXT NOT NULL DEFAULT '[]',
  resolved_by TEXT,
  resolution_event_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_component ON enforcement_events (workspace_id, component, component_version);
CREATE INDEX IF NOT EXISTS idx_events_model ON enforcement_events (workspace_id, model_id, model_version);
CREATE INDEX IF NOT EXISTS idx_interventions_event ON telemetry_interventions (workspace_id, event_id);
CREATE INDEX IF NOT EXISTS idx_attributes_namespace ON telemetry_attributes (workspace_id, namespace, name);
