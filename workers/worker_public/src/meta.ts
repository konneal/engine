// Meta/self-intent handling: identity, capability, greeting and thanks
// questions are about the SERVICE, not the corpus. Routed through the
// retrieval pipeline they find no related passages and hit the mandatory
// refusal sentence — so they are answered here, deterministically, from the
// DATASETS catalog (the same SSOT /api/datasets serves). Refusal stays
// calibrated to topical knowledge questions only.

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
  /^(who|what) (are|r) (you|u)$/,
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

function corpusList(member: boolean): string {
  const rows = DATASETS.filter((d) => !d.session || member).map((d) => `- **${d.label}** — ${d.description}`);
  const locked = DATASETS.filter((d) => d.session && !member);
  const upsell = locked.length
    ? `\n\nSign in with an OIML SMART account to also search: ${locked.map((d) => `**${d.label}** (${d.description.toLowerCase()})`).join("; ")}.`
    : "";
  return rows.join("\n") + upsell;
}

const EN_IDENTITY = (member: boolean) =>
  `I'm the OIML SMART AI assistant for legal metrology. I answer questions grounded in the corpora indexed for this service:\n\n${corpusList(member)}\n\nEvery answer cites the exact publication and clause it comes from. Try asking things like "What are the accuracy classes in OIML R 76?" or "Which ISO/IEC standards does R 60 reference?"`;

const EN_GREETING =
  "Hello! I'm the OIML SMART AI assistant. Ask me anything about OIML legal-metrology publications — requirements, definitions, accuracy classes, test methods, normative references. Every answer cites its sources.";

const EN_THANKS = "You're welcome. Ask anytime — I'll cite the publication and clause for every answer.";

const FR_IDENTITY = (member: boolean) =>
  `Je suis l'assistant IA OIML SMART pour la métrologie légale. Je réponds aux questions à partir des corpus indexés pour ce service :\n\n${corpusList(member)}\n\nChaque réponse cite la publication et la clause exactes d'où elle provient. Par exemple : « Quelles sont les classes d'exactitude de l'OIML R 76 ? » ou « Quelles normes ISO/CEI la R 60 référence-t-elle ? »`;

const FR_GREETING =
  "Bonjour ! Je suis l'assistant IA OIML SMART. Posez-moi vos questions sur les publications OIML de métrologie légale — exigences, définitions, classes d'exactitude, méthodes d'essai, références normatives. Chaque réponse cite ses sources.";

const FR_THANKS = "Avec plaisir. N'hésitez pas — chaque réponse citera la publication et la clause concernées.";

const FR_HINTS = /\b(qu |qui |que |comment |pourquoi |merci|salut|bonjour)/i;

export function metaAnswer(rawQuery: string, member: boolean): { answer: string; kind: MetaKind } | null {
  const kind = classifyMeta(rawQuery);
  if (!kind) return null;
  const fr = FR_HINTS.test(rawQuery);
  const answer =
    kind === "greeting" ? (fr ? FR_GREETING : EN_GREETING)
    : kind === "thanks" ? (fr ? FR_THANKS : EN_THANKS)
    : fr ? FR_IDENTITY(member) : EN_IDENTITY(member);
  return { answer, kind };
}
