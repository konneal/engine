import {
  DATASETS,
  datasetAllowed
} from "./chunk-OCNLV7Q7.js";

// workers/worker_public/src/requestScope.ts
function resolveRequestScope(body, member) {
  const allIds = DATASETS().map((d) => d.id);
  const requested = Array.isArray(body?.datasets) ? body.datasets.filter((x) => typeof x === "string" && allIds.includes(x)) : null;
  if (requested !== null && requested.length === 0) return { error: "empty-datasets" };
  const permittedIds = allIds.filter((id) => {
    const d = DATASETS().find((x) => x.id === id);
    return d.session ? datasetAllowed(d, member) : true;
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
    memoryIds
  };
}
function requestSalt(scope, memoryUsed) {
  if (!scope.narrowed && !memoryUsed.length) return null;
  return JSON.stringify({
    ...scope.narrowed ? { d: [...scope.corpora].sort() } : {},
    ...memoryUsed.length ? { m: [...memoryUsed].sort() } : {}
  });
}

export {
  resolveRequestScope,
  requestSalt
};
