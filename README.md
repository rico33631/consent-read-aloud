# Consent read-aloud

Reads veterinary consent forms aloud in German or English with the ElevenLabs text-to-speech API, and caches the audio per form version so each version is only generated once.

## Why

Equine vets often ask horse owners to sign consent forms on a phone, standing in a stable aisle with a lead rope in one hand. The forms are long, the screen is small, and the light is bad. People scroll to the bottom and sign. I wanted to see how far a simple "Listen" button gets you: the owner hears the procedure, the sedation risks and their own responsibilities in their language while they keep an eye on the horse.

Consent text changes rarely and is read by many owners, so it is a good fit for caching. Each form version is turned into speech once, saved to disk, and served from there afterwards. If ten owners open the same new form at the same moment, the app still makes a single API call.

> Screenshot: add one at `docs/screenshot.png` after running the app locally, then reference it here.

## Run it

Requires Node 20.12 or newer.

```bash
npm install
npm test          # runs offline, no key needed
```

**Without a key (mock mode).** Serves a short silent MP3 instead of calling ElevenLabs, so you can try the whole flow:

```bash
ELEVENLABS_MOCK=1 npm run dev
# open http://localhost:3000
```

**With a key.**

```bash
cp .env.example .env
# set ELEVENLABS_API_KEY, and optionally ELEVENLABS_VOICE_ID_DE / ELEVENLABS_VOICE_ID_EN
npm run dev
```

Both voice IDs default to George (`JBFqnCBsd6RMkjVDRZzb`), one of ElevenLabs' default voices. `eleven_multilingual_v2` will speak German with it, but a native German voice from the Voice Library sounds better. Copy a voice's ID from the ElevenLabs app, or list the ones on your account with `GET https://api.elevenlabs.io/v1/voices`.

For production: `npm run build && npm start`.

## How the cache works

- **Key.** `sha256(text, voiceId, modelId)`. The text includes the form title and body, so editing a form (a new version) produces a new key, and so does changing the voice or model. Old files simply stop being used.
- **Hit.** If `cache/<key>.mp3` exists it is served directly. Response header `X-Cache: HIT`.
- **Miss.** The app calls ElevenLabs, writes the MP3 to a temp file and renames it into place, so a half-written file is never served. `X-Cache: MISS`.
- **Coalescing.** While a key is being generated, its promise sits in an in-flight map. Other requests for the same key wait on that promise instead of calling the API again. Failures are not cached; the next request tries again.

The ElevenLabs client has a timeout (AbortController, 30s by default), retries once on 429 or 5xx (honouring `Retry-After`, capped at 10s), and never logs the API key.

## API

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/forms` | List of forms with titles, versions and languages |
| GET | `/api/forms/:id?lang=de\|en` | One form as JSON (`id`, `version`, `language`, `title`, `body`) |
| GET | `/api/forms/:id/audio?lang=de\|en` | `audio/mpeg`, with `X-Cache: HIT\|MISS` and `X-Form-Version` |

Errors are JSON: `{ "error": { "code": "...", "message": "..." } }`. If no key is set and mock mode is off, the audio endpoint returns `503` with code `missing_api_key`.

## Project layout

```
forms/     sample consent forms, one JSON file per form and language
public/    the page (plain HTML, CSS, JS)
src/       server, ElevenLabs client, cache, mock audio
test/      node:test suites (cache key, hit/miss, coalescing, retries, endpoints)
cache/     generated MP3s (git-ignored)
```

To add a form, drop in `forms/<id>.<lang>.json` with `id`, `version`, `language`, `title` and `body`. In the body, blank lines separate paragraphs and lines starting with `## ` are headings.

The sample forms are fictional ("Sample Equine Clinic") and are not veterinary or legal advice.

## What's next

- **Scribe for vets.** The other side of the visit: let the vet dictate treatment notes into the phone and transcribe them with ElevenLabs Scribe (speech-to-text), then attach them to the same case.
- Stream the first audio bytes on a miss instead of waiting for the whole file.
- Pre-generate audio when a new form version is published, so no owner ever waits.
- Highlight the paragraph being read.

## License

MIT, see [LICENSE](LICENSE).
