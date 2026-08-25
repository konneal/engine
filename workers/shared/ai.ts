// Shared AI helper: embed with retry.
const EMBED_MODEL = "@cf/qwen/qwen3-embedding-0.6b";

export async function embed(ai: any, text: string): Promise<number[]> {
  const shapes = [{ text: [text] }, { input: { input: [text] } }];
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const body of shapes) {
      try {
        const res: any = await ai.run(EMBED_MODEL, body);
        const d = res?.data ?? res?.result?.data;
        if (Array.isArray(d)) {
          const first = d[0];
          if (Array.isArray(first)) return first.map(Number);
          if (first?.embedding) return first.embedding.map(Number);
        }
        if (Array.isArray(res?.embedding)) return res.embedding.map(Number);
      } catch { /* next shape */ }
    }
  }
  throw new Error("embedding failed");
}
