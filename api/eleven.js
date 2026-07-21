// Serverless proxy for tester access.
//
// Holds the ElevenLabs API key server-side (env: ELEVENLABS_API_KEY) so it never reaches the
// browser. A shared tester password (env: TESTER_PASSWORD) gates access. Only the handful of
// endpoints OutLoud needs are forwarded — listing voices, text-to-speech, and dubbing — so a
// leaked password can't be used to hit arbitrary account endpoints. The real backstop against
// abuse is a credit-capped ElevenLabs key (see DEPLOY.md): give ELEVENLABS_API_KEY only
// Text-to-Speech + Voices(read) + Dubbing(write) + Models access and a low credit cap.
//
// Routing: vercel.json rewrites /api/eleven/<path> -> /api/eleven?path=<path>. A bracket
// catch-all ([...path].js) only matched a single segment on Vercel, so multi-segment paths
// like text-to-speech/<id>/with-timestamps 404'd before reaching the function.
//
// Body parsing is disabled so file uploads (multipart/form-data for dubbing) and JSON bodies
// (TTS) both pass through untouched — we stream the raw request body and forward the caller's
// Content-Type (boundary included) verbatim.

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  const start = Date.now();
  const KEY = process.env.ELEVENLABS_API_KEY;
  const PASS = process.env.TESTER_PASSWORD;

  if (!KEY || !PASS) {
    res.status(500).json({ error: "Tester proxy is not configured (missing ELEVENLABS_API_KEY / TESTER_PASSWORD)." });
    return;
  }

  // --- password check (length-checked constant-time compare) ---
  // Trim both sides: env values pasted into `vercel env add` can pick up a trailing newline/space.
  const given = String(req.headers["x-tester-pass"] || "").trim();
  if (!safeEqual(given, String(PASS).trim())) {
    res.status(401).json({ error: "Invalid tester password." });
    return;
  }

  // --- resolve the ElevenLabs path from the rewrite (?path=...), falling back to the raw URL ---
  let path = "";
  const q = req.query && req.query.path;
  if (q) {
    path = Array.isArray(q) ? q.join("/") : String(q);
  } else {
    const m = /\/api\/eleven\/([^?]*)/.exec(req.url || "");
    if (m) path = decodeURIComponent(m[1]);
  }
  path = path.replace(/^\/+|\/+$/g, ""); // trim stray slashes

  // --- whitelist (only what OutLoud calls) ---
  const ID = "[A-Za-z0-9_-]+";        // dubbing ids / voice ids
  const LANG = "[A-Za-z0-9_-]+";      // language codes (incl. "auto"/"source")
  const isVoices = req.method === "GET" && path === "voices";
  const isTTS = req.method === "POST" &&
    new RegExp(`^text-to-speech/${ID}(/(with-timestamps|stream))?$`).test(path);
  const isDubCreate = req.method === "POST" && path === "dubbing";
  const isSTT = req.method === "POST" && path === "speech-to-text"; // caption-only clips (Scribe)
  const isDubStatus = req.method === "GET" && new RegExp(`^dubbing/${ID}$`).test(path);
  const isDubAudio = req.method === "GET" && new RegExp(`^dubbing/${ID}/audio/${LANG}$`).test(path);
  const isDubTranscript = req.method === "GET" && (
    new RegExp(`^dubbing/${ID}/transcripts/${LANG}/format/(srt|webvtt|json)$`).test(path) ||
    new RegExp(`^dubbing/${ID}/transcript/${LANG}$`).test(path)
  );

  const allowed = isVoices || isTTS || isDubCreate || isDubStatus || isDubAudio || isDubTranscript || isSTT;
  if (!allowed) {
    res.status(403).json({ error: "This endpoint is not available through the tester proxy." });
    return;
  }

  // --- rate limit the credit-spending POSTs only (create-dub / TTS). Polling GETs are cheap and
  //     would otherwise trip the limit during a long dub, so they're exempt. ---
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "anon";
  if (req.method === "POST" && rateLimited(ip)) {
    res.status(429).json({ error: "Too many requests — slow down a moment." });
    return;
  }

  // --- forward to ElevenLabs with the server-side key ---
  const headers = { "xi-api-key": KEY };
  if (req.headers["accept"]) headers["Accept"] = String(req.headers["accept"]);
  let body;
  if (req.method === "POST") {
    // Preserve the caller's Content-Type verbatim (JSON for TTS, multipart boundary for dubbing).
    if (req.headers["content-type"]) headers["Content-Type"] = String(req.headers["content-type"]);
    body = await readRawBody(req);
  }

  let upstream;
  try {
    upstream = await fetch("https://api.elevenlabs.io/v1/" + path, { method: req.method, headers, body });
  } catch (e) {
    res.status(502).json({ error: "Upstream request failed." });
    return;
  }

  const buf = Buffer.from(await upstream.arrayBuffer());

  // --- usage analytics: log one row per generation (metadata only, never content). Awaited so
  //     the serverless instance doesn't die before it completes, but timeout- and error-guarded
  //     so a slow/broken Supabase can never delay or fail the user's request. ---
  const feature = isTTS ? "script" : isDubCreate ? "dub" : isSTT ? "caption" : null;
  if (feature) {
    await logEvent({
      feature,
      target_lang: cleanTag(req.headers["x-ol-lang"], 12),
      ok: upstream.ok,
      status: upstream.status,
      country: cleanTag(req.headers["x-vercel-ip-country"], 2),
      ms: Date.now() - start,
      bytes: buf.length,
    });
  }

  // --- credit-cap safety net: when the shared key runs out of ElevenLabs credits, the raw
  //     error is a cryptic 401 that the app would misread as a bad tester password. Surface
  //     it honestly instead (402 = beta usage limit reached). ---
  if (!upstream.ok && /quota_exceeded|usage_limit|credits?_(exceeded|remaining|left)|insufficient.credit/i.test(buf.toString("utf8").slice(0, 600))) {
    res.status(402).json({
      error: "OutLoud's beta hit its shared usage limit for now. Try again later, or connect your own ElevenLabs key (Connect, top right) to keep going.",
    });
    return;
  }

  res.status(upstream.status);
  res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
  res.send(buf);
}

function cleanTag(v, max) {
  const s = String(v || "").trim();
  return s ? s.slice(0, max) : null;
}

// Fire an event row into Supabase (REST). Best-effort: never throws, never blocks past the timeout.
async function logEvent(row) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return;
  try {
    await fetch(url.replace(/\/+$/, "") + "/rest/v1/events", {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(row),
      signal: AbortSignal.timeout(2500),
    });
  } catch (_) { /* analytics is best-effort */ }
}

// Stream the raw request body into a Buffer (bodyParser is disabled above).
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

// Warm-instance memory only — resets on cold start. Caps bursts, not a hard guarantee.
const HITS = new Map(); // ip -> number[] (timestamps, ms)
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;
function rateLimited(ip) {
  const now = Date.now();
  const arr = (HITS.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  HITS.set(ip, arr);
  return arr.length > MAX_PER_WINDOW;
}
