import { mkdir, appendFile } from "fs/promises";
import path from "path";

/**
 * Date-partitioned append-only JSONL sink.
 * Telemetry failure must not take down the gate; callers should catch.
 */
export class JsonlSink {
  /**
   * @param {string} baseDir
   */
  constructor(baseDir) {
    this.baseDir = baseDir;
  }

  fileFor(timestamp) {
    const day = String(timestamp || new Date().toISOString()).slice(0, 10);
    return path.join(this.baseDir, `${day}.jsonl`);
  }

  async append(event) {
    const file = this.fileFor(event.timestamp);
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, JSON.stringify(event) + "\n", "utf8");
  }
}
