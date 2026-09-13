# npm packaging audit — Agent Character Kit 1.6.0

> Historical snapshot of kit **1.6.0**. Live kit is **1.7.0**; `files[]` now includes `install.sh` and `packages/`. Tests stay git-tracked and are excluded from the tarball.

Date: 2026-09-13. Command run from the kit repo root: `npm pack --dry-run --json --ignore-scripts`. No publish. No gateway restart. No `files[]` / ignore patches applied in this pass.

Published identity in root `package.json`: name `@drdeeks/character-kit`, version `1.6.0`, `bin.ack` / `bin.character-kit` → `node/bin/ack.js`, `main` → `node/src/index.js`, `workspaces` → `packages/*`, `plugins/openai`, `plugins/hermes`. Root runtime dependencies: `commander`, `gray-matter`, `js-yaml`. Nested `node/package.json` repeats the same name and version with a different description.

## Dry-run evidence

`npm pack --dry-run --json` succeeded.

| Field | Value |
| --- | --- |
| id | `@drdeeks/character-kit@1.6.0` |
| filename | `drdeeks-character-kit-1.6.0.tgz` |
| entryCount | 212 |
| packed size | 231769 bytes |
| unpacked size | 800918 bytes |
| bundled | none |

No tarball was written next to the repo (dry-run only). Packed size is small; this is not a huge archive.

Always-included npm files present: `package.json`, `README.md`, `LICENSE`, `CHANGELOG.md`. `AGENTS.md` is present because it is in `files[]`.

Must-ship CLI / daemon path that **did** pack:

- `node/bin/ack.js`, `node/bin/install.js`, `node/bin/postinstall.js`, `node/bin/preuninstall.js`
- `node/src/index.js`, `node/src/agent-identity.js`, `node/src/manage-menu.js`, `node/src/version.js`, `node/src/enforcer/client.js`, `node/src/hooks/character.js`, `node/src/habits/build.js`, plus knowledge/memory/events
- `node/enforcer/agent_enforcer_daemon.js`
- `deploy/` including `deploy/supervise.py`, monitor/watchdog JS+Python, systemd units, `deploy-agent-enforcer.sh`, `deploy-ack-services.sh`
- `python/hermes_plugin/` (`__init__.py`, `plugin.yaml`, `config.yaml`, `README.md`)
- `python/agent_character_kit/` (Python client)
- `packages/protocol/`, `packages/core/`, `packages/companion/`, `packages/events/` (source + package.json; protocol schemas packed)
- `plugins/openai/plugin.json`, `plugins/openai/.codex-plugin/plugin.json`, `hooks/`, `skills/**` including `references/`
- `plugins/claude/` (`.claude-plugin/plugin.json`, hooks, skills, references)
- `plugins/hermes/package.json` + `src/index.js`

Not packed (and confirmed absent from the 212-file list): `node_modules/`, `.trash/`, `.env`, `docs/reviews/`, `docs/HABIT_POLICY.md`, `install.sh`, `.agents/plugins/marketplace.json`, `node/corpus/`, root `VERSION`.

No root `.npmrc`. The only project `.npmignore` is `node/.npmignore` (legacy from when `node/` was the publish root).

Live comparison: a previously installed global copy of `@drdeeks/character-kit@1.5.0` has nested `node_modules/gray-matter` (and `commander`, `js-yaml`) inside the package directory. Root `dependencies` therefore install on a real `npm i -g`. That 1.5.0 tree had no `workspaces`, no `packages/`, no `plugins/`, no `AGENTS.md`, and no `VERSION`.

### Workspace name-imports vs files on disk

`files[]` includes `packages/` and `plugins/`, so the source lands on disk after install. That is **not** enough for bare specifiers to resolve.

These modules import workspace package names:

- `packages/core` → `@drdeeks/character-kit-protocol`
- `packages/companion` → `@drdeeks/character-kit-core`, `@drdeeks/character-kit-protocol`
- `plugins/openai/src` and `plugins/hermes/src` → `@drdeeks/character-kit-companion`, `@drdeeks/character-kit-protocol`

Root `dependencies` do **not** list those workspace names. `workspaces` is a local-dev field; `npm i -g` of the umbrella tarball does not link `node_modules/@drdeeks/character-kit-protocol` (or core/companion/events/openai/hermes). `bundled` in the dry-run is empty.

The live 1.6.0 CLI does **not** use those specifiers. `ack.js` and the OpenAI/Claude hook scripts import relative files under `node/src/`. Relative hooks keep working after a global install.

v2 adapters (`plugins/openai/src/index.js`, `plugins/hermes/src/index.js`, `packages/*`) will throw `ERR_MODULE_NOT_FOUND` after `npm i -g @drdeeks/character-kit` unless those packages are published separately and added to root `dependencies`, or the root package grows `exports` subpaths and the adapters import those.

### postinstall fixture vs real `npm i -g`

`node/tests/postinstall.test.js` copies only `node/` plus root `package.json` into a fake `node_modules/@drdeeks/character-kit` tree. `postinstall.js` statically imports `install.js`, which statically imports `agent-identity.js`, which imports `gray-matter`.

That fixture is **not** a real global install: it never runs `npm install`, so it never materializes `gray-matter`. Real `npm i -g` does, because `gray-matter` is a root dependency (proven by the 1.5.0 global tree’s nested `node_modules/gray-matter`). `files[]` and `workspaces` do **not** strip or hoist away `gray-matter` for a published umbrella install.

`files[]` also does not need to include `node_modules/`; npm installs dependencies beside the extracted package.

### Package name: `@drdeeks/character-kit` vs `@character-kit`

| Surface | Name used |
| --- | --- |
| root `package.json` `name` | `@drdeeks/character-kit` |
| README install | `npm install -g @drdeeks/character-kit` |
| dry-run id | `@drdeeks/character-kit@1.6.0` |
| `AGENTS.md` wiring line | `npm i -g @character-kit && ack configure` |
| nested `node/package.json` description | “reference as @character-kit” |
| `node/bin/install.js` file comment | `@character-kit interactive installer` |

The registry package is scoped `@drdeeks/character-kit`. Unscoped `@character-kit` is a different name. README matches the real name. `AGENTS.md` and nested `node/package.json` still advertise the unscoped alias.

Version stamps that **do** pack: `node/src/version.js` (`VERSION = "1.6.0"`), root `package.json`, nested `node/package.json`, `python/hermes_plugin/__init__.py` `ACK_VERSION`, `python/pyproject.toml`. Runtime CLI/daemon read `node/src/version.js`, not the root `VERSION` file. `python/hermes_plugin/plugin.yaml` still says `version: "1.0.0"` while the rest of the kit is 1.6.0.

## Must-ship missing

| Path / capability | Packed? | Notes |
| --- | --- | --- |
| root `VERSION` | **No** | AGENTS.md file map and version-tracking section name this stamp. Runtime does not read it (`node/src/version.js` is packed). Still a documented ship file. |
| `@drdeeks/character-kit-protocol` (and core/companion/events) as resolvable modules | **No** | Source files pack; bare specifiers do not resolve after `npm i -g`. |
| `install.sh` | No | README installs it from GitHub `main`, not from the npm tarball. Not required for the `ack` CLI. |
| `.agents/plugins/marketplace.json` | No | Local Codex marketplace pointer (`path: "./plugins/openai"`). Correct to keep out of npm. |
| `node/corpus/` | No | AGENTS.md calls this library-only leftover docs. Not on the CLI path. |

Everything else on the requested must-ship list is in the 212-file tarball, including `plugins/openai/plugin.json`, OpenAI skills + references, `.codex-plugin`, Claude plugin layout, `deploy/supervise.py`, `python/hermes_plugin`, `AGENTS.md`, `LICENSE`.

## Should-not-ship present

| Path | Why it should not ship |
| --- | --- |
| `node/tests/` (14 files) | `files[]` explicitly includes `node/tests/`. `ack-configure.test.js`, `ack-manage.test.js`, `ack-monitor-multi-agent.test.js`, `install.test.js`, `preuninstall.test.js` spawn a live daemon / scan `/proc` / `pkill`. |
| `python/tests/` | Packed because `files[]` has `python/`. |
| `python/hermes_plugin/test_plugin.py` | Test module next to the advertised companion. |
| `packages/core/src/policy/engine.test.js` | Packed via `packages/`. |
| `packages/protocol/src/envelope.test.js` | Packed via `packages/`. |
| `plugins/openai/src/plugin-manifest.test.js` | Packed via `plugins/`. |
| `node/examples/.agent/logs/enforcer-audit.jsonl` | Example audit log. `node/.npmignore` would have dropped `*.audit.jsonl`, but that nested ignore is **not** applied to the root pack (this file is in the dry-run list). |
| nested `node/package.json` | Same `name` as the root package (`@drdeeks/character-kit`), stale `@character-kit` description, `main`/`bin` paths relative to `node/` not the tarball root. Not read by the CLI. Confusing if someone treats `node/` as a second package. |

Not present (good): `node_modules/`, `.trash/`, secrets, `.env`, coverage trees, `docs/reviews/`. Example habit YAMLs under `node/examples/` and `python/example_workspace/` are fixtures, small, and useful; keep them.

`docs/refactor-plan.md` is in `files[]` on purpose (AGENTS.md points at it). Leave it.

`workspaces` in the published `package.json` is not a packed path, but it is a published-config footgun: it documents a monorepo that `npm i -g` will not assemble.

## gitignore

Root `.gitignore` **does** ignore: `node_modules/`, `__pycache__/`, `*.py[cod]`, `.env`, `.env.*`, `*.pem`, `*.key`, `.trash/`, `dist/`, `*.tar.gz`, `*.tgz`, `*.zip`, `enforcer-audit.jsonl`, `*.audit.jsonl`, `.agent/` (with `!node/examples/.agent/` and `!python/example_workspace/.agent/` re-included).

It does **not** ignore source the repo needs: `packages/`, `plugins/`, `AGENTS.md`, `VERSION`, `deploy/`, `python/` are unignored.

Gaps:

- No `coverage/`, `.nyc_output/`, `htmlcov/`, `.coverage`, `*.lcov`
- Logs only as `node/*.log` plus npm/yarn debug logs, not `*.log`
- No `*.sock`. Typical enforcer sockets live under `.agent/`, which is ignored, so a root-level socket would not be ignored
- No `*.log` under `deploy/`, `python/`, or plugin trees

`.gitignore` is doing double duty as the npm ignore file (see next section). Tightening coverage/sockets/logs is safe for git and for pack.

## npmignore/files

There is **no root `.npmignore`**. npm-packlist therefore uses root `.gitignore` as the ignore file, after the `files[]` allowlist.

How the intersection actually worked on this dry-run:

1. `files[]` is the allowlist (`node/bin/`, `node/src/`, `node/enforcer/`, `node/examples/`, `node/tests/`, `node/package.json`, `packages/`, `plugins/`, `python/`, `deploy/`, selected docs, README/AGENTS/CHANGELOG/LICENSE, plus pycache negations).
2. npm always adds `package.json`, README, LICENSE, CHANGELOG even if omitted.
3. Root `.gitignore` then subtracts (`.env`, `node_modules/`, `__pycache__/`, `*.audit.jsonl` except where a later un-ignore wins, `.trash/`, archives).
4. `!node/examples/.agent/` in `.gitignore` re-includes the example workspace, **including** `node/examples/.agent/logs/enforcer-audit.jsonl`.
5. Nested `node/.npmignore` did **not** filter the root pack. Proof: it lists `enforcer-audit.jsonl` and `*.audit.jsonl`, yet the example audit log is in the 212-file list.

`files[]` wins as the include set; ignore files only subtract. `packages/protocol/package.json` has its own `files: ["src/", "schemas/"]` — that applies only if that workspace is packed/published as its own package, not to this umbrella tarball.

One source of truth: keep root `files[]` as the positive allowlist for npm, keep `.gitignore` for git, and add a **root** `.npmignore` only for classes that must never ship even if someone later adds them to `files[]` (tests, coverage, env, sockets, audit logs). Stop treating `node/.npmignore` as live publish config; it is leftover and currently inert. If replaced, move the old file to `.trash/npmignore-superseded-2026-09-13/.npmignore` rather than `rm`.

Do not publish `workspaces` as if they install themselves. Either publish `@drdeeks/character-kit-*` separately and depend on them from the root, or add root `exports` subpaths and import those.

## Recommended package.json files[] and ignore patches

Recommended root `files[]` (replace the current array). Drops tests, drops nested `node/package.json`, adds `VERSION`, keeps the CLI/daemon/plugins/packages/Hermes companion/deploy path:

```json
"files": [
  "VERSION",
  "node/bin/",
  "node/src/",
  "node/enforcer/",
  "node/examples/",
  "packages/",
  "plugins/",
  "python/agent_character_kit/",
  "python/hermes_plugin/",
  "python/example_workspace/**",
  "python/pyproject.toml",
  "deploy/",
  "docs/protocol/",
  "docs/adapters/",
  "docs/refactor-plan.md",
  "README.md",
  "AGENTS.md",
  "CHANGELOG.md",
  "LICENSE",
  "!**/*.test.js",
  "!**/test_*.py",
  "!**/tests/**",
  "!**/__pycache__/**",
  "!**/*.pyc",
  "!**/*.pyo",
  "!**/*.audit.jsonl"
]
```

Optional root `exports` if v2 adapters must resolve from the umbrella package without a second publish (adapters would then import these subpaths, not `@drdeeks/character-kit-protocol`):

```json
"exports": {
  ".": "./node/src/index.js",
  "./protocol": "./packages/protocol/src/index.js",
  "./core": "./packages/core/src/index.js",
  "./companion": "./packages/companion/src/index.js",
  "./events": "./packages/events/src/index.js"
}
```

Recommended additions to root `.gitignore` (append; do not replace the file):

```gitignore
# ===== Coverage =====
coverage/
.nyc_output/
htmlcov/
.coverage
*.lcov

# ===== Runtime sockets / logs =====
*.sock
*.log
```

Recommended **new root** `.npmignore` (npm-only belt; `files[]` remains the allowlist):

```gitignore
node_modules/
coverage/
.nyc_output/
htmlcov/
.coverage
*.lcov
__pycache__/
*.pyc
*.pyo
.env
.env.*
*.sock
*.log
*.tgz
*.tar.gz
*.audit.jsonl
enforcer-audit.jsonl
**/*.test.js
**/tests/
python/hermes_plugin/test_plugin.py
.trash/
```

Name-doc patch (not publish-config, but it is the README/`AGENTS.md` mismatch): in `AGENTS.md` change `npm i -g @character-kit` to `npm i -g @drdeeks/character-kit`. In nested `node/package.json`, drop the unscoped `@character-kit` claim or delete that file from `files[]` as above.

Re-prove after any real patch with `npm pack --dry-run --json --ignore-scripts` and confirm: `VERSION` present, `node/tests/` absent, `plugins/openai/plugin.json` present, `node/enforcer/agent_enforcer_daemon.js` present, `packages/protocol/src/index.js` present, `python/hermes_plugin/__init__.py` present, `entryCount` lower than 212.

This review did not apply those patches.
