import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Run `ack hook <framework>` with inherited stdio.
 * Monorepo: local node/bin/ack.js. Packaged plugin: `ack` on PATH.
 * Fail-closed: missing binary or spawn error exits non-zero.
 */
export function spawnAckHook(framework) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const localAck = path.resolve(here, "../../../node/bin/ack.js");
  const useLocal = existsSync(localAck);
  const child = spawn(
    useLocal ? process.execPath : "ack",
    useLocal ? [localAck, "hook", framework] : ["hook", framework],
    { stdio: "inherit" }
  );
  child.on("exit", (code, signal) => {
    if (signal) process.exit(1);
    process.exit(code ?? 1);
  });
  child.on("error", (err) => {
    process.stderr.write(`ACK hook failed: ${err.message}\n`);
    process.exit(1);
  });
}
