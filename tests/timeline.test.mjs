import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedRange, rangeForDuration, sourceLevel, expandTrimView, fitRange, regionLanes, peaks, timeLabel } from '../timeline.mjs';
test('time labels carry tenths across minute boundaries', () => {
  assert.equal(timeLabel(59.98), '1:00.0'); assert.equal(timeLabel(3601.2), '60:01.2');
});
test('trim edges cannot cross or leave the recording', () => {
  assert.deepEqual(boundedRange(80, 40, 120, 'start'), [39.7, 40]);
  assert.deepEqual(boundedRange(20, 500, 120, 'end'), [20, 120]);
  assert.deepEqual(boundedRange(-5, 40, 120, 'start'), [0, 40]);
});
test('zoom keeps context and stays within source bounds', () => {
  assert.deepEqual(fitRange(0, 10, 120), [0, 12]);
  assert.deepEqual(fitRange(115, 120, 120), [113, 120]);
});
test('overlapping recommendations are assigned separate lanes', () => {
  const lanes = regionLanes([{ id: 'a', start: 0, end: 30 }, { id: 'b', start: 20, end: 40 }, { id: 'c', start: 40, end: 60 }]);
  assert.equal(lanes.get('a'), 0); assert.equal(lanes.get('b'), 1); assert.equal(lanes.get('c'), 0);
});
test('waveform peaks come from the visible audio window', () => {
  const data = new Float32Array([0, .2, .8, -.4, 0, 0, 0, 0]);
  assert.equal(peaks(data, 0, 2, 4, 2)[0], data[2]);
  assert.deepEqual([...peaks(data, 1, 2, 4, 2)], [0, 0]);
});


test('navigation pans without changing width and clamps zoom edges', async () => {
  const {adjustView} = await import('../timeline.mjs');
  assert.deepEqual(adjustView([10,30],'pan',95,100),[80,100]);
  assert.deepEqual(adjustView([10,30],'pan',-20,100),[0,20]);
  assert.deepEqual(adjustView([10,30],'start',40,100),[29,30]);
  assert.deepEqual(adjustView([10,30],'end',-40,100),[10,11]);
});


test('magnification centers and clamps the view without modifying a clip', async () => {
  const {magnifiedRange} = await import('../timeline.mjs');
  assert.deepEqual(magnifiedRange(100,1,20),[0,100]);
  assert.deepEqual(magnifiedRange(100,5,50),[40,60]);
  assert.deepEqual(magnifiedRange(100,5,0),[0,20]);
  assert.deepEqual(magnifiedRange(100,5,100),[80,100]);
  assert.deepEqual(magnifiedRange(0,5,0),[0,0]);
});

test('duration edits anchor start and shift back only at the recording boundary', () => {
  assert.deepEqual(rangeForDuration(20, 30, 120), [20, 50]);
  assert.deepEqual(rangeForDuration(20, 5, 120), [20, 25]);
  assert.deepEqual(rangeForDuration(110, 30, 120), [90, 120]);
  assert.deepEqual(rangeForDuration(110, 120, 120), [0, 120]);
  assert.deepEqual(rangeForDuration(0, .1, .2), [0, .2]);
  assert.equal(rangeForDuration(20, NaN, 120), null);
  assert.equal(rangeForDuration(0, 10, 0), null);
});

test('source level meter uses real amplitude and handles silence and boundaries', () => {
  assert.equal(sourceLevel(new Float32Array(100), 1000, 0), -60);
  assert.ok(Math.abs(sourceLevel(new Float32Array(100).fill(.5),1000,0) + 6.0206) < .001);
  assert.equal(sourceLevel(new Float32Array(100).fill(1),1000,0), 0);
  assert.equal(sourceLevel(new Float32Array(100).fill(1),1000,1), -60);
});

test('trim edge expansion is gradual, directional, and bounded', () => {
  const right = expandTrimView([20,40], 'end', 1, 120, .05);
  assert.equal(right[0],20); assert.ok(right[1]>40 && right[1]<41);
  const left = expandTrimView([20,40], 'start', 0, 120, .05);
  assert.equal(left[1],40); assert.ok(left[0]<20 && left[0]>19);
  assert.deepEqual(expandTrimView([20,40], 'end', .5, 120, .05),[20,40]);
  assert.deepEqual(expandTrimView([20,40], 'start', 1, 120, .05),[20,40]);
  assert.deepEqual(expandTrimView([20,120], 'end', 2, 120, .05),[20,120]);
  assert.deepEqual(expandTrimView([0,40], 'start', -1, 120, .05),[0,40]);
  let view = [20,40];
  for (let i=0; i<1000; i++) view = expandTrimView(view,'end',1,120,.05);
  assert.deepEqual(view,[20,120]);
});
