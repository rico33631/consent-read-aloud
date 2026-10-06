import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { AudioCache } from "../src/audioCache.js";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { FormStore } from "../src/forms.js";
import { createMockProvider } from "../src/mock.js";
import { tempDir } from "./helpers.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const config = loadConfig({ ELEVENLABS_MOCK: "1" });
const quiet = () => {};

let base: string;
let noKeyBase: string;
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

test("audio without a key (and mock off) is a clear JSON error", async () => {
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
