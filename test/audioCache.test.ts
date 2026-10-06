import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { afterEach, beforeEach, test } from "node:test";
import { AudioCache } from "../src/audioCache.js";
import { createElevenLabsClient } from "../src/elevenlabs.js";
import type { TtsProvider } from "../src/tts.js";
import { MP3_BYTES, audioResponse, noSleep, stubFetch, tempDir } from "./helpers.js";

const request = { text: "Bitte nicht füttern.", voiceId: "voice-de", modelId: "eleven_multilingual_v2" };

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ dir, cleanup } = await tempDir()));
afterEach(() => cleanup());

function countingProvider(): TtsProvider & { calls: number } {
  const provider = {
    calls: 0,
    async synthesize() {
      provider.calls++;
      return MP3_BYTES;
    },
  };
  return provider;
}

test("first request is a MISS, second is a HIT served from disk", async () => {
  const provider = countingProvider();
  const cache = new AudioCache(dir, provider);

  const first = await cache.get(request);
  assert.equal(first.status, "MISS");
  assert.deepEqual(first.audio, MP3_BYTES);

  const second = await cache.get(request);
  assert.equal(second.status, "HIT");
  assert.deepEqual(second.audio, MP3_BYTES);
  assert.equal(provider.calls, 1);

  // A fresh cache instance (e.g. after a restart) still hits the file on disk.
  const restarted = new AudioCache(dir, provider);
  assert.equal((await restarted.get(request)).status, "HIT");
  assert.equal(provider.calls, 1);
});

test("a new form version (different text) is a MISS", async () => {
  const provider = countingProvider();
  const cache = new AudioCache(dir, provider);
  await cache.get(request);
  const updated = await cache.get({ ...request, text: request.text + " Version 2." });
  assert.equal(updated.status, "MISS");
  assert.equal(provider.calls, 2);
});

test("writes are atomic: only the final .mp3 remains, no temp files", async () => {
  const cache = new AudioCache(dir, countingProvider());
  const { key } = await cache.get(request);
  assert.deepEqual(await readdir(dir), [`${key}.mp3`]);
});

test("concurrent misses for the same key make one upstream call (stubbed fetch)", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { fetch, calls } = stubFetch([
    async () => {
      await gate; // hold the upstream call open while other requests arrive
      return audioResponse();
    },
  ]);
  const cache = new AudioCache(dir, createElevenLabsClient({ apiKey: "test-key", fetch, sleep: noSleep }));

  const burst = Array.from({ length: 5 }, () => cache.get(request));
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const results = await Promise.all(burst);

  assert.equal(calls.length, 1);
  assert.equal(results.filter((r) => !r.joined).length, 1);
  for (const result of results) {
    assert.equal(result.status, "MISS");
    assert.deepEqual(result.audio, MP3_BYTES);
  }
  assert.equal((await cache.get(request)).status, "HIT");
  assert.equal(calls.length, 1);
});

test("a failed generation is not cached and the next request retries", async () => {
  let fail = true;
  const provider: TtsProvider = {
    async synthesize() {
      if (fail) throw new Error("boom");
      return MP3_BYTES;
    },
  };
  const cache = new AudioCache(dir, provider);
  await assert.rejects(cache.get(request), /boom/);
  assert.deepEqual(await readdir(dir).catch(() => []), []);
  fail = false;
  assert.equal((await cache.get(request)).status, "MISS");
});
