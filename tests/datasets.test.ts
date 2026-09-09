// Dataset gating (ai-preview): a session-gated dataset requires BOTH
// membership and the estate permission — the UI lock is cosmetic, this
// is the server-side bar /api/datasets and /api/ask federation share.
import { test } from "node:test";
import assert from "node:assert/strict";
import { datasetsFor, hasPermission, datasetAllowed, DATASETS } from "../workers/worker_public/src/config.ts";

const anon = null;
const member = { sub: "s", roles: [] as string[] };
const previewMember = { sub: "s", roles: ["mc_member", "ai-preview"] };

test("oiml and smart-model are permission-free", () => {
  for (const id of ["oiml", "smart-model"]) {
    const d = DATASETS.find((x) => x.id === id)!;
    assert.ok(datasetAllowed(d, anon));
    assert.ok(datasetAllowed(d, member));
    assert.ok(datasetAllowed(d, previewMember));
  }
});

test("iso requires the ai-preview permission, not mere membership", () => {
  const iso = DATASETS.find((x) => x.id === "iso")!;
  assert.equal(iso.session, true);
  assert.equal(datasetAllowed(iso, anon), false);
  assert.equal(datasetAllowed(iso, member), false);
  assert.equal(datasetAllowed(iso, previewMember), true);
});

test("datasetsFor advertises the permission in requires", () => {
  const iso = (datasetsFor(previewMember) as any[]).find((d) => d.id === "iso");
  assert.equal(iso.enabled, true);
  const locked = (datasetsFor(member) as any[]).find((d) => d.id === "iso");
  assert.equal(locked.enabled, false);
  assert.match(locked.requires, /ai-preview/);
  assert.match(locked.requires, /id\.oimlsmart\.org/);
});

test("hasPermission matches exact role codes only", () => {
  assert.equal(hasPermission({ roles: ["ai-preview"] }, "ai-preview"), true);
  assert.equal(hasPermission({ roles: ["ai-preview-x"] }, "ai-preview"), false);
  assert.equal(hasPermission({ roles: "ai-preview" }, "ai-preview"), false);
  assert.equal(hasPermission(null, "ai-preview"), false);
});
