import assert from "node:assert/strict";
import { test } from "node:test";
import { cacheKey } from "../src/cacheKey.js";

test("same inputs give the same key", () => {
  assert.equal(cacheKey("Hallo", "voice-a", "model-1"), cacheKey("Hallo", "voice-a", "model-1"));
  assert.match(cacheKey("Hallo", "voice-a", "model-1"), /^[0-9a-f]{64}$/);
});

test("key changes when text, voice or model changes", () => {
  const base = cacheKey("Hallo", "voice-a", "model-1");
  assert.notEqual(cacheKey("Hallo!", "voice-a", "model-1"), base);
  assert.notEqual(cacheKey("Hallo", "voice-b", "model-1"), base);
  assert.notEqual(cacheKey("Hallo", "voice-a", "model-2"), base);
});

test("field boundaries are unambiguous", () => {
  assert.notEqual(cacheKey("ab", "c", "m"), cacheKey("a", "bc", "m"));
});
