import {test} from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {flagBank} from '../src/flag_game.js';
import {createRoom, publicRoom} from '../src/game.js';

test('all 195 states have a unique flag, decoded picture and Arabic/English answers', async () => {
  assert.equal(flagBank.length, 195);
  assert.equal(new Set(flagBank.map(q => q.id)).size, 195);
  for (const q of flagBank) {
    assert.match(q.id, /^flag_[a-z]{2}$/);
    assert.equal(q.category, 'أعلام الدول');
    assert.ok(q.answers.some(a => /[\u0600-\u06ff]/u.test(a)));
    assert.ok(q.answers.some(a => /[a-z]/i.test(a)));
    const metadata = await sharp(Buffer.from(q.image.split(',')[1], 'base64')).metadata();
    assert.equal(metadata.format, 'png'); assert.equal(metadata.width, 320);
  }
});

test('each new authored pack game draws a random subset/order, resume keeps its deck', () => {
  const custom = Array.from({length: 30}, (_, i) => ({id: `authored_${i}`, category: 'باقة مخصصة', level: 'easy', prompt: `سؤال ${i}`, answers: [`إجابة ${i}`]}));
  const settings = {rounds: 2, questionsPerRound: 10, seconds: 20, halfWhenBothCorrect: true, level: 'mixed', categories: ['باقة مخصصة']};
  const rooms = Array.from({length: 24}, (_, i) => createRoom(String(100000 + i), 'أحمد', settings, custom, 0).room);
  assert.ok(new Set(rooms.map(r => r.deck[0])).size > 1);
  assert.equal(new Set(rooms.map(r => JSON.stringify(r.deck))).size, rooms.length);
  for (const room of rooms) {
    assert.equal(new Set(room.deck).size, 20);
    const original = [...room.deck];
    publicRoom(room, room.hostId, custom, new Set(), 1000);
    assert.deepEqual(room.deck, original);
  }
});
