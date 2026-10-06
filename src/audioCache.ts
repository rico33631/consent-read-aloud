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
  /** True when this request joined a lookup (disk read, then generation) another request had already started. */
  joined: boolean;
}

/**
 * Disk cache in front of a TTS provider.
 * - Hit: the file cache/<key>.mp3 exists and is served as-is.
 * - Miss: one provider call, written atomically (temp file + rename).
 * - Concurrent requests for the same key share one in-flight lookup (disk read, then
 *   generation if needed), so a burst of owners opening the same form triggers exactly
 *   one upstream call. The entry is registered before the first await and removed only
 *   after the file is in place, so a later request either joins it or finds the file.
 */
export class AudioCache {
  private readonly inFlight = new Map<string, Promise<{ audio: Buffer; status: CacheStatus }>>();

  constructor(
    private readonly dir: string,
    private readonly provider: TtsProvider,
  ) {}

  filePath(key: string): string {
    return path.join(this.dir, `${key}.mp3`);
  }

  async get(request: TtsRequest): Promise<CachedAudio> {
    const key = cacheKey(request.text, request.voiceId, request.modelId);

    let pending = this.inFlight.get(key);
    const joined = pending !== undefined;
    if (!pending) {
      pending = this.load(key, request).finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, pending);
    }
    const { audio, status } = await pending;
    return { key, audio, status, joined };
  }

  private async load(key: string, request: TtsRequest): Promise<{ audio: Buffer; status: CacheStatus }> {
    const existing = await this.read(key);
    if (existing) return { audio: existing, status: "HIT" };
    return { audio: await this.generate(key, request), status: "MISS" };
  }

  protected async read(key: string): Promise<Buffer | undefined> {
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
