// Feedback → email via Resend. Configure RESEND_API_KEY on the Vercel project
// (optional: FEEDBACK_TO / FEEDBACK_FROM). Without the key this returns 501 and the
// client falls back to a prefilled mailto: compose, so feedback still works.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only." });
    return;
  }
  const KEY = process.env.RESEND_API_KEY;
  if (!KEY) {
    res.status(501).json({ error: "Feedback email is not configured." });
    return;
  }

  // light per-instance rate limit — this endpoint writes to a real inbox
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "anon";
  if (rateLimited(ip)) {
    res.status(429).json({ error: "Too many messages. Give it a minute." });
    return;
  }

  const body = (typeof req.body === "object" && req.body) || {};
  const topic = String(body.topic || "Feedback").slice(0, 60);
  const from = String(body.from || "").trim().slice(0, 120);
  const message = String(body.message || "").trim().slice(0, 5000);
  if (!message) {
    res.status(400).json({ error: "Empty message." });
    return;
  }

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.FEEDBACK_FROM || "OutLoud <studio@nanalifestyle.com>",
      to: [process.env.FEEDBACK_TO || "sean@nana.works"],
      subject: "OutLoud " + topic.toLowerCase(),
      reply_to: /.@./.test(from) ? from : undefined,
      text: message + "\n\n---\n" + (from ? "From: " + from + "\n" : "") + "Sent from outloud.nana.works",
    }),
  }).catch(() => null);

  if (!r || !r.ok) {
    res.status(502).json({ error: "Send failed." });
    return;
  }
  res.status(200).json({ ok: true });
}

// warm-instance memory only — caps bursts
const HITS = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (HITS.get(ip) || []).filter((t) => now - t < 60_000);
  arr.push(now);
  HITS.set(ip, arr);
  return arr.length > 3;
}
