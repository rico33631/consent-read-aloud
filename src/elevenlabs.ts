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

interface Attempt {
  response: Response;
  /** Set when the response was OK and the body has been read. */
  audio?: Buffer;
  /** Start of the error body, for the server log only. */
  detail?: string;
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
 * Upstream error details are logged on the server; clients get a generic message.
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

  /** One upstream call. The whole response, body included, has to arrive within timeoutMs. */
  async function attempt(request: TtsRequest): Promise<Attempt> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("timeout"));
      }, timeoutMs);
    });
    try {
      return await Promise.race([send(request, controller.signal), deadline]);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new HttpError(504, `ElevenLabs did not respond within ${timeoutMs} ms`, "upstream_timeout");
      }
      log(`Could not reach ElevenLabs: ${(error as Error).message}`);
      throw new HttpError(502, "Could not reach the voice service, please try again", "upstream_unreachable");
    } finally {
      clearTimeout(timer);
    }
  }

  async function send(request: TtsRequest, signal: AbortSignal): Promise<Attempt> {
    const response = await fetchImpl(`${baseUrl}/v1/text-to-speech/${encodeURIComponent(request.voiceId)}`, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "content-type": "application/json",
        accept: "audio/mpeg",
      },
      body: JSON.stringify({ text: request.text, model_id: request.modelId }),
      signal,
    });
    if (response.ok) return { response, audio: Buffer.from(await response.arrayBuffer()) };
    return { response, detail: await upstreamMessage(response) };
  }

  return {
    async synthesize(request) {
      let result = await attempt(request);

      if (isRetryable(result.response.status)) {
        const delay = retryAfterMs(result.response, retryDelayMs);
        log(`ElevenLabs returned ${result.response.status}; retrying once in ${delay} ms`);
        await sleep(delay);
        result = await attempt(request);
      }

      if (result.audio) return result.audio;

      // The upstream body can describe the account (quota, key status), so it stays in the server log.
      const status = result.response.status;
      log(`ElevenLabs error ${status}: ${result.detail ?? ""}`);
      if (status === 429) {
        throw new HttpError(503, "The voice service is busy, please try again shortly", "upstream_error");
      }
      throw new HttpError(502, "The voice service is unavailable, please try again", "upstream_error");
    },
  };
}
