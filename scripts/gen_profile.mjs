// Profile codegen (multi-SDO): profile/*.yaml → the compile-time profile
// modules (workers + site). The generated files are committed; the drift
// test (tests/profile.test.ts) fails CI when someone edits one side
// without regenerating — the same discipline as the estate's gen:data.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";

const HEADER = (dir) =>
  `// GENERATED from ${dir}/*.yaml — regenerate: node scripts/gen_profile.mjs\n` +
  "// (never edit; the drift test compares this file to the sources)\n";

const render = (profileDir = "profile") => {
  const header = HEADER(profileDir);
  const read = (f) => YAML.parse(readFileSync(`${profileDir}/${f}`, "utf8"));
  const publisher = read("publisher.yaml");
  const datasets = read("datasets.yaml").datasets;
  const corpora = read("corpora.yaml");
  const sources = read("sources.yaml");
  const ui = read("ui.yaml");
  const retrieval = read("retrieval.yaml");
  const prompts = read("prompts.yaml");
  const body = JSON.stringify({ publisher, datasets, corpora, sources, ui, retrieval, prompts }, null, 2);
  return `${header}export const PROFILE = ${body} as const;\n`;
};

if (process.argv[1].endsWith("gen_profile.mjs") && !process.env.PROFILE_RENDER_ONLY) {
  for (const out of ["workers/worker_public/src/profile.gen.ts", "workers/worker_public/src/profile2.gen.ts", "site/src/profile.gen.ts"]) {
    if (out.startsWith("site/") && !existsSync("site")) continue; // engine repo: no site plane
    writeFileSync(out, render(out.includes("profile2") ? "profile2" : "profile"));
    console.log(`generated ${out}`);
  }
}

export { render };
