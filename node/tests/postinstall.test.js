import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// postinstall.js's own guards (isGlobalInstall / isRealNodeModulesInstall)
// require BOTH npm_config_global==="true" AND a real node_modules component
// in the resolved __dirname. import.meta.url resolves through symlinks to
// the real underlying path, so a symlinked fixture silently fails the
// second guard and the script no-ops with zero output (found live while
// writing this test, not assumed) -- a REAL file copy into a fake
// node_modules tree is required, matching what `npm install -g` actually
// does (a real copy, never a symlink).
function makeFakeGlobalInstall() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ack-postinstall-e2e-"));
  const pkgDir = path.join(tmpRoot, "node_modules", "@drdeeks", "character-kit");
  fs.mkdirSync(pkgDir, { recursive: true });
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
  execSync(`cp -r ${JSON.stringify(path.join(repoRoot, "node"))} ${JSON.stringify(pkgDir)}`);
  fs.copyFileSync(path.join(repoRoot, "package.json"), path.join(pkgDir, "package.json"));
  const fakeHome = path.join(tmpRoot, "fakehome");
  fs.mkdirSync(fakeHome, { recursive: true });
  return { tmpRoot, fakeHome, postinstallPath: path.join(pkgDir, "node", "bin", "postinstall.js") };
}

test("postinstall.js MOD-005: no ACK_YES -> prints interactive-pointer, configures nothing", () => {
  const { tmpRoot, fakeHome, postinstallPath } = makeFakeGlobalInstall();
  try {
    const out = execFileSync(process.execPath, [postinstallPath], {
      env: { ...process.env, HOME: fakeHome, npm_config_global: "true" },
      encoding: "utf8",
    });
    assert.match(out, /Nothing has been configured yet/);
    assert.match(out, /Run `ack install`/);
    assert.match(out, /set ACK_YES=1/);
    assert.equal(fs.existsSync(path.join(fakeHome, ".claude", "settings.json")), false,
      "no bypass must mean nothing gets written to settings.json");
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("postinstall.js MOD-005: ACK_YES=1 reproduces the full auto-configure flow", { timeout: 20000 }, () => {
  const { tmpRoot, fakeHome, postinstallPath } = makeFakeGlobalInstall();
  let daemonPid = null;
  try {
    const out = execFileSync(process.execPath, [postinstallPath], {
      env: { ...process.env, HOME: fakeHome, npm_config_global: "true", ACK_YES: "1" },
      encoding: "utf8",
      timeout: 15000,
    });
    assert.match(out, /ACK_YES=1, setting up automatically/);
    assert.match(out, /set up generic successfully|set up .* successfully/);
    const pidMatch = out.match(/Daemon pid:\s+(\d+)/);
    assert.ok(pidMatch, "must report a real daemon pid, not a description of what would happen");
    daemonPid = Number(pidMatch[1]);
    let alive = true;
    try { process.kill(daemonPid, 0); } catch { alive = false; }
    assert.equal(alive, true, "the reported daemon pid must actually be a running process");
  } finally {
    if (daemonPid) { try { process.kill(daemonPid, "SIGKILL"); } catch { /* already dead */ } }
    try { execSync(`pkill -f ${JSON.stringify(tmpRoot)}`); } catch { /* nothing left to kill, expected */ }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("postinstall.js: local dev install (no npm_config_global) is always a silent no-op regardless of ACK_YES", () => {
  const { tmpRoot, fakeHome, postinstallPath } = makeFakeGlobalInstall();
  try {
    const out = execFileSync(process.execPath, [postinstallPath], {
      env: { ...process.env, HOME: fakeHome, ACK_YES: "1" }, // deliberately no npm_config_global
      encoding: "utf8",
    });
    assert.equal(out.trim(), "", "must produce zero output when not a real global install, even with ACK_YES=1");
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
