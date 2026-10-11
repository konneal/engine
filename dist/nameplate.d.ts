import { nameplateRegisterQuery, type Nameplate } from "./nameplate-parse.ts";
export type { Nameplate };
export { nameplateRegisterQuery };
export declare function extractNameplate(ai: any, model: string, image: string): Promise<Nameplate | null>;
export declare const nameplateModel: () => "@cf/zai-org/glm-5.3-flash";
