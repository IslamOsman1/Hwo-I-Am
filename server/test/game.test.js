import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRoom, joinRoom, command, advanceClock, publicRoom, normalize, ranking, settingsFor} from '../src/game.js';
import {RoomStore} from '../src/store.js';

const bank = [1, 2, 3].map(i => ({id: `q${i}`, prompt: `السؤال ${i}`, category: 'علوم', level: 'easy', answers: ['القاهرة', 'Cairo'], explanation: 'معلومة'}));
const options = {rounds: 1, questionsPerRound: 3, seconds: 20, halfWhenBothCorrect: true, level: 'mixed', categories: ['علوم']};
function setup(half = true) {
  const {room} = createRoom('123456', 'أحمد', {...options, halfWhenBothCorrect: half}, bank, 1000);
  const {player} = joinRoom(room, 'منى', 1000);
  const [a, b] = room.players.map(p => p.id);
  const online = new Set([a, b]);
  const run = (id, message, now) => command(room, id, message, bank, now, online);
  run(a, {type: 'ready', ready: true}, 1000); run(b, {type: 'ready', ready: true}, 1000);
  run(a, {type: 'start', index: -1}, 1000); advanceClock(room, bank, 4000);
  return {room, player, a, b, run, online};
}
test('Arabic normalization accepts deliberate variants, numbers, case and spacing but not arbitrary typos', () => {
  assert.equal(normalize('إِسْكَنْدَرِيّة'), normalize('اسكندرية'));
  assert.equal(normalize('١٢٣'), '123'); assert.equal(normalize('۱۲۳'), '123');
  assert.equal(normalize('  CAIRO! '), 'cairo');
  assert.notEqual(normalize('القاهررة'), normalize('القاهرة'));
});
test('both correct half mode gives 10 each, one correct gives 20', () => {
  const {room, a, b, run} = setup();
  run(a, {type: 'answer', index: 0, text: 'القَاهِرة'}, 6000);
  run(b, {type: 'answer', index: 0, text: 'Cairo'}, 7000);
  assert.deepEqual(ranking(room).map(p => p.score), [10, 10]);
  assert.equal(ranking(room)[0].id, a);
  run(a, {type: 'next', index: 0}, 8000); advanceClock(room, bank, 11000);
  run(a, {type: 'answer', index: 1, text: 'لا أعرف'}, 12000);
  run(b, {type: 'answer', index: 1, text: 'القاهرة'}, 15000);
  assert.equal(ranking(room)[0].id, b); assert.equal(ranking(room)[0].score, 30);
});
test('full mode gives 20 to each correct player', () => {
  const {room, a, b, run} = setup(false);
  run(a, {type: 'answer', index: 0, text: 'القاهرة'}, 6000);
  run(b, {type: 'answer', index: 0, text: 'القاهرة'}, 7000);
  assert.deepEqual(ranking(room).map(p => p.score), [20, 20]);
});
test('host override recomputes historical points and speed using unchanged original answer/time', () => {
  const {room, a, b, run} = setup();
  run(a, {type: 'answer', index: 0, text: 'القاهررة'}, 5000);
  run(b, {type: 'answer', index: 0, text: 'القاهرة'}, 8000);
  assert.equal(ranking(room)[0].score, 20);
  assert.throws(() => run(b, {type: 'override', index: 0, playerId: a, correct: true}, 8500));
  run(a, {type: 'override', index: 0, playerId: a, correct: true}, 9000);
  assert.deepEqual(ranking(room).map(p => p.score), [10, 10]);
  assert.equal(ranking(room)[0].id, a);
  assert.equal(ranking(room)[0].averageMs, 1000);
  assert.equal(room.history[0].answers[a].text, 'القاهررة');
  assert.equal(room.audit.length, 1);
  run(a, {type: 'override', index: 0, playerId: a, correct: false}, 9100);
  assert.equal(ranking(room)[0].id, b); assert.equal(ranking(room)[0].score, 20);
});
test('wrong fast answers never improve speed; exact ties share rank', () => {
  const {room, a, b, run} = setup();
  run(a, {type: 'answer', index: 0, text: 'غلط'}, 4001);
  run(b, {type: 'answer', index: 0, text: 'غلط'}, 4010);
  assert.deepEqual(ranking(room).map(p => p.rank), [1, 1]);
  assert.deepEqual(ranking(room).map(p => p.averageMs), [null, null]);
  run(a, {type: 'next', index: 0}, 5000); advanceClock(room, bank, 8000);
  run(a, {type: 'answer', index: 1, text: 'القاهرة'}, 9000);
  run(b, {type: 'answer', index: 1, text: 'القاهرة'}, 9000);
  assert.deepEqual(ranking(room).map(p => p.rank), [1, 1]);
  assert.deepEqual(ranking(room).map(p => p.averageMs), [1000, 1000]);
});
test('secret answer and opponent text are absent before reveal, including countdown', () => {
  const {room, a, b, run, online} = setup();
  run(a, {type: 'answer', index: 0, text: 'Cairo'}, 5000);
  const view = publicRoom(room, b, bank, online, 5000);
  assert.equal(view.ownAnswer, null); assert.equal(view.history.length, 0);
  const encoded = JSON.stringify(view);
  assert.ok(!encoded.includes('Cairo')); assert.ok(!encoded.includes('tokenHash'));
  assert.ok(!encoded.includes('deck'));
  advanceClock(room, bank, room.deadline);
  run(a, {type: 'next', index: 0}, 25000);
  assert.equal(publicRoom(room, a, bank, online, 25000).question, null);
});
test('deadline, stale indices, duplicate submissions and guest start are rejected', () => {
  const {room, a, b, run} = setup();
  assert.throws(() => run(b, {type: 'next', index: 0}, 5000));
  assert.throws(() => run(a, {type: 'answer', index: -1, text: 'القاهرة'}, 5000));
  run(a, {type: 'answer', index: 0, text: 'القاهرة', elapsedMs: 0}, 6000);
  assert.equal(room.answers[a].elapsedMs, 2000);
  assert.throws(() => run(a, {type: 'answer', index: 0, text: 'القاهرة'}, 7000));
  assert.throws(() => run(b, {type: 'answer', index: 0, text: 'القاهرة'}, 24000));
  assert.equal(advanceClock(room, bank, 24000), true);
  assert.equal(room.history[0].answers[b], undefined);
  assert.throws(() => run(a, {type: 'override', index: 0, playerId: b, correct: true}, 25000));
});
test('bank constraints, max sizes, balanced deck and no duplicate within a round', () => {
  const actual = JSON.parse(readFileSync(new URL('../data/questions.json', import.meta.url), 'utf8'));
  const config = {rounds: 20, questionsPerRound: 100, seconds: 20, halfWhenBothCorrect: true, level: 'mixed', categories: [...new Set(actual.map(q => q.category))]};
  const {room} = createRoom('123456', 'أحمد', config, actual, 1000);
  assert.equal(room.deck.length, 2000);
  for (let i = 0; i < 20; i++) assert.equal(new Set(room.deck.slice(i * 100, (i + 1) * 100)).size, 100);
  assert.throws(() => settingsFor({...config, questionsPerRound: 0}, actual));
  assert.throws(() => settingsFor({...config, questionsPerRound: 101}, actual));
  assert.throws(() => settingsFor({...config, categories: ['غير موجود']}, actual));
  assert.throws(() => settingsFor({...config, categories: ['رياضة']}, actual));
});
test('saved games restore exactly and corrupt storage is not silently reset', () => {
  const directory = mkdtempSync(join(tmpdir(), 'menana-store-'));
  try {
    const {room} = setup(); const store = new RoomStore(directory); store.save(room);
    const loaded = new RoomStore(directory); assert.deepEqual(loaded.rooms.get(room.code), room);
    loaded.clean(room.updatedAt + 49 * 3600000); assert.equal(loaded.rooms.size, 0);
    writeFileSync(join(directory, 'rooms.json'), '{broken');
    assert.throws(() => new RoomStore(directory));
  } finally { rmSync(directory, {recursive: true, force: true}); }
});
