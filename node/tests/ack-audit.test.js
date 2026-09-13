import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { collectAuditRows, isDenied, parseJsonlLines } from "../../packages/cli/src/audit.js";

describe("ack audit reader", () => {
  it("parses JSONL and skips blank lines", () => {
    const rows = parseJsonlLines('{"decision":"allow"}\n\nnot-json\n{"decision":"deny"}\n');
    assert.equal(rows.length, 3);
    assert.equal(rows[0].decision, "allow");
    assert.equal(rows[1].raw, "not-json");
    assert.equal(rows[2].decision, "deny");
  });

  it("filters denied rows from enforcer-audit.jsonl", () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ack-audit-"));
    const dir = path.join(ws, ".agent", "logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "enforcer-audit.jsonl"), [
      JSON.stringify({ ts: "t1", decision: "allow", tool: "Bash" }),
      JSON.stringify({ ts: "t2", decision: "deny", tool: "Bash", reason: "rm -rf /" }),
    ].join("\n") + "\n");
    const all = collectAuditRows({ ws, source: "enforcer" });
    const denied = collectAuditRows({ ws, source: "enforcer", deniedOnly: true });
    assert.equal(all.rows.length, 2);
    assert.equal(denied.rows.length, 1);
    assert.equal(isDenied(denied.rows[0]), true);
  });
});
