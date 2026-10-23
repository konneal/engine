// VLM figure rerank (TODO.sota/18.3 — the hedge that sees past
// embeddings): a figure-SEEKING question's figure candidates are scored
// by a vision model on their actual images — the MKO figure chunks'
// text is thin (a breadcrumb line + a caption), so text ranking loses
// them to sibling tables no matter what the caption-augmented embed
// carries. One bounded vision call, the winner promoted to the front of
// the window with a rerank score above the incumbent top; every failure
// mode is additive (the text ranking stands). Off via the registry
// projection like any stage (ablate_stages drops it).
import { MODELS } from "../config.ts";
import type { Stage } from "./types.ts";
import type { Hit } from "../../../shared/chunk";

export const FIGURE_Q = /\bfig(ure|s)?\b/i;

export function parsePick(text: unknown, kept: number): number {
  const t = text as any;
  const s = typeof text === "string" ? text : typeof t?.response === "string" ? t.response : t?.choices?.[0]?.message?.content ?? "";
  const pick = Number(String(s).match(/"pick"\s*:\s*(\d+)/)?.[1] ?? 0);
  return pick >= 1 && pick <= kept ? pick : 0;
}

export const vlmFigureRerank: Stage = {
  name: "vlm-figure-rerank",
  failure: "additive",
  when: (c) => FIGURE_Q.test(c.query) && c.finalHits.some((h: Hit) => (h.metadata as any).block === "figure" && (h.metadata as any).unit_id),
  run: async (c) => {
    const figures = c.finalHits.filter((h: Hit) => (h.metadata as any).block === "figure" && (h.metadata as any).unit_id).slice(0, 3);
    if (!figures.length) return;
    try {
      const ids = figures.map((h: Hit) => String((h.metadata as any).unit_id));
      const ph = ids.map((_, i) => `?${i + 1}`).join(",");
      const rows = await c.env.DB.prepare(
        `SELECT unit_id, json_extract(payload,'$.uri') AS uri FROM unit_payloads WHERE unit_id IN (${ph})`,
      )
        .bind(...ids)
        .all();
      const uris = new Map(((rows.results ?? []) as any[]).map((r: any) => [r.unit_id as string, r.uri as string | null]));
      // the multimodal gotcha (2026-09-09): image parts ride a SHORT
      // message — the question and the labels, nothing else
      const content: any[] = [
        {
          type: "text",
          text: `Question: ${c.query}\n\nWhich of these figures best answers the question? Reply with ONLY: {"pick": N} using the image's number, or {"pick": 0} if none is relevant.`,
        },
      ];
      const kept: { h: Hit; label: number }[] = [];
      let n = 0;
      for (const h of figures) {
        const uri = String(uris.get(String((h.metadata as any).unit_id)) ?? "");
        const m = uri.match(/^\/assets\/(.+)/);
        if (!m) continue;
        const obj = await c.env.UNIT_ASSETS.get(m[1]);
        if (!obj) continue;
        const buf = new Uint8Array(await obj.arrayBuffer());
        let binary = "";
        for (let i = 0; i < buf.length; i += 8192) binary += String.fromCharCode(...buf.subarray(i, i + 8192));
        n += 1;
        content.push({ type: "text", text: `Image ${n}:` });
        content.push({ type: "image_url", image_url: { url: `data:image/png;base64,${btoa(binary)}` } });
        kept.push({ h, label: n });
      }
      if (!kept.length) return;
      const raced: any = await Promise.race([
        c.env.AI.run(MODELS.vlmFigure, { messages: [{ role: "user", content }], max_tokens: 256, reasoning_effort: "low" }),
        new Promise<null>((r) => setTimeout(() => r(null), 15000)),
      ]);
      const pick = parsePick(raced, kept.length);
      const chosen = kept.find((k) => k.label === pick);
      if (!chosen) return;
      const top = Math.max(...c.finalHits.map((h: Hit) => h.rerank_score ?? h.score ?? 0));
      chosen.h.rerank_score = top + 1;
      c.finalHits = [chosen.h, ...c.finalHits.filter((h: Hit) => h !== chosen.h)];
      console.log("vlm-figure-rerank: promoted", (chosen.h.metadata as any).unit_id, "over", c.finalHits.length - 1, "text-ranked hits");
    } catch {
      // additive — the text ranking stands
    }
  },
};
