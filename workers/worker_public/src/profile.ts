// The profile registry (konneal item 06/09): a deployment injects its
// OWN publisher profile at the entry (setProfile) before the first
// request; every read goes through P() at request time so module-eval
// order can never bake the wrong profile. The default is the engine's
// fixture, so the engine runs and tests pass standalone.
import { PROFILE as FIXTURE } from "./profile.gen.ts";

let current: unknown = FIXTURE;

export function setProfile(profile: unknown): void {
  current = profile;
}

export function P<T = any>(): T {
  return current as T;
}
