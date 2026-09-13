/**
 * PASS/FAIL/WARN printers used by ack doctor.
 */

export const PASS = "PASS";
export const FAIL = "FAIL";
export const WARN = "WARN";

export function section(title) {
  console.log(`\n─── ${title} ───`);
}

export function check(label, ok, detail = "") {
  const icon = ok ? "✓" : "✗";
  const tag = ok ? PASS : FAIL;
  console.log(`  ${icon} [${tag}] ${label}${detail ? " — " + detail : ""}`);
}

export function warn(label, detail = "") {
  console.log(`  △ [${WARN}] ${label}${detail ? " — " + detail : ""}`);
}
