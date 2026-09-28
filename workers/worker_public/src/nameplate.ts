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
  try {
    const res: any = await ai.run(model, {
      messages: [
        { role: "system", content: nameplatePrompt.trimEnd() },
        { role: "user", content: [{ type: "image_url", image_url: { url: image } }] },
      ],
      max_tokens: 512,
      reasoning_effort: "low",
    });
    const text = typeof res?.response === "string" ? res.response : res?.choices?.[0]?.message?.content;
    return parseNameplate(text ?? "");
  } catch {
    return null; // the bridge is optional — the ask never depends on it
  }
}

export const nameplateModel = () => MODELS.member;
