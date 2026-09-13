function defaultHold() {
  return {
    count: 0,
    acked: 0,
    usedHabitNames: [],
    reasons: [],
    filesTouched: new Set(),
    cyclesSinceCommit: 0,
  };
}

/**
 * In-memory StateStore. Swap later for file or sqlite without changing callers.
 */
export class InMemoryStateStore {
  constructor() {
    this.hold = new Map();
    this.cycle = new Map();
    this.idempotency = new Map();
  }

  async getHoldState(sessionId) {
    return this.hold.get(sessionId);
  }

  async setHoldState(sessionId, state) {
    this.hold.set(sessionId, state);
  }

  async getCycleState(sessionId) {
    return this.cycle.get(sessionId);
  }

  async setCycleState(sessionId, state) {
    this.cycle.set(sessionId, state);
  }

  async listSessions() {
    return [...this.hold.keys()];
  }

  async gc() {
    return 0;
  }

  async getOrCreateHold(sessionId) {
    let state = this.hold.get(sessionId);
    if (!state) {
      state = defaultHold();
      this.hold.set(sessionId, state);
    }
    return state;
  }

  async rememberDecision(key, decision) {
    this.idempotency.set(key, decision);
  }

  async recallDecision(key) {
    return this.idempotency.get(key);
  }
}
