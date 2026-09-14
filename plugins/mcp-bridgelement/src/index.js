import { MemoryStore } from "./storage/memory.js";
import { D1Store } from "./storage/d1.js";
import { handleFetch } from "./mcp.js";

/**
 * Cloudflare Worker entry. D1 is the system of record when ACK_DB is bound.
 * Tests inject a MemoryStore. This is not a process-global daemon.
 */
export function createStore(env = {}) {
  if (env.ACK_STORE) return env.ACK_STORE;
  if (env.ACK_DB) return new D1Store(env.ACK_DB, { provider: env.ACK_PROVIDER || "agnostic" });
  return new MemoryStore();
}

export default {
  async fetch(request, env = {}) {
    const store = createStore(env);
    return handleFetch(request, env, store);
  },
};
