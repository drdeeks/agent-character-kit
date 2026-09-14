import { JsonlSink } from "./jsonl-sink.js";
import { resolveEventSinkMode, SINK_BOTH, SINK_D1, SINK_LOCAL } from "./sink-mode.js";
import { CompositeSink, NoopSink, RemoteHttpSink, StoreSink } from "./sinks.js";

/**
 * Pick sinks from the utilizing service, then ACK_EVENT_SINK if set.
 *
 * ChatGPT plugin → D1 (StoreSink or ACK_EVENT_URL).
 * Daemon/Codex/Claude/Hermes/Gate → local JSONL.
 * both → JSONL and D1.
 */
export function createEventSink(options = {}) {
  const env = options.env || {};
  const mode = resolveEventSinkMode(options);
  const sinks = [];

  if (mode === SINK_LOCAL || mode === SINK_BOTH) {
    if (options.localDir) sinks.push(new JsonlSink(options.localDir));
  }

  if (mode === SINK_D1 || mode === SINK_BOTH) {
    if (options.store && options.identity) {
      sinks.push(new StoreSink(options.store, options.identity));
    } else {
      const url = options.remoteUrl || env.ACK_EVENT_URL;
      if (url) {
        sinks.push(
          new RemoteHttpSink(url, {
            headers: options.headers,
            fetchImpl: options.fetchImpl,
          })
        );
      }
    }
  }

  if (sinks.length === 0 && options.localDir && mode === SINK_D1) {
    // Local process asked for D1 but has no URL/store: keep JSONL so facts are not dropped.
    sinks.push(new JsonlSink(options.localDir));
  }

  if (sinks.length === 0) return new NoopSink();
  if (sinks.length === 1) return sinks[0];
  return new CompositeSink(sinks);
}

export { JsonlSink };
