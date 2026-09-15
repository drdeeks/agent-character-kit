import { evaluatePolicy } from './policy/engine.js';
import { EventEmitter } from '../../events/src/emitter.js';

async function test() {
  console.log("--- Testing Robustness: Counterfactual Boundary ---");
  const policy = { denyList: ["delete-all"] };
  const request = { tool: "filesystem", command: "delete-all /home/drdeek", params: {} };
  
  const result = evaluatePolicy(request, policy);
  console.log("Result Effect:", result.effect);
  console.log("Proposed Action Captured:", result.proposedAction ? "✅ YES" : "❌ NO");
  if (result.proposedAction) {
    console.log("Proposed Tool:", result.proposedAction.tool);
  }

  console.log("\n--- Testing Robustness: Hierarchical IDs ---");
  const emitter = new EventEmitter();
  const event = await emitter.emit("tool.requested", {
    sessionId: "sess_123",
    episodeId: "ep_456",
    taskId: "task_789",
    runId: "run_001",
    action: { tool: "test" }
  });

  const ids = ['sessionId', 'episodeId', 'taskId', 'runId'];
  const allPresent = ids.every(id => event[id] && event[id] !== 'session-unknown');
  console.log("Hierarchical IDs Present:", allPresent ? "✅ YES" : "❌ NO");
  ids.forEach(id => console.log(`${id}: ${event[id]}`));

  if (!allPresent || !result.proposedAction) {
    process.exit(1);
  }
}

test().catch(e => {
  console.error(e);
  process.exit(1);
});
