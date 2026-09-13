/**
 * Newline-delimited JSON RPC over a Node net.Socket, plus unix/tcp listen.
 */

import fs from "fs";
import path from "path";
import { secureSocketFile } from "./socket-perms.js";

export function attachJsonlRpc(socket, handleRequest) {
  socket.setEncoding("utf8");
  let buf = "";
  socket.on("data", (data) => {
    buf += data;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const request = JSON.parse(line);
        const response = handleRequest(request);
        socket.write(JSON.stringify(response) + "\n");
      } catch (err) {
        socket.write(JSON.stringify({ error: "invalid request" }) + "\n");
      }
    }
  });
  socket.on("error", (err) => {
    console.error("Socket error:", err);
  });
}

export function parseListenTarget(raw) {
  const isTcp = typeof raw === "string" && raw.startsWith("tcp://");
  if (!isTcp) return { isTcp: false, path: raw };
  const u = new URL(raw);
  return {
    isTcp: true,
    host: u.hostname || "127.0.0.1",
    port: parseInt(u.port, 10) || 8753,
  };
}

export function listenEnforcerSocket(server, raw, options = {}) {
  const onListening = options.onListening || (() => {});
  const fatal = options.fatal === true;
  const failLabel = options.failLabel || "Failed to start enforcer socket server:";
  const target = parseListenTarget(raw);

  const bindUnix = () => {
    const sockDir = path.dirname(raw);
    try { fs.mkdirSync(sockDir, { recursive: true, mode: 0o750 }); } catch { /* exists */ }
    try { fs.chmodSync(sockDir, 0o750); } catch { /* best-effort */ }
    server.listen(raw, () => {
      secureSocketFile(raw);
      onListening();
    });
  };

  if (target.isTcp) {
    server.listen(target.port, target.host, onListening);
  } else {
    bindUnix();
  }

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && !target.isTcp) {
      try {
        fs.unlinkSync(raw);
        bindUnix();
        return;
      } catch { /* fall through */ }
    }
    console.error(failLabel, err);
    if (fatal) {
      console.error("Ensure the socket path exists/writable, or the TCP port is free.");
      process.exit(1);
    }
  });
}
