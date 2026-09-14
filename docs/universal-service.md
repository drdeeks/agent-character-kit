# Universal ACK Service

The remote service is a provider-neutral ACK boundary. ChatGPT, Codex, Claude,
Watchtower, CI systems, and custom agents are clients or adapters; none is the
service's architectural owner.

## Current implementation

The first service implementation remains in `apps/chatgpt-ack-mcp/` for package
compatibility. Its legacy directory/name does not define the service identity.
The Worker selects storage in this order:

1. `env.ACK_STORE` for tests or an injected implementation;
2. `env.ACK_DB` through `D1Store` in production;
3. `MemoryStore` only as a local/test fallback.

Provider and default-agent identity are configurable with:

```text
ACK_PROVIDER=your-provider
ACK_DEFAULT_AGENT=your-agent
```

The default values preserve existing 1.x compatibility and should not be used
as the long-term universal identity model.

## Extension boundary

Future components should register namespaced capabilities, attributes, events,
and storage migrations rather than adding provider-specific branches to the
policy engine:

```text
component:policy
component:attribute
component:event
component:transport
```

Reserved namespaces should use `ack.*`; external components should use a
component-qualified namespace such as `vendor.component.*`.

### Canonical telemetry

`enforcement_events` is the immutable fact stream. Version 2 events carry the
hierarchical session, episode, task, run, and event identifiers plus optional
model, component, action, observation, decision, outcome, metadata, and
redaction fields. The service records facts and never calculates rewards.

The registry tables make future components additive rather than hardcoded:

- `telemetry_components` records component versions, capabilities, event types,
  and attribute namespaces.
- `telemetry_attributes` records namespaced, versioned attribute definitions,
  data types, sensitivity, and requiredness.
- `telemetry_event_schemas` records event-type compatibility versions.
- `telemetry_interventions` records the component, policy, requirements, and
  resolution linkage for every intervention.

Character Kit, The Gate, monitors, watchdogs, pollers, and future policy
components register themselves and emit the same event vocabulary. Dataset
builders derive RL, SFT, preference, evaluation, replay, and analytics datasets
downstream from the raw stream.

## Transport and identity roadmap

The service core should remain transport-neutral. Planned adapters are:

- Streamable HTTP MCP
- REST/JSON-RPC
- local socket/stdio
- platform plugin manifests
- optional Watchtower/event adapters

The same service can also expose CLI/admin operations and webhook or batch event
ingestion. ChatGPT remains one adapter, not the service identity.

Remote OAuth/OIDC, API keys, and local bearer credentials should all resolve to
the same neutral principal shape: issuer, subject, tenant, installation,
component, and scopes. No model-supplied identity fields are trusted.

## Deployment status

The `ack-universal` D1 database and base migrations are live. The universal
telemetry migration is committed locally and awaits the next authenticated
Cloudflare MCP session before it is applied remotely. OAuth configuration and
Worker deployment remain separate release steps.
