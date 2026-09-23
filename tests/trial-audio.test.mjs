import {test} from 'node:test';
import assert from 'node:assert/strict';
import {measureSection,wavSeconds,opusSeconds} from '../lib/trial-audio.mjs';
import {wav,opus} from './audio-fixtures.mjs';

test('WAV length comes from PCM bytes, and a mismatched header is refused',()=>{
 assert.equal(wavSeconds(wav(122)),122);
 const b=wav(2);b.writeUInt32LE(1,40);assert.throws(()=>wavSeconds(b));
 const stereo=wav(2);stereo.writeUInt16LE(2,22);assert.throws(()=>wavSeconds(stereo));
});
test('Opus length is counted from every packet, whatever the page granules claim',()=>{
 assert.equal(opusSeconds(opus(604)),603.96); // 5,033 packets of 120 ms
 assert.equal(opusSeconds(opus(10,{frames:1})),10);
 assert.equal(opusSeconds(opus(600,{granule:48000})),600); // a forged 1-second granule changes nothing
});
test('malformed or smuggled Opus is refused rather than under-measured',()=>{
 const good=opus(5);
 assert.throws(()=>opusSeconds(Buffer.concat([good,Buffer.from('junk')])));            // trailing bytes
 assert.throws(()=>opusSeconds(Buffer.concat([good,opus(5,{serial:9})])));             // a second stream
 assert.throws(()=>opusSeconds(good.subarray(0,good.length-2)));                       // truncated packet
 const bad=Buffer.from(good);bad[bad.indexOf(Buffer.from([(31<<3)|3,6]))+1]=0;assert.throws(()=>opusSeconds(bad)); // zero-frame packet
});
test('sections are recognized by their bytes, not their declared type',()=>{
 assert.deepEqual(measureSection(wav(3)),{kind:'wav',seconds:3});
 assert.equal(measureSection(opus(3)).kind,'opus');
 assert.throws(()=>measureSection(Buffer.from('ID3 not audio')));
});
