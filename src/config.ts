export const DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb"; // "George", an ElevenLabs default voice
export const DEFAULT_MODEL_ID = "eleven_multilingual_v2";

export type Language = "de" | "en";
export const LANGUAGES: readonly Language[] = ["de", "en"];

export interface Config {
  port: number;
  apiKey: string | undefined;
  mock: boolean;
  modelId: string;
  voiceIds: Record<Language, string>;
  timeoutMs: number;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function truthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT) || 3000,
    apiKey: nonEmpty(env.ELEVENLABS_API_KEY),
    mock: truthy(env.ELEVENLABS_MOCK),
    modelId: nonEmpty(env.ELEVENLABS_MODEL_ID) ?? DEFAULT_MODEL_ID,
    voiceIds: {
      de: nonEmpty(env.ELEVENLABS_VOICE_ID_DE) ?? DEFAULT_VOICE_ID,
      en: nonEmpty(env.ELEVENLABS_VOICE_ID_EN) ?? DEFAULT_VOICE_ID,
    },
    timeoutMs: Number(env.ELEVENLABS_TIMEOUT_MS) || 30_000,
  };
}

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
}
