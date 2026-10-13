/** The one sanctioned refusal sentence (also in prompts/system.md).
 *  Refusals are never cached: a refusal says "retrieval found nothing",
 *  which is a property of the moment, not of the question. */
export declare function refusalAnswer(): string;
/** The refusal scope (2026-10-11, the third smoke shape): the loose
 *  redirect-offer family is gated by what the PIPELINE knows, not by
 *  ever-more phrase patterns. The model's scope offers keep drifting
 *  ("I'm happy to help … instead", "I can answer questions about …",
 *  "I'm a metrology assistant — I can help with … instead") — the same
 *  surface form that legitimately ANSWERS a conversational question
 *  ("what can you help me with?"). The discriminators: a knowledge-seek
 *  question (the understanding's own class) and an UNCITED answer — a
 *  cited answer's scope talk is content, a conversational turn's scope
 *  talk is the answer itself. */
export interface RefusalScope {
    /** the understanding read the question as a conversational turn */
    conversational?: boolean;
    /** the answer carries citations */
    cited?: boolean;
}
/** Normalize a refusal-shaped answer to the pinned sentence. A drift
 *  refusal occupies its own sentence: swap that sentence (preface
 *  included) for the pinned one — the redirect tail survives. An answer
 *  outside the refusal family is returned byte-identical. */
export declare function canonicalRefusal(answer: string, scope?: RefusalScope): string;
/** The misplaced-pin wall (2026-10-10): an answer that actually cites
 *  passages is NOT a refusal — but the model sometimes drops the
 *  pinned sentence into an otherwise-correct, well-cited answer as a
 *  sub-topic disclaimer (measured: the refusal pin at char 435 of a
 *  load-cell answer citing R 60). Readers and graders read the pin as
 *  a TOTAL refusal. The wall is deterministic: when the answer cites,
 *  the pin sentence (and its refusal-shaped paraphrases) are excised —
 *  the surrounding content stands on its own. */
export declare function exciseMisplacedPin(answer: string, cites: boolean): string;
/** Cacheable under the refusal law (2026-10-11, the poisoned-entry
 *  lesson): "refusals are never cached" was enforced as "answers
 *  containing the pin are never cached" — backwards for DRIFT, which
 *  lacks the pin and cached itself across deploy windows (an edge
 *  instance running pre-wall code wrote a drifted refusal that served
 *  every later ask). An answer is cacheable only when it carries no
 *  pin AND the wall would not rewrite it. */
export declare function cacheableAnswer(answer: string, scope?: RefusalScope): boolean;
/** The follow-up-chips law (2026-10-13): the understanding stage's
 *  follow_ups are generated BEFORE retrieval and answer — after a
 *  refusal they advertise the very topic the corpus does not carry.
 *  Chips serve only when the answer is not refusal-shaped (carries no
 *  pin and the wall would not rewrite it). */
export declare function refusalShaped(answer: string, scope?: RefusalScope): boolean;
