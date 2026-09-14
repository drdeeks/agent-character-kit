# Agent Character Kit: ChatGPT Integration Specification

Status: definitive implementation target  
Date: 2026-09-13

## 1. Purpose

Agent Character Kit (ACK) must integrate with ChatGPT as a hosted application. ChatGPT users must not need a local daemon, `install.sh`, localhost ports, Cloudflare CLI knowledge, or an understanding of MCP.

The ChatGPT integration is a remote, authenticated MCP application backed by a Cloudflare Worker and persistent per-user configuration. The existing local installer remains valid for Codex and local harnesses, but it is not the ChatGPT execution path.

## 2. Required architecture

```text
ChatGPT custom app
        |
        | HTTPS + OAuth/authenticated MCP
        v
ACK ChatGPT Worker / MCP endpoint
        |
        +-- authenticated tenant and user resolution
        +-- policy/profile lookup
        +-- enforcement engine
        +-- audit and watchdog events
        |
        +--> D1: durable relational configuration and audit records
        +--> Durable Object: serialized session/hold/watchdog state when needed
        +--> Queues/Workflows: asynchronous retries, notifications, repair jobs
```

Cloudflare Workers are the request runtime. D1 is the system of record. Durable Objects are optional and should be used for state that requires per-user or per-session serialization. Do not describe the Worker as one global in-memory daemon; instances are ephemeral.

Cloudflare documents D1 as a managed serverless SQLite database accessed through Worker bindings, and provides a remote MCP-server deployment path for Workers. See:

- https://developers.cloudflare.com/d1/
- https://developers.cloudflare.com/d1/worker-api/
- https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/

## 3. ChatGPT platform requirements

The hosted integration must provide:

1. A public HTTPS MCP endpoint. `127.0.0.1`, private LAN URLs, and local filesystem paths are not valid ChatGPT endpoints.
2. Authentication that identifies the ChatGPT user or workspace. The server must derive identity from the authenticated connection, never from a model-supplied `user_id` argument.
3. An OAuth or equivalent authorization flow appropriate to the selected ChatGPT workspace/app deployment.
4. Explicit tool definitions with human-readable names, descriptions, input schemas, output schemas, and read/write safety classification.
5. A configuration experience exposed through ChatGPT tools and, where useful, an Apps SDK UI.
6. Tool responses that make enforcement state explicit: allowed, held, denied, acknowledged, or unavailable.
7. Server-side isolation between users, workspaces, installations, agents, profiles, and conversations.
8. Operational logging, rate limiting, error handling, revocation, and data deletion controls.

ChatGPT custom apps use remote MCP servers; local MCP servers are not directly connectable. Full MCP support, including write/modify actions, is plan- and workspace-dependent. OpenAI’s current guidance is:

- https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt
- https://help.openai.com/en/articles/11487775-connectors-in-chatgpt
- https://help.openai.com/en/articles/11509118

These platform policies must be rechecked before launch because availability and UI may change.

## 4. Tenant and identity model

Every request must resolve this context before reading or writing state:

```text
provider = chatgpt
workspace_id
user_id
installation_id
agent_id or agent_context_id
conversation_id, if available
active_profile_id
```

Recommended ownership rules:

- A user owns personal profiles and personal habits.
- A workspace owns shared profiles and workspace policies.
- An installation binds a ChatGPT app authorization to a user/workspace.
- An agent binding selects the active profile for one agent or harness.
- A conversation may temporarily override presentation preferences, but must not silently bypass workspace or profile enforcement.

## 5. Minimum D1 schema

The deployment must ship migrations for at least these tables:

```text
users
workspaces
workspace_members
installations
agents
character_profiles
habits
enforcement_policies
agent_profile_bindings
tool_decisions
holds
acknowledgments
watchdog_state
audit_events
consents
```

Minimum common columns:

```text
id
tenant_id or workspace_id
owner_user_id, where applicable
created_at
updated_at
version
status
```

Required constraints and indexes:

- Unique external identity per provider and tenant.
- Unique active profile binding per installation/agent.
- Foreign keys or application-level referential checks for every binding.
- Indexes on `(workspace_id, user_id)`, `(installation_id, agent_id)`, `(profile_id, status)`, and decision timestamps.
- Version or optimistic-concurrency field on mutable profiles and policies.
- No plaintext access tokens, refresh tokens, or provider secrets in D1.

## 6. Configuration model

Configuration must be declarative and exportable. A profile should contain:

```json
{
  "profileId": "profile_...",
  "name": "strict-engineer",
  "mode": "fail-closed",
  "enabled": true,
  "habits": [],
  "toolRules": [],
  "acknowledgmentRules": [],
  "watchdog": {
    "enabled": true,
    "staleAfterSeconds": 120
  },
  "audit": {
    "retentionDays": 90
  }
}
```

The actual schema should be versioned. Every user-visible setting must have a safe default, validation, authorization check, and audit event.

## 7. MCP tool surface

Keep the public tool surface small. A first release should include:

### Read tools

- `ack_get_status`
- `ack_get_active_profile`
- `ack_list_profiles`
- `ack_get_policy`
- `ack_get_recent_decisions`

### Configuration tools

- `ack_create_profile`
- `ack_update_profile`
- `ack_select_profile`
- `ack_configure_habit`
- `ack_set_enforcement_mode`

### Enforcement tools

- `ack_check_action`
- `ack_acknowledge_hold`
- `ack_record_decision`
- `ack_report_watchdog_state`

Write tools must require authenticated ownership or workspace authorization. Never expose unrestricted SQL, arbitrary policy execution, token management, or raw D1 access to ChatGPT.

## 8. Enforcement contract

The enforcement engine must return a stable result such as:

```json
{
  "decision": "allow|hold|deny|acknowledge|unavailable",
  "decisionId": "decision_...",
  "profileId": "profile_...",
  "reasonCodes": ["habit_required"],
  "requiredAcknowledgment": false,
  "expiresAt": null,
  "nextAction": "continue|acknowledge_hold|reconfigure|retry"
}
```

The engine must be deterministic for the same policy version and input context. Every decision must record the policy/profile version used. A transient storage or Worker failure must produce an explicit `unavailable` result; it must not silently become `allow` when the selected mode is fail-closed.

## 9. Installation and user experience

The ChatGPT installation flow should be:

1. User adds/connects the ACK app.
2. OAuth establishes the user/workspace identity.
3. ACK creates an installation record and default profile if needed.
4. ChatGPT presents setup choices: profile, enforcement mode, habits, and watchdog behavior.
5. ACK stores the choices in D1.
6. The user can say “show my ACK status” or “configure my character” at any time.

`install.sh` remains for local harnesses. It should not be presented as a prerequisite for ChatGPT.

## 10. Security and policy requirements

- Enforce tenant isolation on every query and mutation.
- Validate all tool input server-side.
- Treat model-generated arguments as untrusted input.
- Require explicit authorization for profile and workspace changes.
- Separate read, configuration, and enforcement permissions.
- Encrypt or avoid storing provider credentials.
- Provide revoke, export, and delete-user-data operations.
- Record policy version, actor, installation, decision, and timestamp in audit events.
- Apply rate limits and abuse protection to configuration and write tools.
- Do not claim that ChatGPT’s app layer can enforce actions outside the tools and requests that actually pass through the ACK backend.
- Clearly disclose what data is stored, why it is stored, retention, and deletion behavior.

## 11. Watchdog design

The watchdog must be designed for a distributed serverless runtime:

- Store heartbeat and lease state in a Durable Object when ordering matters.
- Store durable summaries and audit history in D1.
- Use alarms, Queues, or Workflows for delayed checks and repair tasks.
- Make watchdog operations idempotent.
- Use leases/versions so a late request cannot overwrite newer state.
- Define recovery behavior when the watchdog is unavailable.

Do not rely on a process-global timer or memory variable inside a Worker.

## 12. Required repository structure

```text
apps/
  plugins/mcp-bridgelement/
    src/
      index.ts
      auth.ts
      tenant.ts
      tools/
      enforcement/
      storage/
      schemas/
    migrations/
    wrangler.jsonc
    README.md

packages/
  ack-core/
  ack-config-schema/
  ack-mcp-contract/

plugins/
  openai/                 # Codex compatibility plugin
    .codex-plugin/
    skills/
    hooks/

docs/
  GPT-INTEGRATION-SPEC.md
  PRIVACY.md
  TERMS.md
  SECURITY.md
```

The enforcement core should be shared by local and hosted adapters where practical. Cloudflare-specific authentication, D1 access, MCP transport, and Durable Object coordination should remain in the hosted adapter.

## 13. Deployment checklist

Before connecting ChatGPT:

- [ ] Worker deployed at a stable HTTPS hostname.
- [ ] MCP endpoint passes MCP Inspector or equivalent protocol tests.
- [ ] OAuth/authentication is configured and tested.
- [ ] D1 database created and all migrations applied.
- [ ] Secrets stored as Worker secrets, not source or D1 rows.
- [ ] Tenant isolation tests pass.
- [ ] Read-only tools tested.
- [ ] Write tools tested with authorization and negative cases.
- [ ] Fail-closed/fail-open behavior is explicitly verified.
- [ ] Watchdog and stale-hold recovery tested.
- [ ] Audit, retention, export, revoke, and deletion flows tested.
- [ ] Privacy policy and terms are published at stable HTTPS URLs.
- [ ] ChatGPT custom app is tested in the intended workspace plan.
- [ ] App approval/publishing process completed for the target workspace.

## 14. Definition of done

The integration is complete when a new ChatGPT user can connect the ACK app, configure a profile, and receive consistent enforcement without installing local software or knowing that MCP, Workers, D1, or Durable Objects exist; while the service can prove which authenticated user, profile, policy version, and decision produced every enforcement result.
