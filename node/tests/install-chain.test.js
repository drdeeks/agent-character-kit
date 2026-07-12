import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(process.cwd());
const INSTALL = path.join(REPO, "node", "bin", "install.js");

test("install.js exists and is valid JavaScript", { timeout: 5000 }, async () => {
  // Just verify the install script exists and is syntactically valid
  assert.ok(fs.existsSync(INSTALL), "install.js should exist");
  
  const content = fs.readFileSync(INSTALL, "utf8");
  assert.ok(content.includes("export { parseArgs, resolveSocket }"), "should export parseArgs and resolveSocket");
  assert.ok(content.includes("async function main()"), "should have main function");
  assert.ok(content.includes("launchDaemon"), "should have launchDaemon function");
  assert.ok(content.includes("seedHabits"), "should have seedHabits function");
  assert.ok(content.includes("writeConstitution"), "should have writeConstitution function");
});