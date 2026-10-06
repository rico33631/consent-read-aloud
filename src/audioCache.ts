import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { cacheKey } from "./cacheKey.js";
import type { TtsProvider, TtsRequest } from "./tts.js";

export type CacheStatus = "HIT" | "MISS";

export interface CachedAudio {
  key: string;
  audio: Buffer;
  status: CacheStatus;
  /** True when this request joined a generation another request had already started. */
  joined: boolean;
}

/**
 * Disk cache in front of a TTS provider.
 * - Hit: the file cache/<key>.mp3 exists and is served as-is.
 * - Miss: one provider call, written atomically (temp file + rename).
 * - Concurrent misses for the same key share one in-flight promise, so a burst of
 *   owners opening the same form triggers exactly one upstream call.
 */
export class AudioCache {
  private readonly inFlight = new Map<string, Promise<Buffer>>();

  constructor(
    private readonly dir: string,
    private readonly provider: TtsProvider,
  ) {}

  filePath(key: string): string {
    return path.join(this.dir, `${key}.mp3`);
  }

  async get(request: TtsRequest): Promise<CachedAudio> {
    const key = cacheKey(request.text, request.voiceId, request.modelId);

    const existing = await this.read(key);
    if (existing) return { key, audio: existing, status: "HIT", joined: false };

    let pending = this.inFlight.get(key);
    const joined = pending !== undefined;
    if (!pending) {
      pending = this.generate(key, request).finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, pending);
    }
    return { key, audio: await pending, status: "MISS", joined };
  }

  private async read(key: string): Promise<Buffer | undefined> {
    try {
      return await readFile(this.filePath(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async generate(key: string, request: TtsRequest): Promise<Buffer> {
    const audio = await this.provider.synthesize(request);
    await mkdir(this.dir, { recursive: true });
    const tmp = path.join(this.dir, `${key}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    try {
      await writeFile(tmp, audio);
      await rename(tmp, this.filePath(key)); // atomic on the same filesystem
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
    return audio;
  }
}
