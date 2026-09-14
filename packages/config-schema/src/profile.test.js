import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultProfile, profileToPolicy, validateProfile } from "./profile.js";

test("default profile is fail-closed with safe audit retention", () => {
  const p = defaultProfile({ profileId: "profile_x", name: "strict" });
  assert.equal(p.mode, "fail-closed");
  assert.equal(p.enabled, true);
  assert.equal(p.audit.retentionDays, 90);
  assert.equal(p.acknowledgmentRules.requiredAcks, 2);
});

test("validateProfile rejects missing profileId", () => {
  const r = validateProfile({ name: "x" });
  assert.equal(r.ok, false);
});

test("profileToPolicy maps hard/deny/allow rules", () => {
  const policy = profileToPolicy({
    profileId: "p1",
    name: "n",
    toolRules: [
      { type: "hard", pattern: "rm -rf" },
      { type: "allow", pattern: "ls*" },
    ],
  });
  assert.deepEqual(policy.hardConstraints, ["rm -rf"]);
  assert.deepEqual(policy.allowList, ["ls*"]);
});
