// Meta/self-intent ROUTING: identity, capability, greeting and thanks
// turns are conversational — about the service, not the corpus. Routed
// through retrieval they waste embed/rerank/grade calls over irrelevant
// passages and invite the refusal sentence. The classifier only decides
// the route; the ANSWER always comes from the model (identityNote gives
// it the service facts), so any phrasing, any language, real speech.

import { DATASETS } from "./config";

export type MetaKind = "identity" | "greeting" | "thanks";

function normalize(q: string): string {
  return q
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // é→e, è→e — French accents off
    .replace(/[!?.,;:"'`’-]+/g, " ") // apostrophes/hyphens → spaces
    .replace(/\s+/g, " ")
    .trim();
}

function stripGreeting(q: string): string {
  // "Hello! Who are you?" — drop a leading greeting, then classify the rest
  return q.replace(/^(hi|hey|hello|yo|salut|bonjour|bonsoir|coucou|good (morning|afternoon|evening|day)|greetings)[ ]+/, "");
}

// Whole-question anchors: a pattern must describe the ENTIRE (short) query —
// "what do you know" is meta, "what do you know about OIML R 60" is topical.
const IDENTITY_PATTERNS: RegExp[] = [
  /^(who|what) (are|r) (you|u)( and (what|how) can (you|u) (help|do)( me)?)?$/,
  /^(who|what) am i (talking|speaking|chatting) (to|with)$/,
  /^who (made|created|built|trained|developed|designed) (you|u)$/,
  /^(are|r) (you|u) (an? )?(ai|a\.i\.|robot|bot|chatbot|human|real|person|llm|gpt|chatgpt|claude|gemini|deepseek|qwen|machine)( (or|and) (a |an )?\w+)?$/,
  /^what('| i)?s your name$|^what( s| is)? your name$/,
  /^what (model|llm|ai|language model) (are|r) (you|u)( powered by)?$/,
  /^which (model|llm|ai) (are|r) (you|u)( powered by)?$/,
  /^introduce (yourself|your self)$/,
  /^tell me about (yourself|this (site|service|website|chat|chatbot|assistant|ai))$/,
  /^(who|what) is (this|that)( (site|service|chat|chatbot|assistant|ai))?( for)?$/,
  /^what is this (site|service|website|page|chat|chatbot|assistant|ai|tool)$/,
  /^what (are|r) (you|u)( here)? (for|called)$/,
  /^(qui|que) (es|etes) (tu|vous)$/,
  /^(tu|vous) (es|etes|suis) (qui|quoi)$/,
  /^qui (a |t a |vous a )?(cree|fabrique|fait|concu|entraine) (tu|vous|cette ia|cet assistant)$/,
  /^(es|etes) (tu|vous) (une? )?(ia|i\.a\.|intelligence artificielle|robot|humain|chatbot)( ou (un |une )?\w+)?$/,
  /^comment (tu|vous) (t appelles|vous appelez)$/,
  /^(presente|presentez) (toi|vous)$/,
  /^parle moi de (toi|vous|cette ia|cet assistant)$/,
];

const CAPABILITY_PATTERNS: RegExp[] = [
  /^(what|how) can (you|u) help( me)?$/,
  /^what (can|could|would) (you|u) do( for me)?$/,
  /^what do (you|u) (know|have)( about this)?$|^what do (you|u) have access to$/,
  /^what (can|could) i ask (you|u)( about)?$/,
  /^(what|which) (data|dataset|datasets|corpus|corpora|sources|documents|publications|content) (do|does|can|did) (you|u) (have|use|search|index|cover|access)( access to| available| in your (index|corpus|database))?$/,
  /^how (do|does) (you|u|this|it) work$/,
  /^what (do|does) (you|u) (search|index|cover)( over| through)?$/,
  /^what (are|r) (you|u) capable of$/,
  /^what (are|r) (you|u) trained on$/,
  /^(que peux|pouvez)( tu| vous) faire$/,
  /^qu est ce que (tu|vous) (es|etes|peux|pouvez|sais|savez|fais|faites)( bien)?$/,
  /^quelles? (donnees|sources|documents|publications) (utilises|utilisez|as|avez|couvrez)( vous| tu)?( pour repondre)?$/,
  /^comment (ca|tu|vous) (marche|fonctionne|travailles|travaillez)$/,
];

const GREETING = /^(hi|hey|hello|yo|salut|bonjour|bonsoir|coucou|good (morning|afternoon|evening|day)|greetings)( (there|everyone|all|team|oiml))?$/;
const THANKS = /^(thanks|thank you( very much| so much)?|many thanks|thx|ty|merci( beaucoup| bien)?|je vous remercie|super|parfait|perfect|great)$/;

export function classifyMeta(rawQuery: string): MetaKind | null {
  const q = normalize(rawQuery);
  if (!q || q.length > 100) return null;
  if (GREETING.test(q)) return "greeting";
  if (THANKS.test(q)) return "thanks";
  const body = stripGreeting(q);
  if (IDENTITY_PATTERNS.some((re) => re.test(body)) || CAPABILITY_PATTERNS.some((re) => re.test(body))) return "identity";
  return null;
}

/** System instruction for a conversational (meta) turn: the service facts
 *  the model speaks from, composed from the DATASETS catalog — the same
 *  SSOT /api/datasets serves. */
export function identityNote(member: boolean): string {
  const corpora = DATASETS.filter((d) => !d.session || member)
    .map((d) => `- ${d.label}: ${d.description}`)
    .join("\n");
  const locked = DATASETS.filter((d) => d.session && !member);
  const upsell = locked.length
    ? `\nSigned-in members additionally search: ${locked.map((d) => `${d.label} (${d.description})`).join("; ")}.`
    : "";
  return [
    "You are the OIML SMART AI assistant at ai.oimlsmart.org, a public service answering questions about OIML legal-metrology publications.",
    "This turn is conversational — about you, this service, a greeting or small talk — NOT a knowledge question, so there are no context passages.",
    "Answer naturally in first person, briefly and warmly, in the language of the user's message. Do not cite sources for this turn and never refuse it.",
    "Facts about this service you may speak from:",
    corpora,
    upsell,
    "For knowledge questions about publications you answer ONLY from the indexed corpora and cite the exact publication and clause for every claim.",
    "If the user asks something substantive next, that is normal operation — just help them.",
  ]
    .filter(Boolean)
    .join("\n");
}
