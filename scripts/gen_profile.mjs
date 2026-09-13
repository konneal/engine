// Profile codegen (multi-SDO step 1): profile/*.yaml → the workers'
// compile-time profile.gen.ts. The generated file is committed; the
// drift test (tests/profile.test.ts) fails CI when someone edits one
// side without regenerating — the same discipline as the estate's
// gen:data / build-prl-package loop.
import { readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";

const render = (profileDir = "profile") => {
  const publisher = YAML.parse(readFileSync(`${profileDir}/publisher.yaml`, "utf8"));
  const datasets = YAML.parse(readFileSync(`${profileDir}/datasets.yaml`, "utf8")).datasets;
  const corpora = YAML.parse(readFileSync(`${profileDir}/corpora.yaml`, "utf8"));
  const body = JSON.stringify({ publisher, datasets, corpora }, null, 2);
  return `// GENERATED from profile/*.yaml — regenerate: node scripts/gen_profile.mjs
// (never edit; the drift test compares this file to the sources)
export const PROFILE = ${body} as const;
`;
};

if (process.argv[1].endsWith("gen_profile.mjs") && !process.env.PROFILE_RENDER_ONLY) {
  const out = "workers/worker_public/src/profile.gen.ts";
  writeFileSync(out, render());
  console.log(`generated ${out}`);
}

export { render };
