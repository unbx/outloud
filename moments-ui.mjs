import { LIMITS, normalizeWords, segmentsFromWords, clipWords, validRange } from './moments-core.mjs';

export function initMoments(app) {
  const $ = id => document.getElementById(id);
  const root = $('momentsPanel'), list = $('momentResults'), status = $('momentStatus');
  const find = $('findMoments'), cancel = $('cancelMoments'), player = $('momentPlayer');
  let file = null, decoded = null, words = [], completed = new Set(), language = null, sourceLanguage = null;
  let epoch = 0, controller = null, busy = false, complete = false, url = null, stopAt = 0, activeCard = null;
  let segments = [], labels = {}, transcriptPage = 0, duration = 0, playing = false;
  const format = value => { const s = Math.max(0, value); return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`; };
  const say = (message, error = false) => { status.textContent = message; status.classList.toggle('error', error); };
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const button = (text, fn) => { const b = el('button', text, 'moment-button'); b.type = 'button'; b.addEventListener('click', fn); return b; };
  const auth = () => ({ ...(app.testerPass() ? { 'x-tester-pass': app.testerPass() } : {}),
    ...($('momentKey').value.trim() ? { 'x-moments-key': $('momentKey').value.trim() } : {}) });
  function setBusy(on) {
    busy = on; find.disabled = on; cancel.hidden = !on;
    root.setAttribute('aria-busy', String(on));
    root.querySelectorAll('[data-edit]').forEach(n => { n.disabled = on; });
  }
  function stop() {
    playing = false; player.pause();
    if (activeCard) activeCard.querySelectorAll('.is-speaking').forEach(n => n.classList.remove('is-speaking'));
    activeCard = null;
  }
  function reset(next) {
    epoch++; controller?.abort(); controller = null; stop();
    if (url) URL.revokeObjectURL(url);
    file = next; decoded = null; words = []; segments = []; completed = new Set(); labels = {};
    complete = false; sourceLanguage = null; language = null; transcriptPage = 0; duration = 0; url = null;
    player.removeAttribute('src'); player.load();
    list.replaceChildren(); $('momentTranscript').replaceChildren(); $('momentSpeakers').replaceChildren();
    $('momentTranscriptWrap').hidden = true; $('momentSpeakerWrap').hidden = true;
    $('momentSpeaker').replaceChildren(new Option('Any speaker', ''));
    $('momentSource').textContent = next ? next.name : '';
    $('momentSelection').hidden = true; root.hidden = !next; setBusy(false);
    find.textContent = 'Find moments'; say('');
    $('momentUsage').textContent = 'Transcribes the full recording once. Audio goes to ElevenLabs; transcript and brief go to OpenAI for recommendations. Uses connected API credits. Kept in this tab until you replace the file or reload.';
    if (next) {
      url = URL.createObjectURL(next); player.src = url;
      const run = epoch;
      app.probe(next).then(d => {
        if (run !== epoch) return;
        duration = d || 0;
        $('momentUsage').textContent = `${d ? format(d) + ' to analyze. ' : ''}Transcribes the full recording once, using connected API credits. Audio → ElevenLabs; transcript + brief → OpenAI. Re-ranking reuses this tab’s transcript. Up to 2 hours / 300 MB; keep this tab open.`;
      });
    }
  }
  function check(run) { if (run !== epoch || controller?.signal.aborted) throw new DOMException('Cancelled', 'AbortError'); }
  async function readAudio(run) {
    if (decoded) return decoded;
    if (file.size > LIMITS.bytes || duration > LIMITS.seconds) throw new Error('Find moments supports recordings up to 2 hours and 300 MB. Upload a smaller audio file or excerpt.');
    const source = file;
    say('Reading the recording…');
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
    let buffer;
    try { buffer = await ctx.decodeAudioData(await source.arrayBuffer()); }
    catch (_) { throw new Error('This browser could not read the recording. Try an MP3, WAV or M4A audio file.'); }
    finally { await ctx.close(); }
    check(run);
    if (buffer.duration > LIMITS.seconds) throw new Error('This recording is longer than 2 hours. Upload a shorter excerpt.');
    decoded = buffer; duration = buffer.duration; return buffer;
  }
  async function slice(start, end, opus = false, rate = 24000) {
    if (!decoded || !validRange(start, end, decoded.duration)) throw new Error('Choose a valid start and end within the recording.');
    const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, Math.ceil((end - start) * rate), rate);
    const node = ctx.createBufferSource(); node.buffer = decoded; node.connect(ctx.destination); node.start(0, start, end - start);
    const buffer = await ctx.startRendering();
    return opus ? app.encodeOpus(buffer) : app.wav(buffer);
  }
  async function request(path, options) {
    const response = await fetch(path, { ...options, signal: controller.signal });
    const type = response.headers.get('content-type') || '';
    if (!type.includes('json')) throw new Error('Moment analysis needs the OutLoud server. Open the deployed app or start the local development server.');
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : `Request failed (${response.status}). Try again.`);
    return data;
  }
  async function transcribe(run) {
    await readAudio(run); check(run);
    // Stable partitioning allows retries to resume without retranscribing successful sections.
    const chunkSize = app.canOpus() ? 600 : LIMITS.chunk;
    const count = Math.ceil(duration / chunkSize);
    for (let section = 0; section < count; section++) {
      if (completed.has(section)) continue;
      check(run); say(`Transcribing section ${section + 1} of ${count}… You can cancel and resume in this tab.`);
      const boundaryStart = section * chunkSize, boundaryEnd = Math.min(duration, (section + 1) * chunkSize);
      const start = Math.max(0, boundaryStart - LIMITS.overlap), end = Math.min(duration, boundaryEnd + LIMITS.overlap);
      const opus = chunkSize === 600;
      let blob;
      try { blob = await slice(start, end, opus, 16000); }
      catch (e) { if (opus) throw new Error('Audio compression failed. Try a browser with Opus encoding support or upload a shorter recording.'); throw e; }
      check(run);
      if (blob.size > 4400000) throw new Error('This audio section is too large to process. Try a compressed audio recording.');
      const form = new FormData(); form.append('file', blob, opus ? 'section.ogg' : 'section.wav');
      form.append('model_id', app.sttModel); form.append('diarize', 'true'); form.append('tag_audio_events', 'false');
      if (sourceLanguage !== 'auto') form.append('language_code', sourceLanguage);
      const response = await fetch(app.elevenURL('speech-to-text'), {
        method: 'POST', headers: app.elevenHeaders(), body: form,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)])
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(typeof data.error === 'string' ? data.error : `Transcription paused (${response.status}). Check your connection or credits, then resume.`);
      }
      const data = await response.json(); check(run);
      const fresh = normalizeWords(data.words, start, section, boundaryStart, boundaryEnd);
      words.push(...fresh); words.sort((a, b) => a.start - b.start);
      if (words.length > LIMITS.words) throw new Error('This transcript is too large. Try a shorter excerpt.');
      language ||= data.language_code; completed.add(section);
    }
    complete = true; segments = segmentsFromWords(words); updateSpeakers(); renderTranscript();
    if (!words.length) throw new Error('No speech was found in this recording. Try a recording with clearer speech.');
  }
  async function analyze() {
    if (!file || busy) return;
    if (!complete && !app.connected()) { app.connect(); return; }
    if (sourceLanguage && sourceLanguage !== app.sourceLanguage()) {
      words = []; completed.clear(); complete = false; language = null; segments = []; labels = {};
      list.replaceChildren(); $('momentTranscriptWrap').hidden = true; $('momentSpeakerWrap').hidden = true;
      $('momentSpeaker').replaceChildren(new Option('Any speaker', ''));
    }
    sourceLanguage = app.sourceLanguage();
    const run = epoch; controller = new AbortController(); setBusy(true); stop();
    try {
      say('Checking analysis connection…');
      await request('/api/moments', { method: 'GET', headers: auth() }); check(run);
      if (!complete) await transcribe(run);
      check(run); say('Finding distinct moments with a strong hook and a complete takeaway…');
      const [min, max] = $('momentLength').value.split('-').map(Number);
      const mapped = segments.map(s => ({ id: s.id, start: s.start, end: s.end, text: s.text, speaker: labels[s.speaker]?.trim() || s.speaker }));
      const data = await request('/api/moments', { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ segments: mapped, min, max, brief: $('momentBrief').value, speaker: $('momentSpeaker').value }) });
      check(run); list.replaceChildren();
      (data.moments || []).forEach((moment, i) => list.append(card(moment, i + 1)));
      say(data.moments?.length ? `${data.moments.length} recommended moments. Listen and check context before creating. Rankings use the transcript, not vocal delivery.` : 'No complete moments fit this brief and length. Try a wider length, any speaker, or select a passage from the transcript.');
    } catch (e) {
      if (run === epoch) say(e.name === 'AbortError' ? 'Stopped. Completed sections are kept in this tab. Find moments to resume.' : e.message, e.name !== 'AbortError');
    } finally {
      if (run === epoch) { setBusy(false); find.textContent = complete ? 'Find more moments' : completed.size ? 'Resume finding moments' : 'Find moments'; }
    }
  }
  function speakerLabel(id) {
    if (labels[id]?.trim()) return labels[id].trim();
    const match = /^s(\d+):speaker_(\d+)$/.exec(id);
    return match ? `Speaker ${Number(match[2]) + 1} · section ${Number(match[1]) + 1}` : id === 'unknown' ? 'Unidentified speaker' : id;
  }
  function updateSpeakerOptions() {
    const previous = $('momentSpeaker').value;
    const ids = [...new Set(segments.map(s => labels[s.speaker]?.trim() || s.speaker))];
    $('momentSpeaker').replaceChildren(new Option('Any speaker', ''));
    ids.forEach(id => $('momentSpeaker').add(new Option(speakerLabel(id), id)));
    if (ids.includes(previous)) $('momentSpeaker').value = previous;
  }
  function updateSpeakers() {
    const box = $('momentSpeakers'); box.replaceChildren();
    [...new Set(words.map(w => w.speaker))].filter(id => id !== 'unknown').forEach((id, i) => {
      const first = words.find(w => w.speaker === id);
      const row = el('div', null, 'moment-speaker-row'), label = el('label', speakerLabel(id));
      const input = el('input'); input.id = `moment-speaker-${i}`; label.htmlFor = input.id;
      input.placeholder = 'Name (optional)'; input.maxLength = 80; input.value = labels[id] || '';
      input.dataset.edit = 'true';
      input.addEventListener('change', () => { labels[id] = input.value.trim(); updateSpeakerOptions(); renderTranscript(); });
      row.append(label, input, button('Hear sample', () => preview(first.start, Math.min(duration, first.start + 8)))); box.append(row);
    });
    $('momentSpeakerWrap').hidden = !box.children.length; updateSpeakerOptions();
  }
  function preview(start, end, cardElement = null) {
    if (!validRange(start, end, duration)) { say('Choose a valid start and end within the recording.', true); return; }
    stop(); app.pause(); activeCard = cardElement; stopAt = end; playing = true;
    player.currentTime = start;
    player.play().catch(() => { stop(); say('Playback was blocked. Try Play again, or upload an audio-only file.', true); });
  }
  player.addEventListener('timeupdate', () => {
    if (!playing) return;
    if (player.currentTime >= stopAt) { stop(); return; }
    if (activeCard) activeCard.querySelectorAll('[data-word-start]').forEach(n =>
      n.classList.toggle('is-speaking', player.currentTime >= Number(n.dataset.wordStart) && player.currentTime < Number(n.dataset.wordEnd)));
  });
  player.addEventListener('ended', stop);
  function textFor(start, end, target) {
    target.replaceChildren();
    words.filter(w => w.end > start && w.start < end).forEach(w => {
      const span = el('span', w.text + ' '); span.dataset.wordStart = w.start; span.dataset.wordEnd = w.end; target.append(span);
    });
  }
  function card(moment, rank) {
    const article = el('article', null, 'moment-card');
    article.append(el('div', rank ? `MOMENT ${String(rank).padStart(2, '0')}` : 'YOUR SELECTION', 'moment-eyebrow'));
    article.append(el('h3', moment.title));
    if (moment.speakers?.length) article.append(el('p', moment.speakers.map(speakerLabel).join(' / '), 'moment-meta'));
    const meta = el('p', '', 'moment-meta'), quote = el('p', '', 'moment-quote');
    const range = el('div', null, 'moment-range');
    const start = el('input'), end = el('input');
    for (const [node, value, name] of [[start, moment.start, 'Start (seconds)'], [end, moment.end, 'End (seconds)']]) {
      node.type = 'number'; node.step = '0.1'; node.min = '0'; node.max = String(duration); node.value = value.toFixed(1);
      node.setAttribute('aria-label', name); node.dataset.edit = 'true';
      const label = el('label', name); label.append(node); range.append(label);
    }
    const refresh = () => { stop(); const a = Number(start.value), b = Number(end.value);
      meta.textContent = `${format(a)} – ${format(b)} · ${(b - a).toFixed(1)} seconds`;
      textFor(a, b, quote); };
    start.addEventListener('change', refresh); end.addEventListener('change', refresh); refresh();
    article.append(meta, el('p', moment.reason, 'moment-reason'));
    if (moment.context) article.append(el('p', 'Context: ' + moment.context, 'moment-context'));
    const actions = el('div', null, 'moment-actions');
    actions.append(button('Play moment', () => preview(Number(start.value), Number(end.value), article)),
      button('Hear context', () => preview(Math.max(0, Number(start.value) - 10), Math.min(duration, Number(end.value) + 10), article)),
      button('Stop', stop));
    const use = button('Create audiogram →', async () => {
      if (busy || app.busy()) return;
      const a = Number(start.value), b = Number(end.value), run = epoch;
      if (!start.value || !end.value || !validRange(a, b, duration)) { say('Choose a valid start and end within the recording.', true); return; }
      if (b - a > 90) { say('Keep the selected moment within 90 seconds for this first version.', true); return; }
      controller = new AbortController(); setBusy(true); stop();
      try {
        app.unlockAudio(); await readAudio(run); check(run);
        const blob = await slice(a, b); check(run);
        await app.useMoment({ file, start: a, end: b, title: moment.title, blob, words: clipWords(words, a, b), language });
        check(run);
        $('momentSelection').hidden = false;
        $('momentSelection').textContent = `Selected ${format(a)}–${format(b)} from ${file.name}. Original audio and captions are ready. Choose a language below to dub this selection.`;
        say('Audiogram ready in the editor. Your other moments are kept here.');
      } catch (e) { if (run === epoch) say(e.message, true); }
      finally { if (run === epoch) setBusy(false); }
    });
    use.classList.add('moment-use'); use.dataset.edit = 'true'; actions.append(use);
    article.append(quote, range, actions); return article;
  }
  function renderTranscript() {
    $('momentTranscriptWrap').hidden = !segments.length;
    const box = $('momentTranscript'); box.replaceChildren();
    const query = $('momentSearch').value.toLowerCase().trim();
    const filtered = segments.filter(s => !query || s.text.toLowerCase().includes(query));
    const shown = filtered.slice(0, (transcriptPage + 1) * 80);
    shown.forEach(s => {
      const row = el('div', null, 'moment-transcript-row');
      row.append(el('small', `${format(s.start)} · ${speakerLabel(s.speaker)}`), el('p', s.text));
      row.append(button('Start here', () => { $('manualMomentStart').value = s.start.toFixed(1); }),
        button('End here', () => { $('manualMomentEnd').value = s.end.toFixed(1); })); box.append(row);
    });
    if (shown.length < filtered.length) box.append(button('Show more transcript', () => { transcriptPage++; renderTranscript(); }));
    if (!filtered.length) box.append(el('p', 'No matching passages.'));
  }
  $('momentSearch').addEventListener('input', () => { transcriptPage = 0; renderTranscript(); });
  $('manualMomentAdd').addEventListener('click', () => {
    const a = Number($('manualMomentStart').value), b = Number($('manualMomentEnd').value);
    if (!$('manualMomentStart').value || !$('manualMomentEnd').value || !validRange(a, b, duration) || b - a > 90) { say('Select a passage between 0.25 and 90 seconds within the recording.', true); return; }
    const selected = card({ start: a, end: b, title: 'Your selected passage', reason: 'A passage you selected from the original recording.' });
    list.prepend(selected); selected.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  find.addEventListener('click', analyze);
  cancel.addEventListener('click', () => controller?.abort());
  $('momentSpeaker').addEventListener('change', () => say('Speaker preference updated. Find more moments to apply it.'));
  $('momentKeyClear').addEventListener('click', () => { $('momentKey').value = ''; say('Analysis key cleared from this page.'); });
  return {
    reset,
    cachedTranscript(source, start, end, spoken) {
      if (source !== file || !complete || spoken !== sourceLanguage || !validRange(start, end, duration)) return null;
      return { words: clipWords(words, start, end).map(w => ({ ...w, type: 'word' })), language_code: language };
    }
  };
}
