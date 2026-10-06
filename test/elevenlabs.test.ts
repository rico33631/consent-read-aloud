import assert from "node:assert/strict";
import { test } from "node:test";
import { createElevenLabsClient } from "../src/elevenlabs.js";
import { HttpError } from "../src/tts.js";
import { MP3_BYTES, audioResponse, noSleep, stubFetch } from "./helpers.js";

const request = { text: "Hello", voiceId: "JBFqnCBsd6RMkjVDRZzb", modelId: "eleven_multilingual_v2" };
const quiet = () => {};

test("sends the documented request shape", async () => {
  const { fetch, calls } = stubFetch([() => audioResponse()]);
  const client = createElevenLabsClient({ apiKey: "secret-key", fetch, sleep: noSleep, log: quiet });

  const audio = await client.synthesize(request);

  assert.deepEqual(audio, MP3_BYTES);
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, "https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb");
  assert.equal(call.init?.method, "POST");
  const headers = call.init?.headers as Record<string, string>;
  assert.equal(headers["xi-api-key"], "secret-key");
  assert.equal(headers.accept, "audio/mpeg");
  assert.deepEqual(JSON.parse(String(call.init?.body)), { text: "Hello", model_id: "eleven_multilingual_v2" });
});

test("retries once after a 429, honouring Retry-After", async () => {
  const sleeps: number[] = [];
  const { fetch, calls } = stubFetch([
    () => new Response("rate limited", { status: 429, headers: { "retry-after": "2" } }),
    () => audioResponse(),
  ]);
  const client = createElevenLabsClient({
    apiKey: "k",
    fetch,
    sleep: async (ms) => void sleeps.push(ms),
    log: quiet,
  });

  assert.deepEqual(await client.synthesize(request), MP3_BYTES);
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [2000]);
});

test("retries once after a 5xx using the default backoff", async () => {
  const sleeps: number[] = [];
  const { fetch, calls } = stubFetch([() => new Response("oops", { status: 503 }), () => audioResponse()]);
  const client = createElevenLabsClient({
    apiKey: "k",
    fetch,
    retryDelayMs: 250,
    sleep: async (ms) => void sleeps.push(ms),
    log: quiet,
  });

  await client.synthesize(request);
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [250]);
});

test("gives up after one retry and reports a clean error", async () => {
  const { fetch, calls } = stubFetch([() => new Response("still limited", { status: 429 })]);
  const client = createElevenLabsClient({ apiKey: "k", fetch, sleep: noSleep, log: quiet });

  await assert.rejects(client.synthesize(request), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 503);
    return true;
  });
  assert.equal(calls.length, 2);
});

test("caps a long Retry-After at 10s", async () => {
  const sleeps: number[] = [];
  const { fetch } = stubFetch([
    () => new Response("rate limited", { status: 429, headers: { "retry-after": "120" } }),
    () => audioResponse(),
  ]);
  const client = createElevenLabsClient({ apiKey: "k", fetch, sleep: async (ms) => void sleeps.push(ms), log: quiet });

  await client.synthesize(request);
  assert.deepEqual(sleeps, [10_000]);
});

test("falls back to the default backoff for a non-numeric Retry-After", async () => {
  const sleeps: number[] = [];
  const { fetch } = stubFetch([
    () => new Response("rate limited", { status: 429, headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" } }),
    () => audioResponse(),
  ]);
  const client = createElevenLabsClient({
    apiKey: "k",
    fetch,
    retryDelayMs: 250,
    sleep: async (ms) => void sleeps.push(ms),
    log: quiet,
  });

  await client.synthesize(request);
  assert.deepEqual(sleeps, [250]);
});

test("does not retry on 4xx such as a bad key", async () => {
  const { fetch, calls } = stubFetch([() => new Response('{"detail":"invalid api key"}', { status: 401 })]);
  const client = createElevenLabsClient({ apiKey: "nope", fetch, sleep: noSleep, log: quiet });

  await assert.rejects(client.synthesize(request), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.doesNotMatch(error.message, /nope/); // the key never appears in errors
    return true;
  });
  assert.equal(calls.length, 1);
});

test("keeps the upstream error body in the server log, not in the client message", async () => {
  const body = '{"detail":{"status":"quota_exceeded","message":"You have 42 credits remaining"}}';
  const { fetch } = stubFetch([() => new Response(body, { status: 401 })]);
  const logged: string[] = [];
  const client = createElevenLabsClient({ apiKey: "k", fetch, sleep: noSleep, log: (m) => void logged.push(m) });

  await assert.rejects(client.synthesize(request), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 502);
    assert.equal(error.code, "upstream_error");
    assert.doesNotMatch(error.message, /quota|credits|401/);
    return true;
  });
  assert.ok(logged.some((m) => m.includes("quota_exceeded")));
});

test("does not echo network error details to the client", async () => {
  const fetch = (async () => {
    throw new Error("getaddrinfo ENOTFOUND api.elevenlabs.io");
  }) as typeof globalThis.fetch;
  const logged: string[] = [];
  const client = createElevenLabsClient({ apiKey: "k", fetch, sleep: noSleep, log: (m) => void logged.push(m) });

  await assert.rejects(client.synthesize(request), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.code, "upstream_unreachable");
    assert.doesNotMatch(error.message, /getaddrinfo|ENOTFOUND/);
    return true;
  });
  assert.ok(logged.some((m) => m.includes("ENOTFOUND")));
});

test("aborts a hung request after the timeout", async () => {
  const fetch = ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as typeof globalThis.fetch;
  const client = createElevenLabsClient({ apiKey: "k", fetch, timeoutMs: 20, sleep: noSleep, log: quiet });

  await assert.rejects(client.synthesize(request), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 504);
    return true;
  });
});

test("times out when the audio body stalls after the headers", async () => {
  // Headers arrive, one chunk is sent, then the stream never closes.
  const fetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0xff, 0xfb]));
        },
      }),
      { status: 200, headers: { "content-type": "audio/mpeg" } },
    )) as typeof globalThis.fetch;
  const client = createElevenLabsClient({ apiKey: "k", fetch, timeoutMs: 20, sleep: noSleep, log: quiet });

  await assert.rejects(client.synthesize(request), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 504);
    assert.equal(error.code, "upstream_timeout");
    return true;
  });
});
