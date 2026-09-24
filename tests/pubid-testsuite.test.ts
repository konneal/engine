// The pubid-testsuite corpus (github.com/pubid/pubid-testsuite, oiml
// flavor) is the codec's SECOND expectation set: the package's own
// conformance corpus pins the delegate grammar; this one pins the
// adaptation against the ecosystem's ground truth — every canonical
// human, its structure, and the normalization pairs.
// Resolution: PUBID_TESTSUITE_DIR (when set, it MUST exist — a
// configured-but-absent corpus refuses a vacuous pass) → the sibling
// checkout → loud skip (CI always provides the checkout).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { oimlPubid } from "../workers/worker_public/src/codecs.ts";

const DIR_CANDIDATES = [
  process.env.PUBID_TESTSUITE_DIR,
  "../pubid-testsuite/tests/oiml",
  join(homedir(), "src/pubid/pubid-testsuite/tests/oiml"),
].filter((d): d is string => !!d);
if (process.env.PUBID_TESTSUITE_DIR && !existsSync(process.env.PUBID_TESTSUITE_DIR)) {
  throw new Error(`PUBID_TESTSUITE_DIR is set but ${process.env.PUBID_TESTSUITE_DIR} does not exist — refusing a vacuous pass`);
}
const dir = DIR_CANDIDATES.find((d) => existsSync(d)) ?? DIR_CANDIDATES[DIR_CANDIDATES.length - 1]!;

if (!existsSync(dir)) {
  console.log(`pubid-testsuite: SKIP — no corpus at ${dir} (CI checks out pubid/pubid-testsuite; locally it is ~/src/pubid/pubid-testsuite)`);
}

const cases = existsSync(dir)
  ? readdirSync(dir)
      .filter((f) => f.endsWith(".yaml") && !f.startsWith("_"))
      .flatMap((f) => parseYaml(readFileSync(`${dir}/${f}`, "utf8")) as any[])
      .filter((c) => c?.identifier && c?.representations?.human)
  : [];

// Constructs this codec deliberately does not own at parse(). The
// ledger must match the null set EXACTLY in both directions: a shape
// that starts parsing (upstream grammar release + pin bump) leaves its
// entry stale and fails the suite; a NEW unsupported shape nulls
// outside the ledger and fails it too.
const KNOWN_NULL: { re: RegExp; why: string }[] = [
  { re: /^Amendment \(\d+\) to /, why: "leading-amendment construct — the citation layer owns it" },
  { re: /Annex/, why: "annex construct — the citation layer owns it" },
  { re: /\b\d?\.?\d*(WD|CD)\b/, why: "draft-stage construct — outside the retrieval plane (no draft documents)" },
];

test("every canonical case parses to the right spine or sits in the ledger", () => {
  if (!cases.length) return; // skipped: no corpus resolved
  const used = new Set<string>();
  for (const c of cases) {
    const human: string = c.representations.human;
    const scope = oimlPubid.parse(human);
    if (scope === null) {
      const hit = KNOWN_NULL.find((k) => k.re.test(human));
      assert.ok(hit, `${human}: null outside the known-null ledger — a new unsupported shape`);
      used.add(hit.why);
      continue;
    }
    const st = c.identifier.base ?? c.identifier;
    // a dual-published record carries two members; the retrieval spine
    // is the OIML side (the URN rule agrees — the dual's URN is the
    // OIML side's)
    const members = [st.first, st.second].filter(Boolean);
    const side = members.find((m: any) => String(m._type ?? "").startsWith("pubid:oiml")) ?? st;
    // the testsuite encodes the family in _type (pubid:oiml:recommendation),
    // not a letter field; amendment/annex bases carry their own _type
    const TYPE_LETTER: Record<string, string> = {
      recommendation: "R", document: "D", basic_publication: "B", guide: "G",
      expert_report: "E", vocabulary: "V", seminar_report: "S",
    };
    const family = side.family ?? TYPE_LETTER[String(side._type).split(":").pop().replace(/-/g, "_")] ?? "";
    assert.equal(scope.doc_number, String(Number(side.number)), `${human}: doc_number`);
    assert.ok(
      scope.label.startsWith(`OIML ${family} ${String(Number(side.number))}`),
      `${human}: label ${scope.label}`,
    );
    if (side.year && !scope.edition) assert.fail(`${human}: year ${side.year} lost (edition ${scope.edition})`);
    if (side.year) assert.equal(scope.edition, side.year, `${human}: edition`);
  }
  const stale = KNOWN_NULL.filter((k) => !used.has(k.why));
  assert.deepEqual(
    stale.map((k) => k.why),
    [],
    "ledger entries that matched nothing — the shape parses now; prune the ledger (upstream release landed)",
  );
});

test("normalization pairs: parse(from) equals parse(to) when the target parses", () => {
  if (!cases.length) return; // skipped: no corpus resolved
  const normPath = `${dir}/_normalization.yaml`;
  if (!existsSync(normPath)) return;
  const pairs = parseYaml(readFileSync(normPath, "utf8")) as { from: string; to: string }[];
  for (const { from, to } of pairs) {
    const target = oimlPubid.parse(to);
    if (!target) continue; // the pair's target is itself a non-owned construct
    assert.deepEqual(oimlPubid.parse(from), target, `${from} → ${to}`);
  }
});
