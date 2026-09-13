/**
 * Unix socket file perms: group-restricted (0660), not owner-only.
 * ACK_CLIENT_GROUP is the extra chown so root-mode clients can connect.
 */

import fs from "fs";

export function resolveGroupGid(groupName) {
  if (!groupName) return null;
  try {
    const lines = fs.readFileSync("/etc/group", "utf8").split("\n");
    for (const line of lines) {
      const parts = line.split(":");
      if (parts[0] === groupName) return parseInt(parts[2], 10);
    }
  } catch { /* /etc/group unreadable */ }
  return null;
}

export function secureSocketFile(sockPath) {
  try { fs.chmodSync(sockPath, 0o660); } catch { /* best-effort */ }
  const groupName = process.env.ACK_CLIENT_GROUP;
  if (!groupName) return;
  const gid = resolveGroupGid(groupName);
  if (gid === null) {
    console.error(`Warning: ACK_CLIENT_GROUP='${groupName}' not found in /etc/group -- socket left with its default group; client connections may fail with EACCES.`);
    return;
  }
  try {
    fs.chownSync(sockPath, -1, gid);
  } catch (e) {
    console.error(`Warning: could not chown ${sockPath} to group '${groupName}' (gid ${gid}): ${e.message}`);
  }
}
