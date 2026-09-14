/**
 * Print sinks. Failure must not change an allow/deny/hold decision.
 */

export class NoopSink {
  async append() {}
}

export class CompositeSink {
  constructor(sinks = []) {
    this.sinks = sinks.filter(Boolean);
  }

  async append(event) {
    for (const sink of this.sinks) {
      try {
        await sink.append(event);
      } catch {
        /* one sink down must not block the others */
      }
    }
  }
}

/** In-process D1/MemoryStore (ChatGPT Worker). */
export class StoreSink {
  constructor(store, identity) {
    this.store = store;
    this.identity = identity;
  }

  async append(event) {
    const stamped = {
      ...event,
      workspaceId: this.identity.workspaceId,
      ownerUserId: this.identity.userId,
      installationId: this.identity.installationId,
    };
    await this.store.appendEvent(this.identity, stamped);
  }
}

/** Local daemon/Codex posting facts to the hosted Worker. */
export class RemoteHttpSink {
  constructor(url, options = {}) {
    this.url = url;
    this.headers = options.headers || {};
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
  }

  async append(event) {
    if (!this.fetchImpl) return;
    await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.headers,
      },
      body: JSON.stringify({ events: [event] }),
    });
  }
}
