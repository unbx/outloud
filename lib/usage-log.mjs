// Usage log: one row per action into Supabase `public.events` (metadata only, never content).
// Best-effort by design: it never throws and never waits past a short timeout, so a slow or
// broken Supabase can't delay or fail anyone's request.
//
// Newer builds send columns the table may not have yet (design, plan, seconds). PostgREST
// rejects such a row with PGRST204; the row is retried without that column so the log keeps
// working, and the column is remembered for this warm instance so later rows skip the retry.
// Adding the column in Supabase starts filling it in on the next cold start.
const missing = new Set();
export const dropped = () => [...missing];

export async function logEvent(row) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return;
  const data = Object.fromEntries(Object.entries(row).filter(([k, v]) => v !== undefined && !missing.has(k)));
  for (let tries = 0; tries < 4; tries++) {
    try {
      const r = await fetch(url.replace(/\/+$/, '') + '/rest/v1/events', {
        method: 'POST',
        headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify(data), signal: AbortSignal.timeout(2500),
      });
      if (r.ok) return;
      const err = await r.json().catch(() => ({}));
      const column = err.code === 'PGRST204' && /'([^']+)' column/.exec(err.message || '')?.[1];
      if (!column || !(column in data)) return;
      missing.add(column); delete data[column];
    } catch { return; }
  }
}

// The two-letter country Vercel attaches to each request, or null.
export const countryOf = (req) => {
  const c = String(req.headers?.['x-vercel-ip-country'] || '').trim();
  return /^[A-Z]{2}$/.test(c) ? c : null;
};
