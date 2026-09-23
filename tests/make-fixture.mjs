// Original synthetic fixture: two minutes of a quiet tone, no third-party media.
import { writeFile } from 'node:fs/promises';
const rate = 8000, frames = 120 * rate;
const wav = Buffer.alloc(44 + frames * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(frames * 2, 40);
for (let i = 0; i < frames; i++) {
  const t = i / rate, beat = Math.floor(t * 3.4), phase = t * 3.4 - beat;
  const level = ((beat * 17 % 29) + 3) / 32;
  const pause = Math.floor(t) % 9 === 8 || t % 40 > 37 ? 0.02 : 1;
  const envelope = Math.sin(phase * Math.PI) * level * pause;
  wav.writeInt16LE(Math.round(9000 * envelope * Math.sin(2 * Math.PI * (180 + 40 * Math.floor(t / 40)) * t)), 44 + i * 2);
}
await writeFile(new URL('./synthetic-recording.wav', import.meta.url), wav);
console.log('Created tests/synthetic-recording.wav (test tone; fixture transcript is invented).');
