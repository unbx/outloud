import { createTimeline, MOMENT_COLORS, timeLabel, rangeForDuration, renderDurationFace, segField, segText } from './timeline.mjs';
import { LIMITS, normalizeWords, segmentsFromWords, clipWords, validRange, transcriptPassages, labeledSpeakersForRange, parseTimecode, parseDuration } from './moments-core.mjs';

export function initMoments(app) {
  const $ = id => document.getElementById(id);
  const root = $('momentsPanel'), list = $('momentResults'), status = $('momentStatus');
  $('studioBody').append(root); // Clip editor is a sibling of the other workstation stages.
  const find = $('findMoments'), cancel = $('cancelMoments'), player = $('momentPlayer');
  let file = null, decoded = null, words = [], completed = new Set(), language = null, sourceLanguage = null;
  let epoch = 0, controller = null, busy = false, complete = false, url = null, stopAt = 0, activeCard = null;
  let people = {};
  let segments = [], labels = {}, transcriptPage = 0, duration = 0, playing = false;
  let previewStart = 0, samplePreview = false, searchPreview = null;
  let choices = [], selectedId = null, nextId = 1, decoding = null;
  let generating = false, handoffError = null, analysisFailed = false, analyzed = false;
  const output = $('momentTarget'), continueButton = $('momentContinue');
  // Under the "Language" heading the original just reads "Original": every choice is captioned,
  // so the qualifier added nothing, and the short label fits a phone.
  app.targets().forEach(t => output.add(new Option(t.value === 'same' ? 'Original' : t.label, t.value)));
  const scope = $('momentScope');
  scope.addEventListener('change', () => { handoffError = null; handoff(); });
  const usesFullRecording = item => scope.value === 'full' || (item && item.start <= .05 && item.end >= duration - .05);
  // While captions or a dub are being made, the button itself shows the step and the time spent,
  // so a long dub never looks like a button that did nothing.
  let workLabel = '', workStarted = 0, workTimer = 0;
  const setHandoffStatus = (text, tone = '') => { const n = $('handoffStatus'); n.textContent = text; n.dataset.tone = tone; };
  const elapsed = () => { const t = Math.floor((Date.now() - workStarted) / 1000); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
  // Boundary fields show tenths of a second, so an end at the very end of a 7.48 s recording reads
  // "7.5". Reading a field back allows for that rounding (at most 0.05 s) rather than calling the
  // recording's own end out of range. A value genuinely outside the recording is still refused.
  const withinRecording = (a, b) => [a < 0 && a > -0.051 ? 0 : a, b > duration && b - duration < 0.051 ? duration : b];
  function handoff() {
    const item = choices.find(m => m.id === selectedId);
    const full = usesFullRecording(item);
    $('handoffSelection').textContent = full ? `Full recording · ${timeLabel(duration)}` : item ? `${String(item.number).padStart(2, '0')} · ${item.title} · ${(item.end - item.start).toFixed(1)}s` : 'Choose a moment';
    continueButton.textContent = generating && workLabel ? `${workLabel} · ${elapsed()}`
      : output.value === 'same' ? (full ? 'Caption full clip →' : 'Caption selection →') : (full ? 'Dub full clip →' : 'Dub selection →');
    continueButton.classList.toggle('is-working', generating);
    continueButton.setAttribute('aria-busy', String(generating));
    if (!busy && !handoffError) setHandoffStatus(file && !full && !item ? 'Choose a moment first: drag the waveform edges, or press ANALYZE.'
      : output.value === 'same' ? 'Original voice, with captions. Style it next.' : 'Keeps the speaker’s voice. Uses dubbing credits.');
    continueButton.disabled = busy || !file || (!full && !item);
  }
  output.addEventListener('change', () => { handoffError = null; handoff(); });
  continueButton.addEventListener('click', async () => {
    const item = choices.find(m => m.id === selectedId);
    const full = usesFullRecording(item);
    if (!file || (!full && !item) || busy || app.busy()) return;
    const [a, b] = full ? [0, duration] : withinRecording(parseTimecode(item.startInput.value), parseTimecode(item.endInput.value)), run = epoch;
    const title = full ? file.name : item.title;
    if (app.free?.() && output.value !== 'same') { app.pro('dub'); return; }
    // The longest clip this plan and output can send: two minutes of free captions, 90 seconds of dub.
    const most = app.maxClip(output.value), mins = most >= 60 ? `${Math.floor(most / 60)} minute${most >= 120 ? 's' : ''}${most % 60 ? ` ${most % 60} seconds` : ''}` : `${most} seconds`;
    if (!validRange(a, b, duration) || b - a > most + 0.4) {
      const why = full && validRange(a, b, duration) ? `This recording is longer than ${mins}. Drag the waveform edges, or use IN and OUT, to pick up to ${mins}.` : `Choose a valid selection of up to ${mins}.`;
      say(why, true); setHandoffStatus(why, 'error'); return;
    }
    const cached = !full && complete && sourceLanguage === app.sourceLanguage();
    handoffError = null; controller = new AbortController(); generating = true;
    workLabel = output.value === 'same' ? 'Captioning…' : 'Dubbing…'; workStarted = Date.now();
    clearInterval(workTimer); workTimer = setInterval(handoff, 1000);
    setBusy(true); stop();
    const progress = (message, error = false) => {
      say(message, error); setHandoffStatus(message, error ? 'error' : 'progress');
      // The step name goes on the button; its own running seconds are dropped for the shared timer.
      if (!error) { workLabel = message.replace(/\s*\d+s(\s*\/\s*~\d+s)?\s*$/, '').slice(0, 44); handoff(); }
    };
    try {
      app.unlockAudio(); progress(output.value === 'same' ? 'Preparing your captions…' : 'Preparing your dub…');
      if (full && output.value === 'same') {
        await app.captionFullClip(progress);
      } else if (cached && output.value === 'same') {
        await readAudio(run); check(run); const blob = await slice(a, b); check(run);
        await app.useMoment({file, start:a, end:b, title, blob, words:clipWords(words,a,b), language});
      } else {
        await app.generateSelection({file, start:a, end:b, title}, output.value, progress);
      }
      check(run); generating = false; closeWorkspace(); app.enterDesign(labeledSpeakersForRange(words, labels, a, b));
    } catch(e) { if (run === epoch) { handoffError = e.message; progress(e.message, true); } }
    finally { generating = false; clearInterval(workTimer); workLabel = ''; if (run === epoch) setBusy(false); else handoff(); }
  });
  const detail = $('momentDetail');
  const timeline = createTimeline($('clipTimeline'), {
    select: id => selectMoment(id),
    change: (start, end) => {
      const item = choices.find(m => m.id === selectedId);
      if (!item) return;
      item.startInput.value = timeLabel(start); item.endInput.value = timeLabel(end); item.refresh(true);
    },
    seek: time => { stop(); samplePreview = false; const [a,b] = playbackBounds(); player.currentTime = Math.max(a, Math.min(b,time)); timeline.playhead(player.currentTime); syncPlayback(); }
  });
  function selectMoment(id, fit = true) {
    stop(); searchPreview = null; selectedId = id; scope.value = 'selection';
    choices.forEach(item => {
      item.tab.setAttribute('aria-pressed', String(item.id === id)); item.article.hidden = item.id !== id;
    });
    const item = choices.find(m => m.id === id); if (item) { timeline.select(item, fit); if ($('momentContext').checked) timeline.window(...playbackBounds()); samplePreview = false; player.currentTime = playbackBounds()[0]; } syncPlayback(); handoff();
  }
  function clearChoices() { choices = []; selectedId = null; list.replaceChildren(); detail.replaceChildren(); timeline.moments([]); timeline.select(null); }
  // The decoded length can be a little shorter than the first estimate (a voice note's
  // recorder-measured time includes its start-up), so boundaries past it come back to the end.
  function fitChoicesToRecording() {
    choices.forEach(item => {
      if (!(item.end > duration + 0.001)) return;
      if (parseTimecode(item.startInput.value) >= duration) item.startInput.value = timeLabel(0);
      item.endInput.value = timeLabel(duration); item.refresh();
    });
  }
  function seedSelection() {
    if (choices.length || !duration) return;
    const trim = app.getTrim();
    list.append(card({ start: trim?.start || 0, end: trim?.end || Math.min(duration, 60), title: 'Selected Moment', reason: 'Drag the waveform edges to choose a passage, or press ANALYZE for recommendations.' }));
    selectMoment(choices[0].id);
  }
  async function openWorkspace() {
    if (!file) return;
    output.value = app.target(); handoff();
    root.hidden = false; app.workspaceOpened();
    timeline.redraw(); if (!busy) find.focus({ preventScroll: true });
    if (busy) return;
    controller = new AbortController(); const run = epoch;
    try { await readAudio(run); if (run === epoch) { seedSelection(); timeline.redraw(); say(''); } }
    catch (e) { if (run === epoch) { say(e.message, true); $('tlHint').hidden = false; $('tlHint').textContent = 'Waveform unavailable. You can still set times using the fields below.'; } }
  }
  function closeWorkspace() { if (generating) return; stop(); root.hidden = true; app.workspaceClosed(); }
  $('openMomentWorkspace').addEventListener('click', openWorkspace);
  $('closeMomentWorkspace').addEventListener('click', closeWorkspace);
  root.addEventListener('cancel', e => { if (generating) e.preventDefault(); else stop(); });
  root.addEventListener('close', () => stop());
  $('newManualMoment').addEventListener('click', () => {
    if (busy || !duration) return;
    const start = Math.min(player.currentTime || 0, Math.max(0, duration - .5));
    list.append(card({ start, end: Math.min(duration, start + 30), title: 'Custom selection', reason: 'A passage you choose from the recording.' }));
    selectMoment(choices.at(-1).id);
  });
  const format = value => { const s = Math.max(0, value); return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`; };
  const say = (message, error = false) => { status.textContent = message; status.classList.toggle('error', error); };
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const button = (text, fn) => { const b = el('button', text, 'moment-button'); b.type = 'button'; b.addEventListener('click', fn); return b; };
  const auth = () => ({ ...(app.testerPass() ? { 'x-tester-pass': app.testerPass() } : {}),
    ...(app.analysisKey() ? { 'x-moments-key': app.analysisKey() } : {}) });
  function setBusy(on) {
    busy = on; app.workspaceBusy(on); timeline.busy(on); find.disabled = on; cancel.hidden = !on || generating; $('closeMomentWorkspace').disabled = generating;
    root.setAttribute('aria-busy', String(on));
    root.querySelectorAll('[data-edit]').forEach(n => { n.disabled = on; }); handoff(); syncPlayback();
  }
  function stop() {
    playing = false; player.pause();
    if (activeCard) activeCard.querySelectorAll('.is-speaking').forEach(n => n.classList.remove('is-speaking'));
    activeCard = null; syncPlayback();
  }
  function reset(next) {
    epoch++; controller?.abort(); controller = null; stop();
    if (url) URL.revokeObjectURL(url);
    file = next; decoded = null; searchPreview = null; $('momentSearch').value = '';  words = []; segments = []; completed = new Set(); labels = {}; people = {};
    complete = false; sourceLanguage = null; language = null; transcriptPage = 0; duration = 0; url = null;
    player.removeAttribute('src'); player.load();
    clearChoices(); timeline.source(null, 0); timeline.speakers([], {}); timeline.progress(null); decoding = null; closeWorkspace(); $('momentTranscript').replaceChildren(); $('momentSpeakers').replaceChildren();
    analyzed = false; scope.value = 'selection'; analysisState('idle', 'Not analyzed');
    $('momentTranscriptWrap').hidden = true; $('momentSpeakerWrap').hidden = true;
    $('momentSpeaker').replaceChildren(new Option('Any speaker', '')); $('momentSpeakerFilter').hidden = true;
    $('momentSource').textContent = next ? next.name : '';
    $('momentSelection').hidden = true; $('momentLaunch').hidden = !next; setBusy(false);
    analysisFailed = false; find.textContent = 'ANALYZE'; say('');
    if (next) {
      url = URL.createObjectURL(next); player.src = url;
      const run = epoch;
      app.probe(next).then(d => {
        if (run !== epoch) return;
        if (d) { duration = d; timeline.source(decoded, duration); seedSelection(); return; }
        // No usable length in the file's metadata: read the audio itself, which also sets the
        // length and seeds the selection, so the clip is never left with nothing to continue.
        readAudio(run).catch(e => { if (run === epoch) say(e.message, true); });
      });
    }
  }
  function check(run) { if (run !== epoch || controller?.signal.aborted) throw new DOMException('Cancelled', 'AbortError'); }
  async function readAudio(run) {
    if (decoded) return decoded;
    if (file.size > LIMITS.bytes || duration > LIMITS.seconds) throw new Error('Find moments supports recordings up to 2 hours and 300 MB. Upload a smaller audio file or excerpt.');
    if (decoding) return decoding;
    decoding = decodeSource(run);
    try { return await decoding; } finally { if (run === epoch) decoding = null; }
  }
  async function decodeSource(run) {
    const source = file;
    say('Reading the recording…');
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
    let buffer;
    try { buffer = await ctx.decodeAudioData(await source.arrayBuffer()); }
    catch (_) { throw new Error('This browser could not read the recording. Try an MP3, WAV or M4A audio file.'); }
    finally { await ctx.close(); }
    check(run);
    if (buffer.duration > LIMITS.seconds) throw new Error('This recording is longer than 2 hours. Upload a shorter excerpt.');
    decoded = buffer; duration = buffer.duration; timeline.source(decoded, duration); seedSelection(); fitChoicesToRecording(); return buffer;
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
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]);
      let data;
      {
        const form = new FormData(); form.append('file', blob, opus ? 'section.ogg' : 'section.wav');
        form.append('model_id', app.sttModel); form.append('diarize', 'true'); form.append('tag_audio_events', 'false');
        if (sourceLanguage !== 'auto') form.append('language_code', sourceLanguage);
        const response = await fetch(app.elevenURL('speech-to-text'), { method: 'POST', headers: app.elevenHeaders(), body: form, signal });
        if (!response.ok) {
          const failure = await response.json().catch(() => ({}));
          throw new Error(typeof failure.error === 'string' ? failure.error : `Transcription paused (${response.status}). Check your connection or credits, then resume.`);
        }
        data = await response.json();
      }
      check(run);
      const fresh = normalizeWords(data.words, start, section, boundaryStart, boundaryEnd);
      words.push(...fresh); words.sort((a, b) => a.start - b.start);
      if (words.length > LIMITS.words) throw new Error('This transcript is too large. Try a shorter excerpt.');
      language ||= data.language_code; completed.add(section); timeline.progress(boundaryEnd / duration);
      $('workspaceAnalysisLabel').textContent = `Transcribed ${Math.round(boundaryEnd / duration * 100)}%`;
    }
    complete = true; choices.forEach(item => item.refresh()); segments = segmentsFromWords(words); updateSpeakers(); renderTranscript(); timeline.speakers(segments, labels);
    $('workspaceAnalysisLabel').textContent = 'Transcript ready · cached in this tab';
    if (!words.length) throw new Error('No speech was found in this recording. Try a recording with clearer speech.');
  }
  function analysisState(state, text) {
    root.querySelector('.analysis-console').dataset.state = state;
    $('workspaceAnalysisLabel').textContent = text;
    find.setAttribute('aria-pressed', String(state === 'working' || analyzed));
    root.querySelector('.analysis-help').textContent = state === 'ready' ? 'Search the transcript or tune and analyze again.' : 'Find suggested moments & unlock transcript search.';
  }
  // A transcript made for one declared spoken language is not reused for another.
  function followSpokenLanguage() {
    if (sourceLanguage && sourceLanguage !== app.sourceLanguage()) {
      words = []; completed.clear(); complete = false; language = null; segments = []; labels = {}; people = {};
      clearChoices(); timeline.speakers([], {}); $('momentTranscriptWrap').hidden = true; $('momentSpeakerWrap').hidden = true;
      $('momentSpeaker').replaceChildren(new Option('Any speaker', '')); $('momentSpeakerFilter').hidden = true;
    }
    sourceLanguage = app.sourceLanguage();
  }
  async function analyze() {
    if (!file || busy) return;
    if (app.free?.()) { app.pro('analyze'); return; } // ANALYZE is Pro
    followSpokenLanguage();
    analysisState('working', 'Analyzing…'); find.textContent = 'ANALYZING';
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
      check(run); analysisFailed = false; analyzed = true; analysisState('ready', 'Transcript analyzed'); clearChoices();
      (data.moments || []).forEach((moment, i) => list.append(card(moment, i + 1)));
      if (choices.length) selectMoment(choices[0].id); else seedSelection();
      say(data.moments?.length ? `${data.moments.length} recommended moments. Listen and check context before creating. Rankings use the transcript, not vocal delivery.` : 'No complete moments fit this brief and length. Try a wider length, any speaker, or select a passage from the transcript.');
    } catch (e) {
      if (run === epoch) { analysisFailed = true; analyzed = false; analysisState('error', e.name === 'AbortError' ? 'Analysis paused' : 'Analysis incomplete'); }
      if (run === epoch) say(e.name === 'AbortError' ? 'Stopped. Completed sections are kept in this tab. Press ANALYZE to resume.' : e.message, e.name !== 'AbortError');
    } finally {
      if (run === epoch) { setBusy(false); find.textContent = analyzed ? 'ANALYZED' : 'ANALYZE'; find.title = analyzed ? 'Analyze again with your current settings' : 'Analyze the recording'; }
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
    $('momentSpeaker').replaceChildren(new Option('Any speaker', '')); $('momentSpeakerFilter').hidden = true;
    ids.forEach(id => $('momentSpeaker').add(new Option(speakerLabel(id), id)));
    $('momentSpeakerFilter').hidden = ids.length < 2;
    if (ids.length > 1 && ids.includes(previous)) $('momentSpeaker').value = previous;
  }
  function updateSpeakers() {
    const box = $('momentSpeakers'); box.replaceChildren();
    const ids = [...new Set(words.map(w => w.speaker))].filter(id => id !== 'unknown');
    const groups = new Map();
    ids.forEach(id => {
      const key = people[id] || id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(id);
    });
    const entries = [...groups.entries()];
    const name = members => labels[members[0]]?.trim() || speakerLabel(members[0]);
    const refresh = () => { updateSpeakers(); renderTranscript(); timeline.speakers(segments, labels); };
    entries.forEach(([key, members], i) => {
      const row = el('div', null, 'person-card');
      const heading = el('div', null, 'person-heading');
      heading.append(el('strong', name(members)), el('small', `${members.length} voice ${members.length === 1 ? 'appearance' : 'appearances'}`));
      const controls = el('div', null, 'person-controls');
      const label = el('label', 'Name');
      const input = el('input'); input.id = `moment-person-${i}`; label.htmlFor = input.id;
      input.placeholder = 'Name this person'; input.maxLength = 80; input.value = labels[members[0]] || ''; input.dataset.edit = 'true';
      input.addEventListener('change', () => { members.forEach(id => { labels[id] = input.value.trim(); }); refresh(); });
      const field = el('div'); field.append(label, input); controls.append(field);
      if (entries.length > 1) {
        const mergeField = el('div'), mergeLabel = el('label', 'Same person as…'), select = el('select');
        select.id = `moment-person-merge-${i}`; mergeLabel.htmlFor = select.id;
        select.add(new Option('Choose a person', ''));
        entries.filter(([other]) => other !== key).forEach(([other, voices]) => select.add(new Option(name(voices), other)));
        select.addEventListener('change', () => {
          const target = groups.get(select.value); if (!target) return;
          const mergedName = labels[target[0]]?.trim() || labels[members[0]]?.trim() || '';
          [...target, ...members].forEach(id => { people[id] = select.value; labels[id] = mergedName; });
          refresh();
        });
        mergeField.append(mergeLabel, select); controls.append(mergeField);
      }
      row.append(heading, controls);
      const samples = el('div', null, 'person-samples');
      members.forEach(id => {
        const sample = segments.filter(s => s.speaker === id).sort((a,b) => (b.end-b.start)-(a.end-a.start))[0];
        const first = words.find(w => w.speaker === id);
        const start = sample?.start ?? first.start, end = Math.min(duration, sample?.end ?? first.end, start + 8);
        const line = el('div', null, 'person-sample');
        line.append(button(`▶ Hear voice · ${timeLabel(start)}`, () => preview(start, end)));
        if (members.length > 1) line.append(button('Separate', () => {
          const rest = members.filter(member => member !== id), nextKey = rest[0];
          rest.forEach(member => { people[member] = nextKey; });
          delete people[id]; delete labels[id]; refresh();
        }));
        samples.append(line);
      });
      if (members.length > 1) {
        const details = el('details'); details.append(el('summary', 'Listen to linked appearances · separate a mistaken match'), samples); row.append(details);
      } else row.append(samples);
      box.append(row);
    });
    $('momentSpeakerWrap').hidden = !box.children.length; updateSpeakerOptions();
  }
  function playbackBounds() {
    const item = choices.find(m => m.id === selectedId);
    if (!item) return [0, 0];
    const pad = $('momentContext').checked ? 10 : 0;
    return [Math.max(0,item.start-pad), Math.min(duration,item.end+pad)];
  }
  function syncPlayback() {
    const item = choices.find(m => m.id === selectedId);
    const [a,b] = samplePreview ? [previewStart,stopAt] : playbackBounds();
    const t = Math.max(a,Math.min(b,player.currentTime || a));
    const action = playing ? 'Pause' : t >= b && b > a ? 'Replay' : 'Play';
    const icons = { Play: '<path d="M7 4.8C7 3.6 8.3 2.9 9.3 3.6l11 7c1 .6 1 2.2 0 2.8l-11 7C8.3 21.1 7 20.4 7 19.2z" fill="currentColor"/>', Pause: '<path d="M7 5h4v14H7zM14 5h4v14h-4z" fill="currentColor"/>', Replay: '<path d="M4 10a8 8 0 1 1 1 8M4 4v6h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' };
    root.querySelectorAll('#momentPlayToggle, .moment-card-play').forEach(control => {
      control.disabled = !item || generating; control.title = action; control.setAttribute('aria-label', action + ' preview');
      if (control.dataset.action !== action) { control.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">' + icons[action] + '</svg>'; control.dataset.action = action; }
    });
    root.querySelectorAll('.moment-card-clock').forEach(n => { n.querySelector('.clock-current').textContent = timeLabel(t-a); n.querySelector('.clock-total').textContent = timeLabel(b-a); });
    root.querySelectorAll('.moment-card-seek').forEach(n => { n.value = b > a ? (t-a)/(b-a)*1000 : 0; n.style.setProperty('--played', `${n.value / 10}%`); n.disabled = !item || generating; n.setAttribute('aria-valuetext', `${timeLabel(t-a)} of ${timeLabel(b-a)}`); });
    root.querySelectorAll('.moment-card-preview-note').forEach(n => n.textContent = samplePreview ? (searchPreview ? 'Search preview · not added to moments' : 'Speaker sample') : $('momentContext').checked ? 'Preview includes surrounding audio' : 'Listen to this moment');
    root.querySelectorAll('[data-transport],[data-mark]').forEach(control => { control.disabled = !item || generating; });
    $('momentPlaybackTime').querySelector('.clock-current').textContent = timeLabel(t-a);
    $('momentPlaybackTime').querySelector('.clock-total').textContent = timeLabel(b-a);
    $('transportState').textContent = playing ? 'PLAYING' : t >= b && b > a ? 'END' : 'READY';
    $('transportState').classList.toggle('is-playing', playing);
    $('momentPlaybackNote').textContent = samplePreview ? (searchPreview ? 'Search preview · not added to moments' : 'Speaker sample') : $('momentContext').checked ? 'Preview up to 10 seconds before and after your clip. Export includes only your selection.' : 'Preview selected clip';
    root.querySelectorAll('[data-search-preview]').forEach(control => {
      const active = playing && samplePreview && searchPreview?.id === Number(control.dataset.searchPreview);
      control.textContent = active ? 'Pause preview' : 'Preview';
      control.setAttribute('aria-pressed', String(active));
    });
    const caption = root.querySelector('.playback-clock .display-caption');
    if (caption) caption.textContent = samplePreview && searchPreview ? 'SEARCH PREVIEW' : 'PLAYBACK';
    if (item) $('momentTransport').style.setProperty('--moment-color',item.color);
  }
  function preview(start, end, cardElement = null, searchResult = null) {
    if (!validRange(start, end, duration)) return;
    stop(); app.pause(); searchPreview = searchResult; samplePreview = !cardElement; previewStart = start; activeCard = cardElement; stopAt = end; playing = true;
    player.currentTime = start; syncPlayback();
    player.play().catch(() => { stop(); say('Playback was blocked. Try Play again.',true); });
  }
  function togglePlayback() {
    if (generating) return;
    if (playing) { stop(); return; }
    const item = choices.find(m => m.id === selectedId); if (!item) return;
    const [a,b] = samplePreview ? [previewStart,stopAt] : playbackBounds();
    const t = player.currentTime >= a && player.currentTime < b ? player.currentTime : a;
    const sample = samplePreview;
    preview(t,b,sample ? null : item.article, searchPreview); previewStart = a; syncPlayback();
  }
  $('momentPlayToggle').addEventListener('click', togglePlayback);
  // Moves the playhead to the selection's start or end, or back or forward by `step` seconds (the
  // keys use 15; the arrow keys 1). Playback that was running carries on from the new point.
  function transport(action, step = 15) {
    const item = choices.find(m => m.id === selectedId);
    if (!item || generating) return;
    const resume = playing;
    const current = player.currentTime;
    stop(); samplePreview = false;
    const [a,b] = playbackBounds();
    const target = action === 'start' ? item.start : action === 'end' ? item.end : current + (action === 'back' ? -step : step);
    const t = Math.max(a, Math.min(b, target));
    player.currentTime = t; timeline.playhead(t);
    if (resume && action !== 'end' && t < b) { preview(t,b,item.article); previewStart = a; }
    syncPlayback();
  }
  root.querySelectorAll('[data-transport]').forEach(control => control.addEventListener('click', () => transport(control.dataset.transport)));
  // Mark in / mark out: set a selection edge to the playhead, as the IN and OUT keys on a recorder
  // do. Marking the start mid-playback keeps playing, so a passage can be marked in one listen;
  // marking the end is where that listen stops. An edge that would cross the other keeps the
  // selection's length rather than collapsing it.
  function mark(edge) {
    const item = choices.find(m => m.id === selectedId);
    if (!item || generating || busy) return;
    const resume = playing && edge === 'in', t = player.currentTime;
    const keep = Math.max(0.3, item.end - item.start);
    let a = item.start, b = item.end;
    if (edge === 'in') { a = t; if (b - a < 0.3) b = Math.min(duration, a + keep); }
    else { b = t; if (b - a < 0.3) a = Math.max(0, b - keep); }
    item.startInput.value = timeLabel(a); item.endInput.value = timeLabel(b); item.refresh();
    if (resume) { const [lo, hi] = playbackBounds(); if (t < hi) { preview(t, hi, item.article); previewStart = lo; } }
    syncPlayback();
  }
  root.querySelectorAll('[data-mark]').forEach(control => control.addEventListener('click', () => mark(control.dataset.mark)));
  function stepMoment(dir) {
    if (!choices.length || generating) return;
    const i = choices.findIndex(m => m.id === selectedId);
    const next = choices[Math.max(0, Math.min(choices.length - 1, i < 0 ? 0 : i + dir))];
    if (next && next.id !== selectedId) { selectMoment(next.id); next.tab?.scrollIntoView?.({ block: 'nearest' }); }
  }
  segText(root);
  const help = $('shortcutHelp');
  function toggleHelp(show = help.hidden) {
    help.hidden = !show;
    if (show) $('shortcutClose').focus({ preventScroll: true }); else if (help.contains(document.activeElement)) $('shortcutOpen').focus({ preventScroll: true });
  }
  $('shortcutOpen').addEventListener('click', () => toggleHelp(true));
  $('shortcutClose').addEventListener('click', () => toggleHelp(false));

  // Keyboard shortcuts while the clip screen is open. They stand down while you type in a field,
  // choose from a list, or use another dialog. Space plays and pauses even when a button still has
  // focus from a click, so it never re-presses that button (Enter still does). No key spends
  // credits: captioning and dubbing stay behind their button.
  const typing = el => !!el && (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) || el.isContentEditable);
  const otherDialogOpen = () => !!document.querySelector('.modal.open, .splash.open, dialog[open]');
  let spaceTaken = false;
  document.addEventListener('keydown', e => {
    if (root.hidden || e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || otherDialogOpen()) return;
    const k = e.key, once = !e.repeat;
    if (k === ' ' || e.code === 'Space') { spaceTaken = true; if (once) togglePlayback(); }
    else if (k === 'i' || k === 'I' || k === '[') { if (once) mark('in'); }
    else if (k === 'o' || k === 'O' || k === ']') { if (once) mark('out'); }
    else if (k === 'Home') transport('start');
    else if (k === 'End') transport('end');
    else if (k === 'ArrowLeft' || k === 'ArrowRight') transport(k === 'ArrowLeft' ? 'back' : 'forward', e.shiftKey ? 15 : 1);
    else if (k === 'ArrowUp' || k === 'ArrowDown') stepMoment(k === 'ArrowUp' ? -1 : 1);
    else if (k === '=' || k === '+' || k === '-' || k === '_') { const z = $(k === '=' || k === '+' ? 'tlZoomIn' : 'tlZoomOut'); if (z && !z.disabled) z.click(); }
    else if (k === '?' || (k === '/' && e.shiftKey)) { if (once) toggleHelp(); }
    else if (k === 'Escape' && !help.hidden) { toggleHelp(false); e.stopPropagation(); }
    else return;
    e.preventDefault();
  });
  // A focused button activates on Space's keyup; when Space was play/pause, that press is ours.
  document.addEventListener('keyup', e => { if (spaceTaken && (e.key === ' ' || e.code === 'Space')) { spaceTaken = false; e.preventDefault(); } });
  $('momentContext').addEventListener('change', () => {
    stop(); samplePreview = false; const [a,b] = playbackBounds(); player.currentTime = a;
    timeline.window(a,b); syncPlayback();
  });
  player.addEventListener('timeupdate', () => {
    if (playing && player.currentTime >= stopAt) { player.currentTime = stopAt; stop(); }
    timeline.playhead(player.currentTime); syncPlayback();
    if (activeCard) activeCard.querySelectorAll('[data-word-start]').forEach(n =>
      n.classList.toggle('is-speaking', player.currentTime >= Number(n.dataset.wordStart) && player.currentTime < Number(n.dataset.wordEnd)));
  });
  player.addEventListener('ended', stop);
  let meterFrame = 0, lastMeterFrame = 0;
  function stopMeter() { cancelAnimationFrame(meterFrame); meterFrame = 0; timeline.levels(player.currentTime, false); }
  function animatePlayback(now) {
    if (!playing || player.paused || player.ended) { stopMeter(); return; }
    if (player.currentTime >= stopAt) { player.currentTime = stopAt; stop(); return; }
    if (now - lastMeterFrame >= 50) {
      timeline.levels(player.currentTime, true); timeline.playhead(player.currentTime); lastMeterFrame = now;
    }
    meterFrame = requestAnimationFrame(animatePlayback);
  }
  player.addEventListener('playing', () => { stopMeter(); meterFrame = requestAnimationFrame(animatePlayback); });
  for (const event of ['pause','ended','waiting','emptied']) player.addEventListener(event, stopMeter);

  function textFor(start, end, target) {
    target.replaceChildren();
    words.filter(w => w.end > start && w.start < end).forEach(w => {
      const span = el('span', w.text + ' '); span.dataset.wordStart = w.start; span.dataset.wordEnd = w.end; target.append(span);
    });
  }
  function card(moment, rank) {
    const color = MOMENT_COLORS[(choices.length) % MOMENT_COLORS.length];
    const number = Math.max(0, ...choices.map(item => item.number || 0)) + 1;
    const item = { ...moment, id: nextId++, color, number, recommended: !!rank };
    const numberLabel = String(number).padStart(2, '0');
    const article = el('article', null, 'moment-card'); article.hidden = true; article.style.setProperty('--moment-color', color);
    const tab = button('', () => selectMoment(item.id)); tab.className = 'moment-choice'; tab.style.setProperty('--moment-color', color); tab.dataset.edit = 'true';
    const tabNo = el('span', numberLabel, 'moment-choice-no');
    const tabBody = el('span', null, 'moment-choice-body'); const tabTitle = el('strong', moment.title); const tabMeta = el('small');
    tabBody.append(tabTitle, tabMeta); tab.append(tabNo, tabBody); tab.setAttribute('aria-pressed', 'false');
    article.append(el('div', `MOMENT ${numberLabel} · SELECTED`, 'moment-eyebrow'));
    const heading = el('h3');
    const titleButton = button(item.title, () => beginRename());
    titleButton.className = 'moment-title-button'; titleButton.dataset.edit = 'true';
    titleButton.title = 'Rename moment'; titleButton.setAttribute('aria-label', `Rename moment: ${item.title}`);
    const titleInput = el('input'); titleInput.type = 'text'; titleInput.maxLength = 160;
    titleInput.className = 'moment-title-input'; titleInput.hidden = true; titleInput.dataset.edit = 'true';
    titleInput.setAttribute('aria-label', 'Moment title');
    titleInput.title = 'Enter to save · Escape to cancel';
    const renameActions = el('div', null, 'moment-rename-actions'); renameActions.hidden = true;
    const saveTitle = button('Save', () => finishRename(true, true));
    const cancelTitle = button('Cancel', () => finishRename(false, true));
    saveTitle.dataset.edit = 'true'; cancelTitle.dataset.edit = 'true';
    renameActions.append(saveTitle, cancelTitle);
    let renaming = false;
    function beginRename() {
      if (busy) return;
      renaming = true; titleInput.value = item.title; titleButton.hidden = true; titleInput.hidden = false; renameActions.hidden = false;
      titleInput.focus(); titleInput.select();
    }
    function finishRename(save, refocus = false) {
      if (!renaming) return;
      renaming = false;
      const value = titleInput.value.trim();
      if (save && value) {
        item.title = value; tabTitle.textContent = value; titleButton.textContent = value;
        titleButton.setAttribute('aria-label', `Rename moment: ${value}`);
        timeline.moments(choices); handoff();
      }
      titleInput.hidden = true; titleButton.hidden = false; renameActions.hidden = true;
      if (refocus) titleButton.focus({ preventScroll: true });
    }
    // Explicit Save/Cancel prevents a mobile blur from saving before Cancel is tapped.
    titleInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation(); finishRename(e.key === 'Enter', true);
      }
    });
    heading.append(titleButton, titleInput); article.append(heading, renameActions);
    const cardPlayer = el('div', null, 'moment-card-player');
    cardPlayer.innerHTML = '<div class="moment-card-transport"><button type="button" class="moment-card-play" aria-label="Play preview"></button><div class="moment-card-player-body"><div class="moment-card-player-meta"><span class="moment-card-preview-note">Listen to this moment</span><span class="moment-card-clock" aria-label="Playback elapsed and total time"><span class="clock-current" data-seg="text"></span><span class="clock-divider">/</span><span class="clock-total" data-seg="text"></span></span></div><input type="range" class="moment-card-seek" min="0" max="1000" step="1" value="0" aria-label="Seek preview" /></div></div>';
    cardPlayer.querySelector('button').addEventListener('click', togglePlayback);
    cardPlayer.querySelector('input').addEventListener('input', e => {
      if (generating) return;
      const [a,b] = samplePreview ? [previewStart,stopAt] : playbackBounds();
      player.currentTime = a+(b-a)*Number(e.target.value)/1000; timeline.playhead(player.currentTime); syncPlayback();
    });
    article.append(cardPlayer);
    const meta = el('p', '', 'moment-meta'), quote = el('p', '', 'moment-quote');
    const range = el('div', null, 'moment-range moment-card-readouts');
    range.setAttribute('role','group'); range.setAttribute('aria-label','Adjust this moment');
    const start = el('input'), end = el('input');
    // Start and end read as timecode, like the strip above; duration as 25.3 s or 1 m 25 s.
    const asTimeField = (node, label) => { node.type = 'text'; node.inputMode = 'decimal'; node.autocomplete = 'off'; node.spellcheck = false; node.dataset.edit = 'true'; node.setAttribute('aria-label', label); };
    for (const [node, value, name] of [[start, moment.start, 'Start'], [end, moment.end, 'End']]) {
      asTimeField(node, `${name} time`); node.value = timeLabel(value); node.title = 'Type a time like 1:23.4, or seconds.';
      node.addEventListener('input', () => node.setCustomValidity(''));
      const label = el('label'); label.append(el('span', name, 'trim-field-title'), node); range.append(label); segField(node);
    }
    const length = el('input'); asTimeField(length, 'Moment duration in seconds'); length.title = 'Type seconds, 1:25 or 1m 25s.';
    const lengthFace = el('span', null, 'readout-face'); lengthFace.setAttribute('aria-hidden', 'true');
    const lengthField = el('span', null, 'readout-field'); lengthField.append(length, lengthFace);
    const lengthLabel = el('label', null, 'moment-card-duration'); lengthLabel.append(el('span','Duration','trim-field-title'), lengthField); range.append(lengthLabel);
    cardPlayer.append(range);
    const refresh = (fromTimeline = false) => {
      stop(); const [a, b] = withinRecording(parseTimecode(start.value), parseTimecode(end.value));
      if (!start.value || !end.value || !validRange(a, b, duration)) {
        say('Start must be before end, within the recording. Type a time like 1:23.4, or seconds.', true);
        start.value = timeLabel(item.start ?? 0); end.value = timeLabel(item.end ?? duration); return;
      }
      start.value = timeLabel(a); end.value = timeLabel(b);
      if (selectedId === item.id && (a !== item.start || b !== item.end)) scope.value = 'selection';
      item.start = a; item.end = b; length.value = (b-a).toFixed(1); renderDurationFace(lengthFace, b - a);
      meta.textContent = `${timeLabel(a)} – ${timeLabel(b)} · ${(b - a).toFixed(1)} seconds`;
      tabMeta.textContent = `${timeLabel(a)} — ${timeLabel(b)}`;
      textFor(a, b, quote);
      if (!complete) quote.textContent = 'Preview the original audio now. Press ANALYZE to add transcript search and suggested moments.';
      if (!fromTimeline && selectedId === item.id) timeline.range(a, b);
      timeline.moments(choices); syncPlayback(); handoff();
    };
    start.addEventListener('change', () => refresh()); end.addEventListener('change', () => refresh());
    length.addEventListener('change', () => {
      if (busy) return;
      const next = rangeForDuration(item.start, parseDuration(length.value), duration);
      if (!next) { say('Type a length like 25.5, 1:25 or 1m 25s.', true); length.value = (item.end - item.start).toFixed(1); return; }
      start.value = timeLabel(next[0]); end.value = timeLabel(next[1]); refresh();
    });
    for (const field of [start,end,length]) field.addEventListener('keydown', e => { if(e.key === 'Enter') { e.preventDefault(); field.blur(); } });
    item.startInput = start; item.endInput = end; item.refresh = refresh; item.article = article; item.tab = tab;
    choices.push(item); refresh();
    article.append(el('p', moment.reason, 'moment-reason'));
    if (moment.context) article.append(el('p', 'Context: ' + moment.context, 'moment-context'));
    article.append(quote);
    detail.append(article); timeline.moments(choices); return tab;
  }
  function renderTranscript() {
    $('momentTranscriptWrap').hidden = !segments.length;
    const box = $('momentTranscript'); box.replaceChildren();
    const query = $('momentSearch').value.trim();
    const filtered = transcriptPassages(segments, words, query, duration);
    $('momentSearchCount').textContent = query ? `${filtered.length} matching passage${filtered.length === 1 ? '' : 's'} for “${query}”` : `${filtered.length} transcript passages. Search a topic or name to narrow them down.`;
    const shown = filtered.slice(0, (transcriptPage + 1) * 20);
    shown.forEach(s => {
      const row = el('article', null, 'moment-transcript-row');
      row.append(el('small', `${format(s.start)} – ${format(s.end)} · ${(s.end-s.start).toFixed(1)}s · ${speakerLabel(s.speaker)}`));
      const excerpt = el('p');
      const passageWords = words.filter(w => w.end > s.start && w.start < s.end);
      const text = passageWords.length ? passageWords.map(w => w.text).join(' ') : s.text;
      let cursor = 0, at;
      if (query) while ((at = text.toLowerCase().indexOf(query.toLowerCase(), cursor)) !== -1) {
        excerpt.append(document.createTextNode(text.slice(cursor, at)), el('mark', text.slice(at, at + query.length))); cursor = at + query.length;
      }
      excerpt.append(document.createTextNode(text.slice(cursor))); row.append(excerpt);
      const actions = el('div', null, 'transcript-result-actions');
      const hear = button('Preview', () => {
        if (busy) return;
        if (playing && samplePreview && searchPreview?.id === s.id) { stop(); return; }
        timeline.window(s.start, s.end); preview(s.start, s.end, null, s); timeline.playhead(s.start);
      });
      hear.dataset.searchPreview = String(s.id); hear.dataset.edit = 'true'; hear.disabled = busy;
      const saved = choices.find(item => item.transcriptSegmentId === s.id);
      const add = button(saved ? 'Load moment' : 'Add to moments', () => {
        if (busy) return;
        stop(); app.pause();
        let existing = choices.find(item => item.transcriptSegmentId === s.id);
        if (!existing) {
          const title = query ? `${query} · ${format(s.start)}` : s.text.slice(0, 70);
          list.append(card({start:s.start, end:s.end, title, transcriptSegmentId:s.id, reason:'Selected from transcript search. Adjust the edges in the waveform.'}));
          existing = choices.at(-1);
        }
        selectMoment(existing.id); renderTranscript();
        $('momentSearchFeedback').textContent = `Loaded “${existing.title}” in moments. Press Play to preview, or adjust Start, End, and Duration.`;
        const transport = $('momentTransport'); transport.scrollIntoView({block:'center',behavior:'auto'}); $('momentPlayToggle').focus({preventScroll:true});
      });
      add.dataset.edit = 'true'; add.disabled = busy; add.classList.add('moment-primary');
      actions.append(hear, add); if (saved) actions.append(el('span','In moments','transcript-saved'));
      row.append(actions); box.append(row);
    });
    if (shown.length < filtered.length) box.append(button('Show more passages', () => { transcriptPage++; renderTranscript(); }));
    if (!filtered.length) box.append(el('p', 'No passages found. Try a shorter phrase or another spelling.'));
    syncPlayback();
  }
  $('momentSearch').addEventListener('input', () => {
    if (searchPreview) { stop(); searchPreview = null; samplePreview = false; }
    transcriptPage = 0; $('momentSearchFeedback').textContent = ''; renderTranscript();
  });
  $('manualMomentAdd').addEventListener('click', () => {
    const a = Number($('manualMomentStart').value), b = Number($('manualMomentEnd').value);
    if (!$('manualMomentStart').value || !$('manualMomentEnd').value || !validRange(a, b, duration) || b - a > 90) { say('Select a passage between 0.25 and 90 seconds within the recording.', true); return; }
    const selected = card({ start: a, end: b, title: 'Your selected passage', reason: 'A passage you selected from the original recording.' });
    list.append(selected); selectMoment(choices.at(-1).id);
  });
  find.addEventListener('click', analyze);
  cancel.addEventListener('click', () => controller?.abort());
  $('momentSpeaker').addEventListener('change', () => say('Speaker preference updated. Find more moments to apply it.'));
  return {
    reset, open: openWorkspace, close: closeWorkspace,
    // The full transcript in recording time, transcribing first if needed. Free sessions caption
    // through this, so a recording is only ever transcribed once, in sections.
    async transcript(source) {
      if (source !== file) throw new Error('The recording changed. Choose it again, then caption.');
      if (!complete) {
        followSpokenLanguage();
        if (!controller || controller.signal.aborted) controller = new AbortController();
        await transcribe(epoch);
      }
      return { words: words.map(w => ({ type: 'word', text: w.text, start: w.start, end: w.end, speaker_id: w.speaker })), language_code: language };
    },
    cachedTranscript(source, start, end, spoken) {
      if (source !== file || !complete || spoken !== sourceLanguage || !validRange(start, end, duration)) return null;
      return { words: clipWords(words, start, end).map(w => ({ ...w, type: 'word' })), language_code: language };
    }
  };
}
