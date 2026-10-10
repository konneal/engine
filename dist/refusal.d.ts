/** The one sanctioned refusal sentence (also in prompts/system.md).
 *  Refusals are never cached: a refusal says "retrieval found nothing",
 *  which is a property of the moment, not of the question. */
export declare function refusalAnswer(): string;
/** Normalize a refusal-shaped answer to the pinned sentence. A drift
 *  refusal occupies its own sentence: swap that sentence (preface
 *  included) for the pinned one — the redirect tail survives. An answer
 *  outside the refusal family is returned byte-identical. */
export declare function canonicalRefusal(answer: string): string;
/** The misplaced-pin wall (2026-10-10): an answer that actually cites
 *  passages is NOT a refusal — but the model sometimes drops the
 *  pinned sentence into an otherwise-correct, well-cited answer as a
 *  sub-topic disclaimer (measured: the refusal pin at char 435 of a
 *  load-cell answer citing R 60). Readers and graders read the pin as
 *  a TOTAL refusal. The wall is deterministic: when the answer cites,
 *  the pin sentence (and its refusal-shaped paraphrases) are excised —
 *  the surrounding content stands on its own. */
export declare function exciseMisplacedPin(answer: string, cites: boolean): string;
