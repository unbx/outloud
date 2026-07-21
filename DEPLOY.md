# Deploy OutLoud to Vercel → outloud.nana.works

This folder is deploy-ready: `index.html` (the full app) + `vercel.json`. The app is fully client-side — the ElevenLabs key is entered by each user at runtime and stored only in their browser, so there are **no secrets to configure**.

## 1. Deploy (2 commands)

Open Terminal and run:

```bash
cd ~/Documents/Claude/OutLoud/outloud-site
npx vercel@latest --prod
```

On first run it will:
- prompt you to log in (browser),
- ask which scope → choose **NANA** (`nanalifestyle`),
- "Set up and deploy?" → **yes**, project name → **outloud**, framework → **Other** (it's static), accept defaults.

You'll get a live `https://outloud-….vercel.app` URL. Confirm it works (add your ElevenLabs key, generate one audiogram).

## 2. Attach outloud.nana.works

Easiest via dashboard: **vercel.com → NANA team → the `outloud` project → Settings → Domains → Add** → enter `outloud.nana.works`.

Or by CLI:
```bash
npx vercel@latest domains add outloud.nana.works outloud
```

## 3. Point DNS

Vercel will show the exact record. Two cases:

- **If nana.works' nameservers are already on Vercel** → it auto-verifies, nothing to do.
- **If DNS is elsewhere** (registrar / Cloudflare) → add this record on nana.works:
  - Type: **CNAME**
  - Name/Host: **outloud**
  - Value/Target: **cname.vercel-dns.com** (use whatever Vercel displays)

SSL is issued automatically. Within a few minutes: **https://outloud.nana.works** 🎉

## Tester access (let people try it without your key)

The site supports a **tester password**: testers enter a password (not a key) in the Connect
dialog, and requests route through a serverless proxy (`api/eleven.js`, with a `vercel.json` rewrite from
`/api/eleven/*`) that injects
*your* key **server-side**. Your key is never sent to the browser. Only voice-list + TTS calls
are allowed through the proxy.

Set two env vars on the project (the key is entered at the prompt, never in a file):

```bash
cd ~/Documents/Claude/OutLoud/outloud-site
# paste a CREDIT-CAPPED, TTS-scoped ElevenLabs key when prompted (so abuse is bounded):
npx vercel@latest env add ELEVENLABS_API_KEY production --scope nanalifestyle
# type the password you'll share with testers:
npx vercel@latest env add TESTER_PASSWORD production --scope nanalifestyle
# env changes only take effect on a new deploy:
npx vercel@latest --prod --scope nanalifestyle
```

**Strongly recommended:** make `ELEVENLABS_API_KEY` a *separate* key with a low monthly credit
limit (elevenlabs.io → Settings → API Keys → restrict it to **Text-to-Speech (Access)**,
**Speech to Text (Access)** (caption-only clips), **Voices (Read)**, **Dubbing (Write)** and
**Models (Access)**, plus a credit cap).
Dubbing and Eleven v3 both need those endpoints allowed — without them the app 404s. Also note
tester **dubbing uploads are capped at 8 MB**: Vercel rejects proxied bodies over ~4.5 MB, so
clips between 4–8 MB are auto-compressed in the browser (mono 24 kHz WAV ≈ 3 MB/min) before
upload; past 8 MB (or ~90s compressed) the app tells testers to trim or use their own key.
Testers spend against that key; the cap + the password are your safety net. Rotate the password
anytime by re-running `env add` (it'll ask to overwrite) and redeploying. To revoke all tester
access instantly, delete the key in the ElevenLabs dashboard.

The proxy has a light per-instance rate limit (20 req/min/IP); the credit cap is the real backstop.

## Updating later

Re-deploy after any edit by re-running `npx vercel@latest --prod` from this folder (or connect the folder to a Git repo for push-to-deploy).
