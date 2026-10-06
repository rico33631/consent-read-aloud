export interface TtsRequest {
  text: string;
  voiceId: string;
  modelId: string;
}

/** Anything that turns text into MP3 bytes. */
export interface TtsProvider {
  synthesize(request: TtsRequest): Promise<Buffer>;
}

/** An error that should be reported to the client with a given HTTP status. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}
