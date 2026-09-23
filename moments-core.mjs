// Pure transcript/selection helpers, shared by the browser, API and tests.
export const LIMITS = { seconds: 7200, bytes: 300000000, words: 40000, chunk: 120, overlap: 2 };

export function normalizeWords(raw, offset = 0, section = 0, keepStart = 0, keepEnd = Infinity) {
  return (Array.isArray(raw) ? raw : []).filter(w =>
    (!w.type || w.type === 'word') && typeof w.text === 'string' && w.text.trim() &&
    Number.isFinite(w.start) && Number.isFinite(w.end) && w.start >= 0 && w.end > w.start
  ).map(w => ({ text: w.text.trim(), start: w.start + offset, end: w.end + offset,
    speaker: w.speaker_id == null ? 'unknown' : `s${section}:${w.speaker_id}`
  })).filter(w => (w.start + w.end) / 2 >= keepStart && (w.start + w.end) / 2 < keepEnd)
    .sort((a, b) => a.start - b.start);
}

export function segmentsFromWords(words) {
  const segments = [];
  let current = null;
  words.forEach((w, i) => {
    if (!current || current.speaker !== w.speaker || w.start - current.end > 1.2 ||
        current.text.length > 500 || /[.!?][”"']?$/.test(current.text)) {
      current = { id: segments.length, start: w.start, end: w.end, speaker: w.speaker,
        text: w.text, firstWord: i, lastWord: i };
      segments.push(current);
    } else {
      current.text += ' ' + w.text; current.end = w.end; current.lastWord = i;
    }
  });
  return segments;
}

export function validateSegments(input) {
  if (!Array.isArray(input) || !input.length || input.length > 12000) throw new Error('Invalid transcript.');
  let chars = 0, last = -1;
  const out = input.map((s, i) => {
    if (!s || s.id !== i || !Number.isFinite(s.start) || !Number.isFinite(s.end) ||
        s.start < last || s.start < 0 || s.end <= s.start || s.end > LIMITS.seconds + 5 ||
        typeof s.text !== 'string' || !s.text.trim() || s.text.length > 2000 ||
        typeof s.speaker !== 'string' || s.speaker.length > 100) throw new Error('Invalid transcript.');
    last = s.start; chars += s.text.length;
    return { id: i, start: s.start, end: s.end, text: s.text, speaker: s.speaker };
  });
  if (chars > 280000) throw new Error('Transcript is too large. Use a shorter recording.');
  return out;
}

export function validateCandidates(raw, segments, min = 30, max = 60, speaker = '') {
  const picked = [];
  for (const c of Array.isArray(raw) ? raw : []) {
    if (!c || !Number.isInteger(c.startSegment) || !Number.isInteger(c.endSegment) ||
        c.startSegment < 0 || c.endSegment < c.startSegment || c.endSegment >= segments.length) continue;
    const first = segments[c.startSegment], last = segments[c.endSegment];
    const start = first.start, end = last.end, duration = end - start;
    if (duration < min || duration > max) continue;
    const selected = segments.slice(c.startSegment, c.endSegment + 1);
    if (speaker) {
      const total = selected.reduce((v, s) => v + s.end - s.start, 0);
      const guest = selected.filter(s => s.speaker === speaker).reduce((v, s) => v + s.end - s.start, 0);
      if (!total || guest / total < 0.7) continue;
    }
    if (picked.some(p => Math.max(0, Math.min(end, p.end) - Math.max(start, p.start)) / Math.min(duration, p.end - p.start) > 0.35)) continue;
    if (typeof c.title !== 'string' || typeof c.reason !== 'string') continue;
    picked.push({ start, end, title: c.title.slice(0, 120), reason: c.reason.slice(0, 400),
      context: typeof c.context === 'string' ? c.context.slice(0, 400) : '',
      speakers: [...new Set(selected.map(s => s.speaker))],
      text: selected.map(s => s.text).join(' ') });
    if (picked.length === 5) break;
  }
  return picked;
}

export function clipWords(words, start, end) {
  return words.filter(w => w.end > start && w.start < end).map(w => ({
    text: w.text, start: Math.max(0, w.start - start), end: Math.min(end - start, w.end - start), nl: 0
  }));
}

export function validRange(start, end, duration) {
  return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end <= duration + 0.001 && end - start >= 0.25;
}

export const candidateSchema = {
  type: 'object', additionalProperties: false, required: ['moments'], properties: {
    moments: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['startSegment', 'endSegment', 'title', 'reason', 'context'], properties: {
        startSegment: { type: 'integer' }, endSegment: { type: 'integer' }, title: { type: 'string' },
        reason: { type: 'string' }, context: { type: 'string' }
      } } }
  }
};

// Search results are bounded, ready-to-preview passages. Literal, case-insensitive matching.
export function transcriptPassages(segments, words, query, duration) {
  const needle = query.trim().toLowerCase();
  return segments.filter(s => !needle || s.text.toLowerCase().includes(needle)).map(s => {
    let start = s.start, end = Math.min(duration, s.end);
    if (end - start > 90) {
      const offset = Math.max(0, s.text.toLowerCase().indexOf(needle));
      let chars = 0, anchor = s.start;
      for (const w of words.slice(s.firstWord, s.lastWord + 1)) {
        anchor = w.start;
        if (chars + w.text.length > offset) break;
        chars += w.text.length + 1;
      }
      start = Math.max(s.start, Math.min(anchor - 10, end - 90));
      end = Math.min(end, start + 90);
    }
    return { ...s, start, end };
  }).filter(s => validRange(s.start, s.end, duration));
}

// Use only names explicitly assigned to voices present in the selected time range.
export function labeledSpeakersForRange(words, labels, start, end) {
  const names = [];
  for (const word of words) {
    if (word.end <= start || word.start >= end) continue;
    const name = labels[word.speaker]?.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names.join(' & ');
}
