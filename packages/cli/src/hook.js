/**
 * `ack hook` — gate stdin JSON or print companion wiring config.
 * Lives in packages/cli so node/bin/ack.js can stay a commander shell.
 */

export async function runHookCommand(framework, opts, deps) {
  const generateConfig = deps.generateConfig;
  const processToolCall = deps.processToolCall;
  const processPromptSubmit = deps.processPromptSubmit;
  const stdin = deps.stdin || process.stdin;
  const stdout = deps.stdout || process.stdout;
  const isTTY = deps.isTTY ?? stdin.isTTY;
  const exit = deps.exit || ((code) => process.exit(code));

  if (opts.config) {
    stdout.write(JSON.stringify(generateConfig(framework, opts.hookCommand), null, 2) + "\n");
    return;
  }

  let input = "";
  if (!isTTY) {
    input = await new Promise((resolve) => {
      let data = "";
      stdin.on("data", (chunk) => (data += chunk));
      stdin.on("end", () => resolve(data));
    });
  }
  if (!input.trim()) {
    stdout.write(JSON.stringify(generateConfig(framework, opts.hookCommand), null, 2) + "\n");
    return;
  }

  const payload = JSON.parse(input);
  const event = payload.hook_event_name;
  const isPromptSubmit = event === "UserPromptSubmit" || event === "SessionStart";
  const result = isPromptSubmit
    ? await processPromptSubmit(payload, { framework })
    : await processToolCall(payload, { framework });
  stdout.write(JSON.stringify(result.output) + "\n");
  exit(result.exitCode);
}
