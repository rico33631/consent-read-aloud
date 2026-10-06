import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { AudioCache } from "../src/audioCache.js";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { FormStore } from "../src/forms.js";
import { createMockProvider } from "../src/mock.js";
import { HttpError } from "../src/tts.js";
import { tempDir } from "./helpers.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const config = loadConfig({ ELEVENLABS_MOCK: "1" });
const quiet = () => {};

let base: string;
let noKeyBase: string;
let failingBase: string;
const closers: Array<() => Promise<unknown>> = [];

async function start(server: ReturnType<typeof createApp>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

before(async () => {
  const { dir, cleanup } = await tempDir();
  closers.push(cleanup);
  const forms = await FormStore.load(`${root}forms`);
  const cache = new AudioCache(dir, createMockProvider({ delayMs: 5 }));
  base = await start(createApp({ config, forms, cache, publicDir: `${root}public`, log: quiet }));
  noKeyBase = await start(createApp({ config, forms, cache: undefined, publicDir: `${root}public`, log: quiet }));
  const failing = await tempDir();
  closers.push(failing.cleanup);
  const timeoutProvider = {
    async synthesize(): Promise<Buffer> {
      throw new HttpError(504, "ElevenLabs did not respond within 20 ms", "upstream_timeout");
    },
  };
  failingBase = await start(
    createApp({ config, forms, cache: new AudioCache(failing.dir, timeoutProvider), publicDir: `${root}public`, log: quiet }),
  );
});

after(async () => {
  for (const close of closers.reverse()) await close();
});

test("GET /api/forms lists each form with both languages", async () => {
  const res = await fetch(`${base}/api/forms`);
  assert.equal(res.status, 200);
  const { forms } = (await res.json()) as { forms: Array<{ id: string; languages: string[] }> };
  assert.ok(forms.length >= 2);
  for (const form of forms) assert.deepEqual([...form.languages].sort(), ["de", "en"]);
});

test("GET /api/forms/:id returns the text in the requested language", async () => {
  const res = await fetch(`${base}/api/forms/standing-sedation?lang=de`);
  assert.equal(res.status, 200);
  const form = (await res.json()) as { language: string; title: string };
  assert.equal(form.language, "de");
  assert.match(form.title, /Einverständniserklärung/);

  assert.equal((await fetch(`${base}/api/forms/standing-sedation?lang=fr`)).status, 400);
  assert.equal((await fetch(`${base}/api/forms/nope?lang=en`)).status, 404);
});

test("GET /api/forms/:id/audio returns MP3, MISS then HIT", async () => {
  const first = await fetch(`${base}/api/forms/standing-sedation/audio?lang=en`);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("content-type"), "audio/mpeg");
  assert.equal(first.headers.get("x-cache"), "MISS");
  const bytes = new Uint8Array(await first.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 2)], [0xff, 0xfb]); // MPEG audio frame sync

  const second = await fetch(`${base}/api/forms/standing-sedation/audio?lang=en`);
  assert.equal(second.headers.get("x-cache"), "HIT");
  await second.arrayBuffer();
});

test("audio is revalidated with an ETag so a new form version is never served stale", async () => {
  const res = await fetch(`${base}/api/forms/standing-sedation/audio?lang=de`);
  await res.arrayBuffer();
  const etag = res.headers.get("etag");
  assert.match(etag ?? "", /^"[0-9a-f]{64}"$/);
  assert.equal(res.headers.get("cache-control"), "private, no-cache");

  const again = await fetch(`${base}/api/forms/standing-sedation/audio?lang=de`, { headers: { "if-none-match": etag! } });
  assert.equal(again.status, 304);
  assert.equal(again.headers.get("x-cache"), "HIT");
  await again.arrayBuffer();

  // A different version's tag (here: another language's audio) does not match.
  const stale = await fetch(`${base}/api/forms/standing-sedation/audio?lang=en`, { headers: { "if-none-match": etag! } });
  assert.equal(stale.status, 200);
  await stale.arrayBuffer();
});

test("an upstream failure reaches the browser as JSON with its status and code", async () => {
  const res = await fetch(`${failingBase}/api/forms/standing-sedation/audio?lang=en`);
  assert.equal(res.status, 504);
  const body = (await res.json()) as { error: { code: string } };
  assert.equal(body.error.code, "upstream_timeout");
});

test("audio with audio disabled (no cache configured) is a clear JSON error", async () => {
  const res = await fetch(`${noKeyBase}/api/forms/standing-sedation/audio?lang=en`);
  assert.equal(res.status, 503);
  const body = (await res.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, "missing_api_key");
  assert.match(body.error.message, /ELEVENLABS_API_KEY/);
});

test("serves the static page and blocks path traversal", async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html/i);
  const sneaky = await fetch(`${base}/..%2Fpackage.json`);
  assert.equal(sneaky.status, 404);
  await sneaky.text();
});

test("a malformed percent-encoded path is a 404, not a server error", async () => {
  const res = await fetch(`${base}/%E0%A4%A`);
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: { code: string } };
  assert.equal(body.error.code, "not_found");
});
