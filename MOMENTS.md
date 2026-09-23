# Find moments — first release

Upload an audio/video recording in Caption a clip. Find moments transcribes it, recommends up to five distinct passages, and hands the chosen cut to the existing OutLoud editor. No source-link ingestion or automatic publishing is included.

## Run locally

Requires Node 22+ (no packages or build step):

```sh
node tests/dev-server.mjs
```

Open http://127.0.0.1:4179. The local server uses the same API handlers as deployment. Set environment variables in your shell or use Node's `--env-file` option with a private file. Never commit keys.

For a UI-only walkthrough with synthetic recommendations and no provider calls:

```sh
node tests/make-fixture.mjs
node tests/dev-server.mjs --fixtures
```

In this mode, connect using any dummy tester code and upload the generated 120-second synthetic test recording. The fixture transcript is invented and the audio is a test tone; this mode does not evaluate recommendation quality or speech recognition. Never deploy the test server as the app's production backend.

## Connections

- Existing ElevenLabs connection: own API key or the existing tester proxy.
- Analysis: `OPENAI_API_KEY` on the server, gated by the existing `TESTER_PASSWORD`; optional `MOMENTS_MODEL` defaults to `gpt-4.1-mini`.
- Own-key users can enter an OpenAI key in **Analysis connection**. That key stays in page memory and is forwarded by the moments endpoint only to OpenAI. It is not saved in localStorage or logged. The server sends `store: false` on Responses requests.
- The analysis availability check runs before transcription to catch a missing connection before starting transcription charges. It checks configuration/authentication, not the provider account balance or model entitlement.
- Set an OpenAI project spend cap and an ElevenLabs credit cap. The per-instance rate limiter is burst protection, not a durable spend limit.

## How it works

1. Browser decodes a supported recording (up to 2 hours / 300 MB). Long recordings require substantial memory; desktop is recommended. Some video containers cannot be decoded by Web Audio; the UI asks for an audio-only file instead.
2. Transcription runs sequentially in 10-minute Opus sections, or 2-minute WAV sections where Opus encoding is unavailable. Sections have two seconds of context on each side, and words are assigned to only one section by their midpoint.
3. Completed sections remain in memory after cancellation or a request failure, so retry resumes. Replacing the file or reloading clears them. Changing the declared spoken language invalidates the transcription cache.
4. Scribe speaker IDs are scoped to each section. Users can listen to samples and assign matching voices the same name. The feature never guesses that speaker 1 in two sections is the same person.
5. The model selects inclusive transcript segment IDs, not invented timestamps. Server validation enforces duration, bounds, non-overlap and a 70% featured-speaker share. Titles are editorial suggestions, not quotes. No virality probability or vocal-delivery analysis is claimed.
6. Cards play the actual source, offer ten seconds of context on either side, highlight words, and allow start/end adjustments. Searchable transcript rows can set a manual passage of up to 90 seconds.
7. Create audiogram renders a mono 24 kHz WAV slice, rebases cached word timestamps to zero, sets the existing trim range and description, and enables the standard design/export tools. It defaults to original-language captions. Choosing a dub language uses OutLoud's existing dubbing path on that selected range.

The full source and transcript stay in browser memory. Recording sections go to ElevenLabs; transcript and brief go to OpenAI through the server. Provider retention policies still apply. OutLoud does not persist the content on its server.

## Validation

```sh
node --test tests/moments.test.mjs
```

Tests cover section offsets and speaker isolation, sentence grouping, model boundary validation, deduplication, speaker filtering, caption rebasing, malformed transcript rejection, authentication and structured-response handling. Browser validation uses synthetic fixtures; paid provider transcription, recommendation quality on real conversations and translated dubbing require a configured live account.

## Deployment files

Deploy `index.html`, `moments.css`, `moments-core.mjs`, `moments-ui.mjs`, and `api/moments.js` alongside the existing app. Keep the existing ElevenLabs proxy and existing deployment settings. The API runs on the server; credentials must never be added to client files.

## Next steps

- Evaluate ranked passages against human selections on real recordings, starting with the Ingi episode.
- Durable asynchronous import/transcription for recordings beyond browser memory limits.
- Separate source adapters for YouTube and recorded X Spaces.
- Re-align dubbed audio to true word timestamps (the current dubbing pipeline uses its existing sentence transcript timings).
- Saved projects, batch language exports, and audio-aware ranking.
