import {
  DATASETS,
  datasetAllowed
} from "./chunk-V46XM2GU.js";
import {
  P
} from "./chunk-3FYJM7LH.js";

// workers/worker_public/src/requestScope.ts
function licenseDeclared() {
  return (P().sources?.licensed?.length ?? 0) > 0;
}
function standardKeysFrom(body) {
  const declared = new Set((P().sources?.licensed ?? []).map((l) => String(l.key)));
  const raw = Array.isArray(body?.licensed_standards) ? body.licensed_standards : [];
  return new Set(
    raw.filter((x) => typeof x === "string" && declared.has(x))
  );
}
function entitlementScope(keys) {
  return licenseDeclared() ? keys : null;
}
function resolveRequestScope(body, member, opts) {
  const allIds = DATASETS().map((d) => d.id);
  const requested = Array.isArray(body?.datasets) ? body.datasets.filter((x) => typeof x === "string" && allIds.includes(x)) : null;
  if (requested !== null && requested.length === 0) return { error: "empty-datasets" };
  const permittedIds = allIds.filter((id) => {
    const d = DATASETS().find((x) => x.id === id);
    return d.session ? datasetAllowed(d, member) || !!opts?.keyWithEntitlements : true;
  });
  const scopeIds = (requested ?? permittedIds).filter((id) => permittedIds.includes(id));
  const corpora = /* @__PURE__ */ new Set();
  for (const id of scopeIds) {
    const d = DATASETS().find((x) => x.id === id);
    for (const v of d?.corpora ?? [id]) corpora.add(v);
  }
  const memoryIds = member && Array.isArray(body?.memories) ? body.memories.filter((x) => typeof x === "string").slice(0, 4) : [];
  return {
    scopeIds,
    corpora,
    narrowed: scopeIds.length < permittedIds.length,
    // federation flag: any session-gated (federated) dataset in scope
    isoOn: scopeIds.some((id) => DATASETS().find((x) => x.id === id)?.session === true),
    memoryIds,
    standardKeys: standardKeysFrom(body)
  };
}
function requestSalt(scope, memoryUsed) {
  const licensed = licenseDeclared();
  if (!scope.narrowed && !memoryUsed.length && !licensed) return null;
  return JSON.stringify({
    ...scope.narrowed ? { d: [...scope.corpora].sort() } : {},
    ...memoryUsed.length ? { m: [...memoryUsed].sort() } : {},
    // the entitlement set rides whenever the deployment keys content at
    // all — an unentitled ask and an entitled ask of the same text are
    // different answers even when the set is empty
    ...licensed ? { s: [...scope.standardKeys].sort() } : {}
  });
}

export {
  licenseDeclared,
  standardKeysFrom,
  entitlementScope,
  resolveRequestScope,
  requestSalt
};
