/**
 * Line-buffered stdin prompt used by ack manage / habit / repair.
 * Queues complete lines so piped or pasted answers do not collapse.
 */

const _askQueue = [];
let _askWaiter = null;
let _askListenerInstalled = false;

function _installAskListener() {
  if (_askListenerInstalled) return;
  _askListenerInstalled = true;
  let leftover = "";
  const flushWaiter = () => {
    if (!_askWaiter) return;
    const w = _askWaiter;
    _askWaiter = null;
    w();
  };
  process.stdin.on("data", (d) => {
    leftover += d.toString();
    let idx;
    while ((idx = leftover.indexOf("\n")) !== -1) {
      _askQueue.push(leftover.slice(0, idx).replace(/\r$/, ""));
      leftover = leftover.slice(idx + 1);
    }
    flushWaiter();
  });
  process.stdin.on("end", () => {
    if (leftover) { _askQueue.push(leftover); leftover = ""; }
    if (_askWaiter) { _askQueue.push(""); flushWaiter(); }
  });
}

export function ask(q) {
  if (q) process.stdout.write(q);
  _installAskListener();
  return new Promise((resolve) => {
    const attempt = () => {
      if (_askQueue.length > 0) resolve(_askQueue.shift().trim());
      else _askWaiter = attempt;
    };
    attempt();
  });
}
