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

## Transport and identity roadmap

The service core should remain transport-neutral. Planned adapters are:

- Streamable HTTP MCP
- REST/JSON-RPC
- local socket/stdio
- platform plugin manifests
- optional Watchtower/event adapters

Remote OAuth/OIDC, API keys, and local bearer credentials should all resolve to
the same neutral principal shape: issuer, subject, tenant, installation,
component, and scopes. No model-supplied identity fields are trusted.

## Deployment status

The D1 adapter and migrations are implemented locally. Cloudflare database
creation, migration application, OAuth configuration, and Worker deployment are
not complete until the Cloudflare account connection is authenticated and the
production resource identifiers are available.
