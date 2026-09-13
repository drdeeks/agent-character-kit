/**
 * Detect which agent harnesses look installed for this user.
 * Kept tiny so postinstall can import it without loading install.js / gray-matter.
 */

import fs from "fs";
import os from "os";
import path from "path";

export function detectHarnesses() {
  const home = os.homedir();
  const candidates = [
    { harness: "claude", marker: path.join(home, ".claude", "settings.json") },
    { harness: "hermes", marker: path.join(home, ".hermes") },
    { harness: "opencode", marker: path.join(home, ".config", "opencode") },
  ];
  const found = candidates.filter((c) => fs.existsSync(c.marker)).map((c) => c.harness);
  return found.length ? found : ["generic"];
}
