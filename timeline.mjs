import { parseTimecode, parseDuration, durationParts } from './moments-core.mjs';
export const MOMENT_COLORS = ['#DDA84B', '#91BDD9', '#91BFAE', '#D7C8A5', '#BAC5CC'];
// Segment ghosting: a lit readout shows its unlit segments faintly behind it, an 8 under every
// digit, like the LCD on a hardware device. Text readouts carry data-seg="text" and follow their text
// through one observer; editable fields get a ghost layer that follows every value, typed or set.
export const ghostOf = text => String(text ?? '').replace(/[0-9]/g, '8');
export function segField(input) {
  if (!input || input.dataset.seg) return;
  const inputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  input.dataset.seg = 'field';
  const ghost = document.createElement('span'); ghost.className = 'seg-ghost'; ghost.setAttribute('aria-hidden', 'true');
  input.before(ghost);
  const sync = () => { ghost.textContent = ghostOf(inputValue.get.call(input)); };
  Object.defineProperty(input, 'value', { configurable: true, get() { return inputValue.get.call(this); }, set(v) { inputValue.set.call(this, v); sync(); } });
  input.addEventListener('input', sync); sync();
}
export function segText(scope) {
  const update = el => { el.dataset.ghost = ghostOf(el.textContent); };
  scope.querySelectorAll('[data-seg=text]').forEach(update);
  new MutationObserver(records => {
    for (const r of records) {
      const host = (r.target.nodeType === 3 ? r.target.parentElement : r.target);
      const seg = host?.closest?.('[data-seg=text]'); if (seg) update(seg);
      r.addedNodes.forEach(n => { if (n.nodeType !== 1) return; if (n.matches('[data-seg=text]')) update(n); n.querySelectorAll?.('[data-seg=text]').forEach(update); });
    }
  }).observe(scope, { subtree: true, childList: true, characterData: true });
}
// A duration readout drawn beside its field: segment digits with small unit letters (25.3 s,
// 1 m 25 s). The field itself holds plain seconds for editing and takes over while focused.
export function renderDurationFace(face, seconds) {
  face.replaceChildren(...durationParts(seconds).flatMap(([value, unit]) => {
    const v = document.createElement('b'), u = document.createElement('i'); v.textContent = value; v.dataset.ghost = ghostOf(value); u.textContent = unit; return [v, u];
  }));
}
export function timeLabel(t) {
  const tenths = Math.max(0, Math.round(t * 10));
  return `${Math.floor(tenths / 600)}:${String(Math.floor(tenths / 10) % 60).padStart(2, '0')}.${tenths % 10}`;
}
export function boundedRange(start, end, duration, edge) {
  const gap = Math.min(.3, duration);
  if (edge === 'start') return [Math.max(0, Math.min(start, end - gap)), Math.min(duration, end)];
  return [Math.max(0, start), Math.min(duration, Math.max(end, start + gap))];
}
export function rangeForDuration(start, length, duration) {
  if (![start, length, duration].every(Number.isFinite) || duration <= 0) return null;
  const width = Math.max(Math.min(.3, duration), Math.min(length, duration));
  const a = Math.max(0, Math.min(start, duration - width));
  return [a, Math.min(duration, a + width)];
}
export function fitRange(start, end, duration) {
  const pad = Math.max(2, (end - start) * .18);
  return [Math.max(0, start - pad), Math.min(duration, end + pad)];
}
export function adjustView(original, mode, delta, duration) {
  const gap = Math.min(1, duration);
  if (mode === 'start') return [Math.max(0, Math.min(original[1]-gap, original[0]+delta)), original[1]];
  if (mode === 'end') return [original[0], Math.min(duration, Math.max(original[0]+gap, original[1]+delta))];
  const width = original[1]-original[0];
  const start = Math.max(0,Math.min(duration-width,original[0]+delta));
  return [start,start+width];
}
// Expand only the dragged side, gradually revealing more recording at an edge.
export function expandTrimView(view, edge, fraction, duration, seconds, zone = .05) {
  const width = view[1] - view[0];
  if (width <= 0 || duration <= 0 || seconds <= 0) return [...view];
  const pressure = Math.max(0, Math.min(1, edge === 'end' ? (fraction - (1-zone))/zone : (zone-fraction)/zone));
  const growth = Math.max(2, width) * Math.expm1(.65 * pressure * Math.min(.1, seconds));
  return edge === 'end' ? [view[0], Math.min(duration, view[1]+growth)] : [Math.max(0, view[0]-growth), view[1]];
}
export function magnifiedRange(duration, zoom, center) {
  if (duration <= 0) return [0,0];
  const width = duration / Math.max(1, Math.min(duration / Math.min(2,duration), zoom));
  const start = Math.max(0, Math.min(duration-width, center-width/2));
  return [start,start+width];
}
export function regionLanes(moments) {
  const ends = [], lanes = new Map();
  [...moments].sort((a, b) => a.start - b.start).forEach(m => {
    let lane = ends.findIndex(end => end <= m.start);
    if (lane < 0) lane = ends.length;
    ends[lane] = m.end; lanes.set(m.id, lane);
  });
  return lanes;
}
export function peaks(data, start, end, rate, count) {
  const out = new Float32Array(count), width = Math.max(1, (end - start) * rate / count);
  for (let i = 0; i < count; i++) {
    const a = Math.floor(start * rate + i * width), b = Math.min(data.length, Math.ceil(a + width));
    const stride = Math.max(1, Math.floor((b - a) / 150));
    let peak = 0;
    for (let j = a; j < b; j += stride) peak = Math.max(peak, Math.abs(data[j] || 0));
    out[i] = peak;
  }
  return out;
}

export function sourceLevel(data, rate, time) {
  const start = Math.max(0, Math.floor(time * rate));
  const end = Math.min(data.length, start + Math.ceil(rate * .03));
  if (end <= start) return -60;
  let sum = 0;
  for (let i = start; i < end; i++) sum += data[i] * data[i];
  return Math.max(-60, Math.min(0, 20 * Math.log10(Math.sqrt(sum / (end - start)) || 1e-3)));
}
export function createTimeline(root, events) {
  // The four readouts share one size. When the longest value (a late timecode like 101:42.3 in a
  // long recording) would overflow its cell, all four shrink together just enough to fit.
  function fitReadout() {
    const strip = root.querySelector('.moment-transport'); if (!strip) return;
    strip.style.removeProperty('--digit-fit');
    let fit = 1;
    for (const sel of ['#momentPlaybackTime', '#waveformStart', '#waveformEnd', '#waveformDurationFace']) {
      const el = root.querySelector(sel);
      if (el && el.offsetParent && el.clientWidth && el.scrollWidth > el.clientWidth + 0.5) fit = Math.min(fit, el.clientWidth / el.scrollWidth);
    }
    if (fit < 1) strip.style.setProperty('--digit-fit', String(Math.floor(fit * 1000) / 1000));
  }
  addEventListener('resize', () => requestAnimationFrame(fitReadout));
  document.fonts?.ready.then(fitReadout);
  let audio = null, duration = 0, moments = [], selected = null, view = [0, 0], turns = [], labels = {};
  let busy = false, playhead = 0, gesture = null;
  let trimFrame = 0, trimX = 0, trimOriginX = 0, trimMoved = false, trimStamp = 0;
  function endTrimGesture() { gesture = null; cancelAnimationFrame(trimFrame); trimFrame = 0; trimMoved = false; }
  function dragTrimAtPointer() {
    if (!gesture || busy || !selected) return;
    const r = detail.getBoundingClientRect();
    if (!r.width) return;
    const fraction = Math.max(0, Math.min(1, (trimX-r.left)/r.width));
    change(gesture, view[0] + fraction * (view[1]-view[0]));
  }
  function autoExpandTrim(now) {
    if (!gesture || busy || !selected || !root.getClientRects().length) { endTrimGesture(); return; }
    if (now - trimStamp >= 32) {
      const elapsed = (now-trimStamp)/1000; trimStamp = now;
      const r = detail.getBoundingClientRect();
      if (trimMoved && r.width) {
        const fraction = (trimX-r.left)/r.width;
        const zone = Math.min(.12, 32/r.width);
        const next = expandTrimView(view,gesture,fraction,duration,elapsed,zone);
        if (next[0] !== view[0] || next[1] !== view[1]) {
          view = next; dragTrimAtPointer(); render();
        }
      }
    }
    trimFrame = requestAnimationFrame(autoExpandTrim);
  }
  root.innerHTML = `
    <div class="tl-heading"><span>RECORDING OVERVIEW</span><span id="tlDuration" data-seg="text">—</span></div>
    <div class="tl-overview" id="tlOverview"><canvas aria-label="Full recording waveform"></canvas><div class="tl-view-window" aria-hidden="true"></div><div class="tl-analysis-progress" hidden></div></div>
    <div class="tl-regions" aria-label="Recommended moments on the recording"></div>
    <div class="tl-axis tl-overview-axis"></div>
    <div class="tl-detail-heading"><div><span class="tl-dot"></span><strong id="tlSelectedName">Selected Moment</strong></div><div class="tl-magnification"><span>Zoom</span><button type="button" id="tlZoomOut" aria-label="Zoom out" title="Zoom out (−)" aria-keyshortcuts="-">−</button><input type="range" id="tlZoom" min="0" max="100" step="1" value="0" aria-label="Waveform magnification" /><button type="button" id="tlZoomIn" aria-label="Zoom in" title="Zoom in (=)" aria-keyshortcuts="=">+</button><output id="tlZoomValue">1×</output></div></div>
    <div class="tl-detail" id="tlDetail">
      <canvas aria-label="Zoomed waveform for precise trimming"></canvas>
      <div class="tl-selection" aria-hidden="true"></div>
      <button type="button" class="tl-handle tl-start" role="slider" aria-label="Selection start" aria-orientation="horizontal"></button>
      <button type="button" class="tl-handle tl-end" role="slider" aria-label="Selection end" aria-orientation="horizontal"></button>
      <div class="tl-playhead" aria-hidden="true"></div><span class="tl-loading">Reading waveform…</span>
    </div>
    <div class="tl-axis tl-detail-axis"></div>
    <div class="tl-speakers" aria-label="Speaker turns"></div>
    <p id="tlHint" class="tl-wave-error" role="status" hidden></p>
        <div class="moment-transport" id="momentTransport">
          <div class="transport-display"><div class="playback-clock"><div class="clock-head"><span class="display-caption">PLAYBACK</span></div><span id="momentPlaybackTime" aria-label="Playback elapsed and total time"><span class="clock-current" data-seg="text">0:00.0</span><span class="clock-divider">/</span><span class="clock-total">0:00.0</span></span></div><div class="source-meter" title="Source level at the playback position"><span class="display-caption" id="meterCaption">SOURCE LEVEL</span><div class="meter-channel"><span id="meterLeftLabel">L</span><meter id="meterLeft" min="-60" max="0" value="-60" aria-label="Left source level in decibels"></meter></div><div class="meter-channel" id="meterRightRow"><span>R</span><meter id="meterRight" min="-60" max="0" value="-60" aria-label="Right source level in decibels"></meter></div></div></div>
          <div class="meter-window" title="Output level">
            <span class="transport-state" id="transportState">READY</span>
            <div class="led-meters" aria-hidden="true"><span class="led-bar" data-channel="0"></span><span class="led-bar" data-channel="1"></span></div>
            <div class="led-labels" aria-hidden="true"><span>L</span><span>R</span></div>
          </div>
          <div class="waveform-trim-fields" role="group" aria-label="Adjust selected clip">
            <label for="waveformStart"><span class="trim-field-title">Start</span><input id="waveformStart" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" data-edit aria-label="Selection start time" title="Type a time like 1:23.4, or seconds. Arrow keys nudge it." /></label>
            <label for="waveformEnd"><span class="trim-field-title">End</span><input id="waveformEnd" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" data-edit aria-label="Selection end time" title="Type a time like 1:23.4, or seconds. Arrow keys nudge it." /></label>
            <label id="tlSelectedLength" for="waveformDuration"><span class="trim-field-title">Duration</span><span class="readout-field"><input id="waveformDuration" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" data-edit aria-label="Selection duration in seconds" title="Type seconds, 1:25 or 1m 25s; keeps the start unless the recording ends" disabled /><span class="readout-face" id="waveformDurationFace" aria-hidden="true"></span></span></label>
          </div>
        </div>
        <div class="transport-console"><div class="transport-keys" role="group" aria-label="Playback controls">
          <button type="button" class="transport-key transport-mark" data-mark="in" aria-label="Mark in: set the start to the playhead" title="Mark in (I or [)" aria-keyshortcuts="I [" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4H6v16h5"/></svg><span>IN</span></button>
          <button type="button" class="transport-key" data-transport="start" aria-label="Go to beginning of clip" title="Beginning of clip (Home)" aria-keyshortcuts="Home" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5v14M19 5L8 12l11 7z"/></svg></button>
          <button type="button" class="transport-key" data-transport="back" aria-label="Back 15 seconds" title="Back 15 seconds (Shift ←)" aria-keyshortcuts="Shift+ArrowLeft" disabled>−15<span>s</span></button>
          <button type="button" id="momentPlayToggle" class="moment-button" title="Play or pause (Space)" aria-keyshortcuts="Space" disabled>Play</button>
          <button type="button" class="transport-key" data-transport="forward" aria-label="Forward 15 seconds" title="Forward 15 seconds (Shift →)" aria-keyshortcuts="Shift+ArrowRight" disabled>+15<span>s</span></button>
          <button type="button" class="transport-key" data-transport="end" aria-label="Go to end of clip" title="End of clip (End)" aria-keyshortcuts="End" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 5v14M5 5l11 7-11 7z"/></svg></button>
          <button type="button" class="transport-key transport-mark" data-mark="out" aria-label="Mark out: set the end to the playhead" title="Mark out (O or ])" aria-keyshortcuts="O ]" disabled><span>OUT</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 4h5v16h-5"/></svg></button>
          </div></div>
        <details class="transport-options"><summary>Playback options</summary><label><input type="checkbox" id="momentContext" /> Include surrounding audio</label><span id="momentPlaybackNote">Preview selected clip</span><button type="button" class="shortcut-link" id="shortcutOpen">Keyboard shortcuts <kbd>?</kbd></button></details>
        <div class="shortcut-help" id="shortcutHelp" role="dialog" aria-labelledby="shortcutTitle" hidden>
          <div class="shortcut-head"><span class="display-caption" id="shortcutTitle">KEYBOARD SHORTCUTS</span><button type="button" class="shortcut-close" id="shortcutClose" aria-label="Close keyboard shortcuts">×</button></div>
          <dl>
            <div><dt><kbd>Space</kbd></dt><dd>Play / pause</dd></div>
            <div><dt><kbd>I</kbd> <kbd>[</kbd></dt><dd>Mark in at the playhead</dd></div>
            <div><dt><kbd>O</kbd> <kbd>]</kbd></dt><dd>Mark out at the playhead</dd></div>
            <div><dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>Back / forward 1 second</dd></div>
            <div><dt><kbd>Shift</kbd> <kbd>←</kbd> <kbd>→</kbd></dt><dd>Back / forward 15 seconds</dd></div>
            <div><dt><kbd>Home</kbd> <kbd>End</kbd></dt><dd>Start / end of the selection</dd></div>
            <div><dt><kbd>↑</kbd> <kbd>↓</kbd></dt><dd>Previous / next moment</dd></div>
            <div><dt><kbd>−</kbd> <kbd>=</kbd></dt><dd>Zoom out / in on the waveform</dd></div>
            <div><dt><kbd>?</kbd></dt><dd>Show or hide this card</dd></div>
          </dl>
        </div>
`;
  const $ = selector => root.querySelector(selector);
  const overview = $('#tlOverview'), detail = $('#tlDetail');
  const percent = (time, window = view) => 100 * (time - window[0]) / Math.max(.001, window[1] - window[0]);
  function axis(node, range) {
    node.replaceChildren();
    for (let i = 0; i < 5; i++) { const label = document.createElement('span'); label.textContent = timeLabel(range[0] + i * (range[1] - range[0]) / 4); node.append(label); }
  }
  function wave(canvas, range, height) {
    const w = canvas.parentElement.clientWidth;
    if (!w) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = w * dpr; canvas.height = height * dpr;
    const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr); ctx.clearRect(0, 0, w, height);
    if (!audio) return;
    const count = Math.max(2, Math.floor(w / (height > 50 ? 7 : 5)));
    const values = peaks(audio.getChannelData(0), range[0], range[1], audio.sampleRate, count);
    // Combine channels so sound present only on the right remains visible.
    for (let channel = 1; channel < audio.numberOfChannels; channel++) {
      const other = peaks(audio.getChannelData(channel), range[0], range[1], audio.sampleRate, count);
      for (let i = 0; i < count; i++) values[i] = Math.max(values[i], other[i]);
    }
    const max = Math.max(.04, ...values);
    const center = height / 2;
    ctx.strokeStyle = '#BDE4ED'; ctx.lineWidth = 1;
    ctx.globalAlpha = .12; ctx.beginPath(); ctx.moveTo(0,center); ctx.lineTo(w,center); ctx.stroke(); ctx.globalAlpha = 1;
    ctx.lineCap = 'round';
    values.forEach((value, i) => {
      const x = (i + .5) * w / count;
      const time = range[0] + (i + .5) / count * (range[1] - range[0]);
      const active = selected && time >= selected.start && time <= selected.end;
      const amplitude = Math.max(.6, value / max * (height - 24) / 2);
      ctx.strokeStyle = active ? '#F3C650' : '#BDE4ED';
      ctx.lineWidth = height > 50 ? 2.6 : 1.6;
      ctx.beginPath(); ctx.moveTo(x, center-amplitude); ctx.lineTo(x, center+amplitude); ctx.stroke();
    });
  }
  function drawWaves() {
    wave(overview.querySelector('canvas'), [0, duration], 44);
    wave(detail.querySelector('canvas'), view, 160);
  }

  function drawRegions() {
    const container = $('.tl-regions'); container.replaceChildren();
    const lanes = regionLanes(moments);
    container.style.height = moments.length ? `${(Math.max(...lanes.values()) + 1) * 27}px` : '0px';
    moments.forEach(m => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'tl-region';
      button.style.setProperty('--moment-color', m.color); button.style.left = `${100 * m.start / duration}%`;
      button.style.width = `${100 * (m.end - m.start) / duration}%`; button.style.top = `${lanes.get(m.id) * 27}px`;
      button.textContent = String(m.number).padStart(2, '0'); button.title = `${m.number ? 'Moment ' + m.number + ': ' : ''}${m.title}, ${timeLabel(m.start)}–${timeLabel(m.end)}`;
      button.setAttribute('aria-label', button.title); button.setAttribute('aria-pressed', String(selected?.id === m.id));
      button.disabled = busy; button.addEventListener('click', () => events.select(m.id)); container.append(button);
    });
  }
  function drawSpeakers() {
    const box = $('.tl-speakers'); box.replaceChildren();
    box.hidden = !turns.length;
    if (!turns.length) return;
    const visible = turns.filter(t => t.end > view[0] && t.start < view[1]);
    const merged = [];
    visible.forEach(t => {
      const name = labels[t.speaker]?.trim() || t.speaker;
      const last = merged.at(-1);
      if (last && last.name === name && t.start - last.end < 1.2) last.end = t.end;
      else merged.push({ name, start: t.start, end: t.end });
    });
    merged.forEach(t => {
      const node = document.createElement('span'); node.className = 'tl-speaker';
      node.style.left = `${percent(Math.max(view[0], t.start))}%`; node.style.width = `${percent(Math.min(view[1], t.end)) - percent(Math.max(view[0], t.start))}%`;
      const match = /^s(\d+):speaker_(\d+)$/.exec(t.name);
      const label = match ? `Speaker ${Number(match[2]) + 1} · §${Number(match[1]) + 1}` : t.name === 'unknown' ? 'Unknown' : t.name;
      node.textContent = label; node.title = `${label} · ${timeLabel(t.start)}–${timeLabel(t.end)}`; box.append(node);
    });
  }
  function drawSelection() {
    const valid = !!selected && duration > 0;
    $('.tl-selection').hidden = !valid;
    const durationField = $('#waveformDuration');
    durationField.disabled = !valid || busy;
    if (document.activeElement !== durationField) durationField.value = valid ? (selected.end - selected.start).toFixed(1) : '';
    renderDurationFace($('#waveformDurationFace'), valid ? selected.end - selected.start : NaN);
    queueMicrotask(fitReadout);

    for (const edge of ['start', 'end']) {
      const field = $(edge === 'start' ? '#waveformStart' : '#waveformEnd');
      field.disabled = !valid || busy;
      if (document.activeElement !== field) field.value = valid ? timeLabel(selected[edge]) : '';
      const handle = $(`.tl-${edge}`); handle.hidden = !valid;
      if (!valid) continue;
      const t = selected[edge]; handle.hidden = t < view[0] - .051 || t > view[1] + .051; handle.style.left = `${Math.max(0, Math.min(100, percent(t)))}%`;
      handle.setAttribute('aria-valuemin', edge === 'start' ? '0' : String(selected.start + .25));
      handle.setAttribute('aria-valuemax', edge === 'end' ? String(duration) : String(selected.end - .25));
      handle.setAttribute('aria-valuenow', String(t)); handle.setAttribute('aria-valuetext', timeLabel(t)); handle.disabled = busy;
    }
    if (valid) {
      root.style.setProperty('--selected-color', selected.color);
      $('.tl-selection').style.left = `${Math.max(0,Math.min(100,percent(selected.start)))}%`;
      $('.tl-selection').style.width = `${Math.max(0,Math.min(100,percent(selected.end))-Math.max(0,percent(selected.start)))}%`;
      $('#tlSelectedName').textContent = `${String(selected.number).padStart(2, '0')} · ${selected.title}`;
    }
    $('.tl-view-window').style.left = `${100 * view[0] / Math.max(1, duration)}%`;
    $('.tl-view-window').style.width = `${100 * (view[1] - view[0]) / Math.max(1, duration)}%`;
    const maxZoom = Math.max(1,duration/Math.min(2,duration || 2));
    const zoom = duration / Math.max(.001,view[1]-view[0]);
    $('#tlZoom').value = maxZoom > 1 ? 100*Math.log(Math.max(1,zoom))/Math.log(maxZoom) : 0;
    $('#tlZoom').disabled = maxZoom <= 1;
    $('#tlZoom').setAttribute('aria-valuetext', `${zoom.toFixed(1)} times magnification`);
    $('#tlZoomValue').textContent = `${Math.max(1,zoom).toFixed(1)}×`;
    $('#tlZoomOut').disabled = zoom <= 1.001; $('#tlZoomIn').disabled = zoom >= maxZoom-.001;

  }
  function drawPlayhead() {
    const x = percent(playhead); $('.tl-playhead').hidden = x < 0 || x > 100;
    $('.tl-playhead').style.left = `${x}%`;
  }
  function render() {
    drawWaves();
    axis($('.tl-overview-axis'), [0, duration]); axis($('.tl-detail-axis'), view);
    $('#tlDuration').textContent = duration ? timeLabel(duration) : 'Reading…';
    $('.tl-loading').hidden = !!audio; drawRegions(); drawSelection(); drawSpeakers(); drawPlayhead();
  }
  function change(edge, t) {
    if (!selected || busy) return;
    const [a, b] = boundedRange(edge === 'start' ? t : selected.start, edge === 'end' ? t : selected.end, duration, edge);
    selected.start = Math.round(a * 10) / 10; selected.end = Math.min(duration, Math.round(b * 10) / 10);
    drawSelection(); drawRegions(); drawWaves(); events.change(selected.start, selected.end);
  }
  const durationField = $('#waveformDuration');
  durationField.addEventListener('input', () => durationField.setCustomValidity(''));
  durationField.addEventListener('change', () => {
    if (!selected || busy) return;
    const seconds = parseDuration(durationField.value);
    const range = Number.isFinite(seconds) ? rangeForDuration(selected.start, seconds, duration) : null;
    if (!range) {
      durationField.setCustomValidity('Type a length like 25.5, 1:25 or 1m 25s, within the recording.'); durationField.reportValidity();
      durationField.value = (selected.end - selected.start).toFixed(1); return;
    }
    [selected.start, selected.end] = range;
    durationField.value = (selected.end - selected.start).toFixed(1);
    if (selected.start < view[0] || selected.end > view[1]) view = fitRange(selected.start, selected.end, duration);
    render(); events.change(selected.start, selected.end);
  });
  durationField.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); durationField.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); durationField.value = selected ? (selected.end - selected.start).toFixed(1) : ''; durationField.blur(); }
  });
  ['start', 'end'].forEach(edge => {
    const handle = $(`.tl-${edge}`);
    const field = $(edge === 'start' ? '#waveformStart' : '#waveformEnd');
    segField(field);
    // Start and end read as timecode, and accept timecode or plain seconds. An unreadable entry
    // explains itself and puts the time back; arrow keys nudge a tenth, or a second with Shift.
    const setEdge = t => {
      change(edge, t);
      if (selected.start < view[0] || selected.end > view[1]) { view = fitRange(selected.start, selected.end, duration); render(); }
    };
    field.addEventListener('input', () => field.setCustomValidity(''));
    field.addEventListener('change', () => {
      if (!selected || busy) return;
      const t = parseTimecode(field.value);
      if (!Number.isFinite(t)) {
        field.setCustomValidity('Type a time like 1:23.4, or a number of seconds.'); field.reportValidity();
        field.value = timeLabel(selected[edge]); return;
      }
      setEdge(t); field.value = timeLabel(selected[edge]);
    });
    field.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); field.blur(); return; }
      if (e.key === 'Escape') { e.preventDefault(); field.setCustomValidity(''); if (selected) field.value = timeLabel(selected[edge]); field.blur(); return; }
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && selected && !busy) {
        e.preventDefault();
        setEdge(selected[edge] + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 1 : 0.1));
        field.value = timeLabel(selected[edge]);
      }
    });
    handle.addEventListener('pointerdown', e => {
      if (busy || !selected) return;
      if (e.button !== 0 || e.isPrimary === false) return;
      e.preventDefault(); endTrimGesture(); handle.setPointerCapture(e.pointerId); gesture = edge;
      trimX = trimOriginX = e.clientX; trimMoved = false; trimStamp = performance.now();
      trimFrame = requestAnimationFrame(autoExpandTrim);
    });
    handle.addEventListener('pointermove', e => {
      if (gesture !== edge) return;
      trimX = e.clientX; trimMoved ||= Math.abs(trimX-trimOriginX) >= 2;
      if (trimMoved) dragTrimAtPointer();
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(type, endTrimGesture);
    handle.addEventListener('keydown', e => {
      if (!selected || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault(); let t = selected[edge];
      if (e.key === 'Home') t = 0;
      else if (e.key === 'End') t = duration;
      else t += (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1 : .1);
      change(edge, t);
      if (selected.start < view[0] || selected.end > view[1]) { view = fitRange(selected.start, selected.end, duration); render(); }
    });
  });
  detail.addEventListener('click', e => {
    if (e.target.closest('.tl-handle') || busy || !duration) return;
    const r = detail.getBoundingClientRect(); events.seek(view[0] + (e.clientX - r.left) / r.width * (view[1] - view[0]));
  });
  let zoomCenter = null;
  function zoomTo(value) {
    if (!duration) return;
    const maxZoom = Math.max(1,duration/Math.min(2,duration));
    const center = zoomCenter ?? (selected ? (selected.start+selected.end)/2 : (view[0]+view[1])/2);
    view = magnifiedRange(duration, Math.pow(maxZoom,Math.max(0,Math.min(100,value))/100),center); render();
  }
  $('#tlZoom').addEventListener('pointerdown', () => { zoomCenter = playhead >= view[0] && playhead <= view[1] && playhead > 0 ? playhead : selected ? (selected.start+selected.end)/2 : (view[0]+view[1])/2; });
  $('#tlZoom').addEventListener('input', e => zoomTo(Number(e.target.value)));
  $('#tlZoom').addEventListener('change', () => { zoomCenter = null; });
  $('#tlZoomOut').addEventListener('click', () => zoomTo(Number($('#tlZoom').value)-10));
  $('#tlZoomIn').addEventListener('click', () => zoomTo(Number($('#tlZoom').value)+10));
  overview.addEventListener('click', e => {
    if (!duration) return;
    const r = overview.getBoundingClientRect(); const center = Math.max(0,Math.min(duration,(e.clientX-r.left)/r.width*duration));
    view = magnifiedRange(duration,duration/Math.max(.001,view[1]-view[0]),center); render();
  });
  window.addEventListener('blur', endTrimGesture);
  const observer = new ResizeObserver(render); observer.observe(root);
  return {
    levels(time, active) {
      const available = !!audio;
      const stereo = available && audio.numberOfChannels > 1;
      $('#meterCaption').textContent = available ? 'SOURCE LEVEL' : 'LEVEL UNAVAILABLE';
      $('#meterLeftLabel').textContent = stereo ? 'L' : 'M';
      $('#meterLeft').setAttribute('aria-label', stereo ? 'Left source level in decibels' : 'Mono source level in decibels');
      $('#meterRightRow').hidden = !stereo;
      for (const [i, id] of [[0,'#meterLeft'],[1,'#meterRight']]) {
        const db = active && available && (i === 0 || stereo) ? sourceLevel(audio.getChannelData(i),audio.sampleRate,time) : -60;
        $(id).value = db; $(id).style.setProperty('--level', `${(db+60)/60*100}%`);
      }
      const left = Number($('#meterLeft').value), right = stereo ? Number($('#meterRight').value) : left;
      root.querySelectorAll('.led-bar').forEach(bar => bar.style.setProperty('--level', `${((bar.dataset.channel === '1' ? right : left) + 60) / 60 * 100}%`));
    },
    source(buffer, seconds) { endTrimGesture(); audio = buffer; duration = seconds || 0; view = [0, duration]; render(); this.levels(0, false); },
    moments(items) { moments = items; render(); },
    select(item, fit = true) { endTrimGesture(); selected = item; if (fit && item) view = fitRange(item.start, item.end, duration); render(); },
    speakers(items, names) { turns = items; labels = names; drawSpeakers(); },
    range(start, end) { if (selected) { selected.start = start; selected.end = end; if (start < view[0] || end > view[1]) view = fitRange(start, end, duration); render(); } },
    playhead(time) { playhead = time; drawPlayhead(); },
    busy(on) { if (on) endTrimGesture(); busy = on; drawRegions(); drawSelection(); },
    progress(fraction) { const bar = $('.tl-analysis-progress'); bar.hidden = fraction == null; bar.style.width = `${Math.max(0, Math.min(1, fraction || 0)) * 100}%`; },
    window(start, end) { view = [start, end]; render(); },
    redraw: render
  };
}
