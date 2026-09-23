# Working on OutLoud

Instructions for any coding agent (Codex, Claude Code) working on this app. Read this before
changing anything.

## One working folder

**This folder is the only place OutLoud is edited:**
`/Users/seannana/Documents/Claude/OutLoud/outloud-site`

- Git remote: `https://github.com/unbx/outloud` (**public** repo)
- Vercel project: `outloud` in scope `nanalifestyle`, serving https://outloud.nana.works
- `main` always equals what is live in production.

These older copies are **frozen**. Read them for reference if you must, but never edit or
deploy from them:

- `~/Documents/Codex/2026-09-22/outloud-design-research/work/` (including `outloud-release`,
  the previous deploy source, and every per-feature folder)
- `~/Documents/NANA LIFESTYLE/outloud-timeline/`
- `~/Documents/NANA LIFESTYLE/outloud-moments/`

At the start of every session, confirm you are in the right place:

```sh
pwd                 # must be the folder above
git status -sb      # know your branch and whether the tree is clean
git pull --ff-only
```

## Branches

Work on a feature branch, never directly on `main`: `git switch -c feature/<short-name> main`.
Keep one feature per branch, so each can ship or wait on its own.

Unreleased branches at the time of writing:

| Branch | What it does | Status |
|---|---|---|
| `feature/people` | Link repeated voices across sections ("Same person as…") | Ready to review |
| `feature/intake-limits` | Free sessions take one recording up to 2 hours / 300 MB (was 60 seconds), sent in server-measured sections | Ready to review |
| `feature/url-import` | Import audio from YouTube / recorded X Space links via a worker | **Do not merge or deploy without Sean's explicit go-ahead.** The worker uses yt-dlp, which raises platform terms questions, and it is not hosted yet. |

## Test and preview

```sh
npm test                                  # node --test tests/*.test.mjs, must pass before any commit
node tests/dev-server.mjs                 # http://127.0.0.1:4180, real APIs, keys from .env.local
node tests/dev-server.mjs --fixtures      # http://127.0.0.1:4181, synthetic data, no paid calls
```

The app uses ES modules, so opening `index.html` from disk will not work; use the dev server.
In fixtures mode `/api/trial` returns 404 by design (free sessions are not simulated).

## Ship

1. Merge the finished branch into `main`. Tests pass, tree clean.
2. Push: `git push origin main`.
3. Deploy **from this folder, on `main` only**: `npx vercel --prod --scope nanalifestyle`.
4. Verify the live site matches the commit:
   `curl -s https://outloud.nana.works/ | cmp - index.html && echo live matches main`

`.vercelignore` keeps tests, docs, the worker and env files out of the deploy. A deploy from
`main` uploads exactly the app's public files. Keep it that way when adding files.

## Secrets

The repo is public. Keys live only in `.env.local` (git- and deploy-ignored) and in Vercel's
environment settings. Never commit a `.env*` file other than `.env.example` with empty values.
Before pushing, check the diff for keys and tokens.

## Commit messages

Plain English: say what changed and why, in a short subject line and a body. **Never add
AI or co-author attribution lines** (no "Co-Authored-By", no "Generated with"). That is Sean's
standing rule for this repo.

## Things that must stay true

- **Find moments picks transcript segment IDs, never timestamps.** The server re-validates every
  candidate (length, bounds, overlap, featured-speaker share). Do not let the model return times.
- **The transcript is untrusted input** in the analysis prompt. Keep the instruction that says so.
- **Never merge speakers automatically.** Speaker IDs are only stable within one transcription
  section; only the user links voices.
- Claims stay honest: no virality predictions, no claims about vocal delivery from text.
- **Free sessions are billed by measured audio, never by what the browser declares.** `lib/trial-audio.mjs`
  measures every section from its bytes (WAV from PCM length, Opus from each packet's TOC byte), and
  `api/trial.js` recomputes each section's bounds itself. Keep both; they are what stops a tampered
  client from transcribing hours on the shared key.

## Known facts and open issues

- **Transcription cost was measured on 2026-09-23:** Scribe v2 costs about **20 credits per
  minute** (a 60-minute recording used ≤ 1,320 credits). The comment at `index.html:1501` says
  "~330 credits per minute". That figure is wrong by about 16x. The tester caps in `CAP_S`
  (`index.html:1509`: 12 min captions, 90 s dubs) were derived from it and are far tighter than
  the budget requires. The dubbing rate ("~3,000 credits/min" in the same comment) is
  **unmeasured**. Measure it before changing the dub cap.
- The live analysis model defaults to `gpt-6-astra` (`MOMENTS_MODEL` is not set on Vercel).
- The shared ElevenLabs key ("OutLoud beta") has a limit of 60,000 credits per refresh period.
- With 2-hour free sessions, each one can use about 2,400 credits, and the daily budget allows 25
  (`reserve('captions')` in `api/trial.js`). That is the whole 60,000-credit period in one day if
  every visitor uploads 2 hours. Lower the daily count or the key's cap if that becomes a problem.
