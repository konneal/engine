import {
  DATASETS,
  datasetAllowed
} from "./chunk-3E4LR3CH.js";

// workers/worker_public/src/requestScope.ts
var CORPORA_BY_DATASET = {
  oiml: ["oiml", "dirty", "clean", "synthetic"],
  iso: ["iso-internal"]
};
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
    for (const v of CORPORA_BY_DATASET[id] ?? [id]) corpora.add(v);
  }
  const memoryIds = member && Array.isArray(body?.memories) ? body.memories.filter((x) => typeof x === "string").slice(0, 4) : [];
  return {
    scopeIds,
    corpora,
    narrowed: scopeIds.length < permittedIds.length,
    isoOn: scopeIds.includes("iso"),
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
