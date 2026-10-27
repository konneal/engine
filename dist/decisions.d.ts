export interface DerivedRequirement {
    text: string;
    clause: string;
}
export interface DecisionItem {
    text: string;
    clause: string;
    band: "met" | "not-met" | "unclear";
    probability: number;
}
export type DecisionMode = "check" | "list";
/** Parse the derivation model's reply: JSON with
 *  {mode: "check"|"list", requirements: [{text, clause}]}.
 *  Tolerant of prose around the JSON, of trailing commas-free objects,
 *  and of missing clauses (empty string). Returns [] when nothing
 *  sane survives — the pass then stands down. */
export declare function parseDerivation(text: string | null | undefined, cap: number): {
    mode: DecisionMode;
    requirements: DerivedRequirement[];
};
/** Build the Clef questions map from the derived requirements. In
 *  "check" mode each requirement becomes a noul (met-or-not given the
 *  user's stated values); in "list" mode a noul on whether the
 *  requirement is genuinely stated in the corpus text. */
export declare function buildDecisionQuestions(mode: DecisionMode, requirements: DerivedRequirement[], userQuestion: string, statedValues: string): Record<string, {
    type: "noul";
    instructions: string;
    criteria?: {
        true: string;
        false: string;
    };
}>;
export declare function bandFor(p: number, metBand: number, refuteBand: number): DecisionItem["band"];
/** Match the Clef answers (keyed r1..rN) back onto the requirements and
 *  band them. Unmatched/missing answers drop (absence is honest). */
export declare function matchAnswers(mode: DecisionMode, requirements: DerivedRequirement[], answers: Record<string, any>, metBand: number, refuteBand: number): DecisionItem[];
/** The deterministic checklist section appended to the answer. The
 *  model never writes this — the server composes it from the decisions. */
export declare function assembleSection(mode: DecisionMode, items: DecisionItem[]): string;
