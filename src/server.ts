import { fileURLToPath } from "node:url";
import { AudioCache } from "./audioCache.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createElevenLabsClient } from "./elevenlabs.js";
import { FormStore } from "./forms.js";
import { createMockProvider } from "./mock.js";
import type { TtsProvider } from "./tts.js";

// Works from both src/ (tsx) and dist/ (node): the project root is one level up.
const root = fileURLToPath(new URL("../", import.meta.url));

try {
  process.loadEnvFile(`${root}.env`);
} catch {
  // No .env file: rely on the real environment.
}

const config = loadConfig();

let provider: TtsProvider | undefined;
let mode: string;
if (config.mock) {
  provider = createMockProvider();
  mode = "MOCK (silent audio, no API calls)";
} else if (config.apiKey) {
  provider = createElevenLabsClient({ apiKey: config.apiKey, timeoutMs: config.timeoutMs });
  mode = `ElevenLabs (${config.modelId})`;
} else {
  mode = "no API key: audio disabled (set ELEVENLABS_API_KEY or ELEVENLABS_MOCK=1)";
}

const forms = await FormStore.load(`${root}forms`);
const cache = provider ? new AudioCache(`${root}cache`, provider) : undefined;
const server = createApp({ config, forms, cache, publicDir: `${root}public` });

server.listen(config.port, () => {
  console.log(`consent-read-aloud on http://localhost:${config.port}`);
  console.log(`TTS mode: ${mode}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
