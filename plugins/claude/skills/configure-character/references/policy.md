# Allowed commands and hard constraints

## constitution.yaml

Path: `$AGENT_WORKSPACE/.agent/constitution.yaml`

`hard_constraints` is a list of glob-ish patterns. First match denies.
The embedded default list is only `rm -rf /`. Other shapes (`git push
--force`, `chmod 777`) are habits, not hard constraints. On-disk
`hard_constraints:` **replaces** the embedded array (shallow merge). A
file that lists only `git push --force` drops `rm -rf /` unless you keep
it in the file.

```yaml
hard_constraints:
  - rm -rf /
  - git push --force
  - DROP TABLE
```

## enforcer.yaml

Path: `$AGENT_WORKSPACE/.agent/enforcer.yaml`

- `deny:` extra deny patterns, combined with hard constraints
- `allow:` if this list is non-empty, anything not matching is denied
- Frequency keys live in [frequency.md](frequency.md)

Allow-list example:

```yaml
allow:
  - "ls*"
  - "echo*"
  - "cat*"
```

`git commit` is never blocked by the allow-list. Hard constraints and
secret-leak still apply to the commit message and diffs.

Matching is the daemon's glob (`*` as substring). Test with:

```
echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"},"hook_event_name":"PreToolUse"}' \
  | ack hook claude
```

Expect `permissionDecision: deny`.
