import { HttpError, type TtsProvider, type TtsRequest } from "./tts.js";

export interface ElevenLabsOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Delay before the single retry, unless the server sends Retry-After. */
  retryDelayMs?: number;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

const MAX_RETRY_AFTER_MS = 10_000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

function retryAfterMs(response: Response, fallback: number): number {
  const header = response.headers.get("retry-after");
  const seconds = header ? Number(header) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  return fallback;
}

async function upstreamMessage(response: Response): Promise<string> {
  try {
    const body = (await response.text()).slice(0, 300);
    return body || response.statusText;
  } catch {
    return response.statusText;
  }
}

/**
 * Minimal ElevenLabs text-to-speech client.
 * POST /v1/text-to-speech/{voice_id} with a per-attempt timeout and one retry on 429/5xx.
 * The API key only ever goes into the request header; it is never logged or echoed.
 */
export function createElevenLabsClient(options: ElevenLabsOptions): TtsProvider {
  const {
    apiKey,
    baseUrl = "https://api.elevenlabs.io",
    timeoutMs = 30_000,
    retryDelayMs = 1_000,
    fetch: fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    log = (message: string) => console.warn(message),
  } = options;

  async function attempt(request: TtsRequest): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(`${baseUrl}/v1/text-to-speech/${encodeURIComponent(request.voiceId)}`, {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "content-type": "application/json",
          accept: "audio/mpeg",
        },
        body: JSON.stringify({ text: request.text, model_id: request.modelId }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new HttpError(504, `ElevenLabs did not respond within ${timeoutMs} ms`, "upstream_timeout");
      }
      throw new HttpError(502, `Could not reach ElevenLabs: ${(error as Error).message}`, "upstream_unreachable");
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async synthesize(request) {
      let response = await attempt(request);

      if (isRetryable(response.status)) {
        const delay = retryAfterMs(response, retryDelayMs);
        log(`ElevenLabs returned ${response.status}; retrying once in ${delay} ms`);
        await response.body?.cancel();
        await sleep(delay);
        response = await attempt(request);
      }

      if (!response.ok) {
        const detail = await upstreamMessage(response);
        const status = response.status === 429 ? 503 : 502;
        throw new HttpError(status, `ElevenLabs error ${response.status}: ${detail}`, "upstream_error");
      }

      return Buffer.from(await response.arrayBuffer());
    },
  };
}
