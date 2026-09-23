import test from 'node:test';
import assert from 'node:assert/strict';
import {rewindForExport} from '../export-start.mjs';
class Media extends EventTarget {
  constructor(time) { super(); this.time = time; this.seeking = false; this.paused = false; }
  pause() { this.paused = true; }
  get currentTime() { return this.time; }
  set currentTime(value) { this.time = value; this.seeking = true; }
  finishSeek() { this.seeking = false; this.dispatchEvent(new Event('seeked')); }
}
test('export from the end pauses and awaits seek before resetting the first frame', async () => {
  const media = new Media(38); let painted = false;
  const ready = rewindForExport(media, () => { assert.equal(media.currentTime, 0); assert.equal(media.paused, true); painted = true; });
  assert.equal(painted, false); media.finishSeek(); await ready; assert.equal(painted, true);
});
test('export already at the beginning still paints a fresh first frame', async () => {
  const media = new Media(0); let painted = false;
  await rewindForExport(media, () => { painted = true; }); assert.equal(painted, true);
});
test('failed seek never primes a recording frame', async () => {
  const media = new Media(10); let painted = false;
  const ready = rewindForExport(media, () => { painted = true; }, 5);
  await assert.rejects(ready, /beginning/); assert.equal(painted, false);
});
