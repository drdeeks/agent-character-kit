import { MemoryStore } from "./storage/memory.js";
import { handleFetch } from "./mcp.js";

/**
 * Cloudflare Worker entry. D1 is the system of record when ACK_DB is bound.
 * Tests inject a MemoryStore. This is not a process-global daemon.
 */
export default {
  async fetch(request, env = {}) {
    const store = env.ACK_STORE || new MemoryStore();
    return handleFetch(request, env, store);
  },
};
