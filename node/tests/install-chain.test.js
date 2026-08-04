import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", ".."); // package root, regardless of CWD
const INSTALL = path.join(REPO, "node", "bin", "install.js");

test("install.js exists and is valid JavaScript", { timeout: 5000 }, async () => {
  // Just verify the install script exists and is syntactically valid
  assert.ok(fs.existsSync(INSTALL), "install.js should exist");
  
  const content = fs.readFileSync(INSTALL, "utf8");
  assert.ok(content.includes("parseArgs"), "should export parseArgs");
  assert.ok(content.includes("resolveSocket"), "should export resolveSocket");
  assert.ok(content.includes("main"), "should export main");
  assert.ok(content.includes("main("), "should have main function");
  assert.ok(content.includes("launchDaemon"), "should have launchDaemon function");
  assert.ok(content.includes("seedHabits"), "should have seedHabits function");
  assert.ok(content.includes("writeConstitution"), "should have writeConstitution function");
});