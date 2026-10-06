import type { TtsProvider } from "./tts.js";

/**
 * Builds a valid, silent MPEG-1 Layer III file without any encoder.
 * Each frame is a 128 kbps / 44.1 kHz mono header followed by zeroed side info and data,
 * which decoders play as silence. 417 bytes per frame, ~26 ms each.
 */
export function silentMp3(seconds = 2): Buffer {
  const FRAME_BYTES = 417; // floor(144 * 128000 / 44100)
  const FRAMES_PER_SECOND = 44100 / 1152;
  const frameCount = Math.max(1, Math.round(seconds * FRAMES_PER_SECOND));
  const frame = Buffer.alloc(FRAME_BYTES);
  frame.set([0xff, 0xfb, 0x90, 0xc0]); // sync, MPEG-1, Layer III, no CRC | 128k, 44.1k | mono
  return Buffer.concat(Array.from({ length: frameCount }, () => frame));
}

/** Stands in for ElevenLabs so the app and tests run with no key and no network. */
export function createMockProvider(options: { delayMs?: number } = {}): TtsProvider {
  const { delayMs = 300 } = options;
  return {
    async synthesize({ text }) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      // Roughly scale length with the text so different forms are distinguishable.
      return silentMp3(Math.min(5, 1 + text.length / 1000));
    },
  };
}
