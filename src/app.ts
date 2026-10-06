import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import type { AudioCache } from "./audioCache.js";
import { isLanguage, type Config, type Language } from "./config.js";
import { cacheKey } from "./cacheKey.js";
import { toSpeechText, type FormStore } from "./forms.js";
import { HttpError } from "./tts.js";

export interface AppDeps {
  config: Pick<Config, "voiceIds" | "modelId">;
  forms: FormStore;
  /** Undefined when no API key is set and mock mode is off. */
  cache: AudioCache | undefined;
  publicDir: string;
  log?: (message: string) => void;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

function parseLang(url: URL): Language | undefined {
  const lang = url.searchParams.get("lang") ?? "en";
  return isLanguage(lang) ? lang : undefined;
}

function matchesEtag(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((tag) => {
    const value = tag.trim();
    return value === "*" || value.replace(/^W\//, "") === etag;
  });
}

async function serveStatic(publicDir: string, pathname: string, res: ServerResponse): Promise<boolean> {
  let relative: string;
  try {
    relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    return false; // malformed percent-encoding: answer 404, not 500
  }
  const file = path.resolve(publicDir, relative);
  if (file !== publicDir && !file.startsWith(publicDir + path.sep)) return false; // path traversal
  try {
    const content = await readFile(file);
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

export function createApp(deps: AppDeps): Server {
  const { forms, cache, config, log = console.log } = deps;
  const publicDir = path.resolve(deps.publicDir);

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);

    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendError(res, 405, "method_not_allowed", "Only GET is supported");
    }

    if (parts[0] === "api") {
      // GET /api/forms
      if (parts.length === 2 && parts[1] === "forms") {
        return sendJson(res, 200, { forms: forms.list() });
      }

      if (parts[1] === "forms" && parts[2] && (parts.length === 3 || (parts.length === 4 && parts[3] === "audio"))) {
        const lang = parseLang(url);
        if (!lang) return sendError(res, 400, "invalid_lang", "lang must be 'de' or 'en'");
        const form = forms.get(parts[2], lang);
        if (!form) return sendError(res, 404, "form_not_found", `No form '${parts[2]}' in '${lang}'`);

        // GET /api/forms/:id?lang=
        if (parts.length === 3) return sendJson(res, 200, form);

        // GET /api/forms/:id/audio?lang=
        if (!cache) {
          return sendError(
            res,
            503,
            "missing_api_key",
            "ELEVENLABS_API_KEY is not set. Add it to .env, or set ELEVENLABS_MOCK=1 to use silent mock audio.",
          );
        }
        // The URL has no version in it, so browsers must revalidate. The ETag is the cache key,
        // which changes with the text, voice and model; a matching If-None-Match gets a 304.
        const tts = { text: toSpeechText(form), voiceId: config.voiceIds[lang], modelId: config.modelId };
        const etag = `"${cacheKey(tts.text, tts.voiceId, tts.modelId)}"`;
        const cacheHeaders = { etag, "cache-control": "private, no-cache", "x-form-version": form.version };
        if (matchesEtag(req.headers["if-none-match"], etag)) {
          log(`audio ${form.id}@${form.version} ${lang} 304 key=${etag.slice(1, 13)}`);
          res.writeHead(304, { ...cacheHeaders, "x-cache": "HIT" });
          res.end();
          return;
        }
        const started = Date.now();
        const result = await cache.get(tts);
        log(`audio ${form.id}@${form.version} ${lang} ${result.status}${result.joined ? " (joined in-flight)" : ""} ${Date.now() - started}ms key=${result.key.slice(0, 12)}`);
        res.writeHead(200, {
          ...cacheHeaders,
          "content-type": "audio/mpeg",
          "content-length": result.audio.length,
          "x-cache": result.status,
        });
        res.end(req.method === "HEAD" ? undefined : result.audio);
        return;
      }

      return sendError(res, 404, "not_found", "Unknown API route");
    }

    if (await serveStatic(publicDir, url.pathname, res)) return;
    sendError(res, 404, "not_found", "Not found");
  }

  return createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : "internal_error";
      const message = error instanceof HttpError ? error.message : "Something went wrong";
      log(`error ${req.method} ${req.url}: ${(error as Error).message}`);
      if (!res.headersSent) sendError(res, status, code, message);
      else res.end();
    });
  });
}
