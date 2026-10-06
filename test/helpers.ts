import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "consent-read-aloud-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export const MP3_BYTES = Buffer.from([0xff, 0xfb, 0x90, 0xc0, 1, 2, 3]);

export function audioResponse(bytes: Buffer = MP3_BYTES): Response {
  return new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": "audio/mpeg" } });
}

/** A fetch stub that records calls and replies from a queue (last reply repeats). */
export function stubFetch(replies: Array<() => Response | Promise<Response>>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (!reply) throw new Error("stubFetch: no replies configured");
    return reply();
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

export const noSleep = async () => {};
