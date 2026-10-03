// The nameplate bridge (TODO.new-era/6, the image lane): a certificate
// question that arrives WITH a photograph carries its manufacturer only
// in the pixels. A single low-effort vision call extracts the printed
// manufacturer and model, and those tokens feed the certificate
// register's D1 lane — so "does this load cell's manufacturer hold the
// certificate" answers with the actual register rows instead of advice.
// The shape rules are the 2026-09-09 multimodal findings: the image
// rides its OWN short user message, never a long passage.
import nameplatePrompt from "../prompts/nameplate.md";
import { parseNameplate, nameplateRegisterQuery, type Nameplate } from "./nameplate-parse.ts";
import { MODELS } from "./config.ts";

export type { Nameplate };
export { nameplateRegisterQuery };

export async function extractNameplate(ai: any, model: string, image: string): Promise<Nameplate | null> {
  // one retry, decided on the RESULT not the error: the observed live
  // failure (2026-10-03) is a structurally valid response carrying null
  // fields — the same image the answer model read perfectly a moment
  // later. A transient vision-call miss must not strand a certificate
  // question with no register rows.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res: any = await ai.run(model, {
        messages: [
          { role: "system", content: nameplatePrompt.trimEnd() },
          { role: "user", content: [{ type: "image_url", image_url: { url: image } }] },
        ],
        // the budget rises with the retry's effort — elevated effort under
        // a flat budget starves the answer on this model (measured,
        // 2026-09-18: 5/38 at medium with the flat budget)
        max_tokens: attempt === 0 ? 512 : 1536,
        reasoning_effort: attempt === 0 ? "low" : "medium",
      });
      const text = typeof res?.response === "string" ? res.response : res?.choices?.[0]?.message?.content;
      const np = parseNameplate(text ?? "");
      if (np) {
        console.log(`nameplate-extract: ${np.manufacturer} / ${np.model}${attempt ? " (on retry)" : ""}`);
        return np;
      }
      console.log(`nameplate-extract: no parse on attempt ${attempt + 1} (${(text ?? "").slice(0, 120)})`);
    } catch (e) {
      console.log(`nameplate-extract: FAILED attempt ${attempt + 1} ${String(e).slice(0, 160)}`);
    }
  }
  return null; // the bridge is optional — the ask never depends on it
}

export const nameplateModel = () => MODELS.member;
