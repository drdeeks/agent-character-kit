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

test("postinstall.js: install-only -- prints the configure pointer, configures nothing", () => {
  const { tmpRoot, fakeHome, postinstallPath } = makeFakeGlobalInstall();
  try {
    const out = execFileSync(process.execPath, [postinstallPath], {
      env: { ...process.env, HOME: fakeHome, npm_config_global: "true" },
      encoding: "utf8",
    });
    assert.match(out, /Nothing has been configured/);
    assert.match(out, /^\s*ack configure\s+step-by-step/m);
    assert.match(out, /ack configure --yes/);
    assert.equal(fs.existsSync(path.join(fakeHome, ".claude", "settings.json")), false,
      "npm install must never write to settings.json");
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("postinstall.js: never auto-configures, even if ACK_YES=1 is set (that mechanism is gone)", () => {
  const { tmpRoot, fakeHome, postinstallPath } = makeFakeGlobalInstall();
  try {
    const out = execFileSync(process.execPath, [postinstallPath], {
      env: { ...process.env, HOME: fakeHome, npm_config_global: "true", ACK_YES: "1" },
      encoding: "utf8",
    });
    assert.match(out, /Nothing has been configured/,
      "ACK_YES must have zero effect -- configuration only ever happens via `ack configure`");
    assert.doesNotMatch(out, /Daemon pid/);
    assert.equal(fs.existsSync(path.join(fakeHome, ".claude", "settings.json")), false);
    assert.equal(fs.existsSync(path.join(fakeHome, ".agent-character-kit")), false,
      "no workspace should be created by npm install alone");
  } finally {
    try { execSync(`pkill -f ${JSON.stringify(tmpRoot)}`); } catch { /* nothing to kill, expected */ }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("postinstall.js: local dev install (no npm_config_global) is always a silent no-op", () => {
  const { tmpRoot, fakeHome, postinstallPath } = makeFakeGlobalInstall();
  try {
    const out = execFileSync(process.execPath, [postinstallPath], {
      env: { ...process.env, HOME: fakeHome }, // deliberately no npm_config_global
      encoding: "utf8",
    });
    assert.equal(out.trim(), "", "must produce zero output when not a real global install");
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
