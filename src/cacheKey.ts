import { createHash } from "node:crypto";

/**
 * Deterministic cache key for one piece of generated audio.
 * Any change to the text (a new form version), the voice or the model gives a new key.
 * JSON-encoding the parts keeps boundaries unambiguous ("ab"+"c" never equals "a"+"bc").
 */
export function cacheKey(text: string, voiceId: string, modelId: string): string {
  return createHash("sha256").update(JSON.stringify([text, voiceId, modelId])).digest("hex");
}
