// Measures a free-session audio section from its bytes. The browser says where a section sits in
// the recording, but transcription is billed by real audio length, so the server never trusts a
// declared duration: WAV length comes from the PCM byte count, and Ogg Opus length from the frame
// count in every packet's TOC byte, which is what any decoder (and so the provider) plays.
export const SECTION = Object.freeze({ opus: 600, wav: 120, overlap: 2, maxBytes: 4_400_000 });

const bad = () => new Error('Unsupported audio section.');

// 16 kHz, 16-bit, mono PCM: the exact format the app renders for WAV sections.
export function wavSeconds(b) {
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE' ||
      b.toString('ascii', 12, 16) !== 'fmt ' || b.readUInt32LE(16) !== 16 || b.readUInt16LE(20) !== 1 ||
      b.readUInt16LE(22) !== 1 || b.readUInt32LE(24) !== 16000 || b.readUInt32LE(28) !== 32000 ||
      b.readUInt16LE(32) !== 2 || b.readUInt16LE(34) !== 16 || b.toString('ascii', 36, 40) !== 'data') throw bad();
  const size = b.readUInt32LE(40);
  if (size !== b.length - 44 || b.readUInt32LE(4) !== b.length - 8 || size % 2 || size < 3200) throw bad();
  return size / 32000;
}

// Frame length by TOC config: SILK 0-11, hybrid 12-15, CELT 16-31 (RFC 6716 §3.1).
const frameMs = config => config < 12 ? [10, 20, 40, 60][config % 4] : config < 16 ? [10, 20][config % 2] : [2.5, 5, 10, 20][config % 4];
function packetMs(p) {
  if (!p.length) throw bad();
  const code = p[0] & 3;
  const frames = code === 0 ? 1 : code < 3 ? 2 : p.length > 1 ? p[1] & 0x3f : 0;
  const ms = frameMs(p[0] >> 3) * frames;
  if (!frames || ms > 120) throw bad(); // a valid Opus packet holds at most 120 ms
  return ms;
}

// One logical Opus stream, pages back to back, nothing trailing. Pre-skip is deliberately not
// subtracted, so the measurement can only overstate the audio, never understate it.
export function opusSeconds(b) {
  const packets = [];
  let o = 0, serial = null, partial = [];
  while (o < b.length) {
    if (b.length - o < 27 || b.toString('ascii', o, o + 4) !== 'OggS' || b[o + 4] !== 0) throw bad();
    const pageSerial = b.readUInt32LE(o + 14);
    if (serial === null) serial = pageSerial; else if (pageSerial !== serial) throw bad();
    const segments = b[o + 26], table = o + 27;
    let p = table + segments;
    if (p > b.length) throw bad();
    for (let i = 0; i < segments; i++) {
      const len = b[table + i];
      if (p + len > b.length) throw bad();
      partial.push(b.subarray(p, p + len)); p += len;
      if (len < 255) { packets.push(Buffer.concat(partial)); partial = []; }
    }
    o = p;
  }
  if (partial.length || packets.length < 3 || packets[0].length < 19 ||
      packets[0].toString('ascii', 0, 8) !== 'OpusHead' || packets[1].toString('ascii', 0, 8) !== 'OpusTags' ||
      ![1, 2].includes(packets[0][9])) throw bad();
  let ms = 0;
  for (let i = 2; i < packets.length; i++) ms += packetMs(packets[i]);
  return ms / 1000;
}

export function measureSection(b) {
  if (b.toString('ascii', 0, 4) === 'OggS') return { kind: 'opus', seconds: opusSeconds(b) };
  if (b.toString('ascii', 0, 4) === 'RIFF') return { kind: 'wav', seconds: wavSeconds(b) };
  throw bad();
}
