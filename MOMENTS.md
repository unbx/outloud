# Unified clip workspace — local design prototype

Upload an audio/video recording in Caption a clip. Find moments transcribes it, recommends up to five distinct passages, and hands the chosen cut to the existing OutLoud editor. No source-link ingestion or automatic publishing is included.

## Run locally

Requires Node 22+ (no packages or build step):

```sh
node tests/dev-server.mjs
```

Open http://127.0.0.1:4180. The local server uses the same API handlers as deployment. Set environment variables in your shell or use Node's `--env-file` option with a private file. Never commit keys.

For a UI-only walkthrough with synthetic recommendations and no provider calls:

```sh
node tests/make-fixture.mjs
node tests/dev-server.mjs --fixtures
```

In this mode, connect using any dummy tester code and upload the generated 120-second synthetic test recording. The fixture transcript is invented and the audio is a test tone; this mode does not evaluate recommendation quality or speech recognition. Never deploy the test server as the app's production backend.

## Connections

- Existing ElevenLabs connection: own API key or the existing tester proxy.
- Analysis: `OPENAI_API_KEY` on the server, gated by the existing `TESTER_PASSWORD`; optional `MOMENTS_MODEL` defaults to `gpt-6-astra`.
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
node --test tests/*.test.mjs
```

Tests cover section offsets and speaker isolation, sentence grouping, model boundary validation, deduplication, speaker filtering, caption rebasing, malformed transcript rejection, authentication and structured-response handling. Browser validation uses synthetic fixtures; paid provider transcription, recommendation quality on real conversations and translated dubbing require a configured live account.

## Deployment files

Deploy `index.html`, `moments.css`, `moments-core.mjs`, `moments-ui.mjs`, `timeline.mjs`, and `api/moments.js` alongside the existing app. Keep the existing ElevenLabs proxy and existing deployment settings. The API runs on the server; credentials must never be added to client files.

## Next steps

- Evaluate ranked passages against human selections on real recordings, starting with the Ingi episode.
- Durable asynchronous import/transcription for recordings beyond browser memory limits.
- Separate source adapters for YouTube and recorded X Spaces.
- Re-align dubbed audio to true word timestamps (the current dubbing pipeline uses its existing sentence transcript timings).
- Saved projects, batch language exports, and audio-aware ranking.

## Unified workspace design

This local version combines Find moments and Edit clip in one dialog. It does not change the deployed app.

- A real decoded waveform shows the full recording, with numbered colored moment ranges below it. Overlapping ranges use separate rows.
- Selecting a moment focuses a larger waveform with contextual padding and independent start/end handles. Arrow keys adjust by 0.1 second; Shift + arrow adjusts by one second. Numeric fields stay synchronized.
- Speaker turns use a separate neutral track, with section-scoped identities until named by the user. Color identifies moments, not speakers or an implied virality score.
- Prompt, length and speaker controls share one analysis area. Transcript completion is shown in the overview.
- The selected card brings together the reason, transcript, preview, context playback and audiogram handoff.
- Manual trimming works without transcription or model calls. Analysis and adjustments currently live only in the tab; finding fresh recommendations replaces the previous set.

Validation: 12 unit tests pass. Browser checks cover selection switching, keyboard and numeric trimming, manual trim without analysis, cached-caption handoff and playback of the resulting 36.9-second test selection. Fixture recommendations and text are invented, and fixture audio is a modulated test tone. Live transcription, ranking and dubbing are not evaluated by this prototype walkthrough.

## Live analysis and Design handoff

Port 4180 now runs real endpoints (`node tests/dev-server.mjs`). The synthetic demo uses a separate origin, port 4181 (`node tests/dev-server.mjs --fixtures`), so dummy tester credentials and transcripts cannot cross between the two. Reload older preview pages before using live analysis.

Connect ElevenLabs in the main Connect dialog. Choose My own API keys in Connect to enter both keys, or configure server-side OPENAI_API_KEY, ELEVENLABS_API_KEY and TESTER_PASSWORD. Never put keys in source files. The OpenAI key field is memory-only. Existing ElevenLabs connection behavior is unchanged.

Analysis defaults to GPT-6 Astra with low reasoning effort and an 8,000-token output budget. MOMENTS_MODEL overrides it. This is a quality-first candidate, not a benchmark winner. Model access and paid provider behavior still require a real account test. The independent critic, audio ranking and model benchmark are future work.

The sticky workspace footer selects original captions or a target-language dub. Continue to Design reuses available matching-language transcript timings; otherwise it transcribes the selected clip. Dubbing uses the existing ElevenLabs pipeline. Progress and failures remain visible in the workspace; only success closes it, collapses Create and focuses Design. Edit clip returns to the preserved selections.

## Unified Connect (current)

Connect now offers two explicit modes. Tester code uses TESTER_PASSWORD for both ElevenLabs and OpenAI; selecting it clears personal keys from the active connection. My own API keys collects ElevenLabs and OpenAI together; selecting it clears the tester code. OpenAI remains in tab memory; the pre-existing ElevenLabs browser storage behavior is unchanged. The workspace has only Manage connection, with no separate key field.

For this local preview, fill `.env.local` in this directory: ELEVENLABS_API_KEY, OPENAI_API_KEY, and TESTER_PASSWORD. Use your existing tester code as TESTER_PASSWORD. MOMENTS_MODEL defaults to gpt-6-astra. The server reloads these settings on each API request, so no restart is needed after edits. This file is excluded from Git and blocked by the static server. `.env.example` contains empty placeholders. Production hosting must configure these environment variables separately.

## Playback and discovery controls

Target clip length defaults to Auto (15–90 seconds, natural boundaries). Explicit length ranges remain available. Speaker filtering appears only when transcription identifies multiple distinct speaker identities; single-speaker recordings omit the filter. Actual durations remain on every selection and update with trimming.

A shared Play/Pause/Replay transport replaces the separate card playback buttons. It shows elapsed preview time and duration. Include surrounding audio adds up to ten seconds on each side for preview only; it never changes export boundaries. The transport remains visible as the user scrolls. Selecting another moment pauses playback and seeks to that preview’s start. Speaker samples also use this transport and are labeled as samples.
