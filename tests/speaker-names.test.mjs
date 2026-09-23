import test from 'node:test';
import assert from 'node:assert/strict';
import {labeledSpeakersForRange} from '../moments-core.mjs';
const words = [{start:0,end:5,speaker:'a'},{start:5,end:10,speaker:'b'},{start:10,end:15,speaker:'a'}];
test('names come only from labeled voices overlapping the selection', () => {
 assert.equal(labeledSpeakersForRange(words,{a:' Sean ',b:'Maya'},0,5),'Sean');
 assert.equal(labeledSpeakersForRange(words,{a:'Sean',b:'Maya'},5,10),'Maya');
 assert.equal(labeledSpeakersForRange(words,{},0,15),'');
 assert.equal(labeledSpeakersForRange(words,{a:'Sean',b:'Maya'},0,15),'Sean & Maya');
 assert.equal(labeledSpeakersForRange(words,{a:'Sean',b:'Sean'},0,15),'Sean');
});
