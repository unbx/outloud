import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWords, segmentsFromWords, validateSegments, validateCandidates, clipWords, validRange } from '../moments-core.mjs';
import handler, { analysisError } from '../api/moments.js';

const segments = Array.from({ length: 12 }, (_, i) => ({ id: i, start: i * 10, end: (i + 1) * 10,
  text: `Sentence ${i}.`, speaker: i < 6 ? 'guest' : 'host' }));
const candidate = (startSegment, endSegment) => ({ startSegment, endSegment, title: 'A useful insight', reason: 'A complete takeaway.', context: '' });
test('section offsets, ownership boundaries and speaker IDs survive normalization', () => {
  const raw = [{ text: 'before', start: 0, end: 1, speaker_id: 'speaker_0' },
    { text: 'kept', start: 2, end: 3, speaker_id: 'speaker_0' },
    { text: 'bad', start: NaN, end: 4 }, { text: '(music)', type: 'audio_event', start: 3, end: 4 }];
  assert.deepEqual(normalizeWords(raw, 118, 1, 120, 240), [{ text: 'kept', start: 120, end: 121, speaker: 's1:speaker_0' }]);
  assert.notEqual(normalizeWords(raw, 0, 0)[0].speaker, normalizeWords(raw, 0, 1)[0].speaker);
});
test('segments split at sentence endings, silence and speaker turns', () => {
  const words = normalizeWords([
    { text: 'Hello', start: 0, end: 1, speaker_id: 'speaker_0' },
    { text: 'world.', start: 1, end: 2, speaker_id: 'speaker_0' },
    { text: 'Yes.', start: 2, end: 3, speaker_id: 'speaker_1' },
    { text: 'More', start: 5, end: 6, speaker_id: 'speaker_1' }]);
  assert.equal(segmentsFromWords(words).length, 3);
});
test('reject fabricated boundaries, wrong lengths, duplicate ranges and wrong speakers', () => {
  assert.equal(validateCandidates([candidate(0, 3), candidate(1, 4), candidate(50, 55), candidate(-1, 3), candidate(2.2, 5), candidate(0, 0)], segments).length, 1);
  assert.equal(validateCandidates([candidate(6, 9)], segments, 30, 60, 'guest').length, 0);
  assert.equal(validateCandidates([candidate(0, 3)], segments, 30, 60, 'guest')[0].start, 0);
});
test('clip timestamps rebase to selected audio without negative or overflowing words', () => {
  const result = clipWords([{ text: 'a', start: 9, end: 10.5 }, { text: 'b', start: 11, end: 13 }, { text: 'c', start: 15, end: 16 }], 10, 12);
  assert.deepEqual(result.map(w => [w.start, w.end]), [[0, .5], [1, 2]]);
  assert.equal(validRange(12, 10, 20), false);
  assert.equal(validRange(0, 21, 20), false);
});
test('reject malformed and oversized transcript input', () => {
  assert.throws(() => validateSegments([{ ...segments[0], start: -1 }]));
  assert.throws(() => validateSegments([{ ...segments[0], text: 'x'.repeat(2001) }]));
  assert.throws(() => validateSegments([segments[0], { ...segments[1], id: 5 }]));
  assert.equal(validateSegments(segments).length, 12);
});

function response() {
  return { code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}
test('API authenticates before calling the model and validates its output', async () => {
  const oldFetch = globalThis.fetch, oldPass = process.env.TESTER_PASSWORD, oldKey = process.env.OPENAI_API_KEY;
  process.env.TESTER_PASSWORD = 'test-only'; process.env.OPENAI_API_KEY = 'not-a-real-key';
  let calls = 0;
  globalThis.fetch = async (_, options) => {
    calls++; const request = JSON.parse(options.body);
    assert.equal(request.store, false); assert.equal(request.text.format.strict, true);
    return { ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ moments: [candidate(0, 3), candidate(999, 1000)] }) }] }] }) };
  };
  try {
    const bad = response(); await handler({ method: 'POST', headers: {}, body: {} }, bad);
    assert.equal(bad.code, 401); assert.equal(calls, 0);
    const ready = response(); await handler({ method: 'GET', headers: { 'x-tester-pass': 'test-only' } }, ready);
    assert.equal(ready.body.ready, true); assert.equal(calls, 0);
    const malformed = response(); await handler({ method: 'POST', headers: { 'x-tester-pass': 'test-only' }, body: { segments: [] } }, malformed);
    assert.equal(malformed.code, 400); assert.equal(calls, 0);
    const result = response(); await handler({ method: 'POST', headers: { 'x-tester-pass': 'test-only' }, body: { segments, min: 30, max: 60 } }, result);
    assert.equal(result.code, 200); assert.equal(result.body.moments.length, 1); assert.equal(calls, 1);
    const auto = response(); await handler({ method: 'POST', headers: { 'x-tester-pass': 'test-only' }, body: { segments, min: 15, max: 90 } }, auto);
    assert.equal(auto.code, 200); assert.equal(auto.body.moments.length, 1);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldPass === undefined) delete process.env.TESTER_PASSWORD; else process.env.TESTER_PASSWORD = oldPass;
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
  }
});


test('own-key analysis forwards only to OpenAI and reports model access failures', async () => {
  const oldFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(options.headers.Authorization, 'Bearer unit-test-key');
      return { ok: false, status: 404, json: async () => ({error:{code:"model_not_found"}}) };
    };
    const result = response();
    await handler({method:'POST', headers:{'x-moments-key':'unit-test-key'}, body:{segments,min:30,max:60}}, result);
    assert.equal(result.code, 502);
    assert.match(result.body.error, /model is not available/);
    assert.doesNotMatch(JSON.stringify(result.body), /unit-test-key/);
  } finally { globalThis.fetch = oldFetch; }
});


test('billing exhaustion is distinguished from temporary rate limits without exposing provider details', () => {
  const exhausted = analysisError(429, {code:'credit_balance_exhausted',type:'insufficient_quota',message:'secret detail'});
  assert.equal(exhausted.code, 'credits_exhausted');
  assert.match(exhausted.error, /add credits/);
  assert.doesNotMatch(exhausted.error, /secret detail/);
  assert.equal(analysisError(429, {code:'rate_limit_exceeded'}).code, 'rate_limited');
});

test('transcript search matches literal phrases without case sensitivity and keeps every passage', async () => {
  const { transcriptPassages } = await import('../moments-core.mjs');
  const segments = [
    { id: 0, start: 0, end: 8, text: 'ApeFest starts here.' },
    { id: 1, start: 20, end: 30, text: 'We met at APEFEST.' },
    { id: 2, start: 40, end: 50, text: 'Another topic.' }
  ];
  assert.deepEqual(transcriptPassages(segments, [], ' apefest ', 60).map(s => s.id), [0, 1]);
  assert.equal(transcriptPassages(segments, [], '[.*]', 60).length, 0);
  assert.equal(transcriptPassages(segments, [], '', 60).length, 3);
});
test('long search passages stay within the clip limit and include the matching word', async () => {
  const { transcriptPassages } = await import('../moments-core.mjs');
  const words = [{text:'Before',start:0,end:1},{text:'APEFEST',start:110,end:111},{text:'after.',start:130,end:131}];
  const segment = {id:0,start:0,end:131,text:'Before APEFEST after.',firstWord:0,lastWord:2};
  const [result] = transcriptPassages([segment],words,'APEFEST',131);
  assert.ok(result.end-result.start <= 90);
  assert.ok(result.start <= 110 && result.end >= 111);
  assert.ok(result.start >= 0 && result.end <= 131);
});
