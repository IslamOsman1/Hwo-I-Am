import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import WebSocket from 'ws';
import {startServer} from '../src/server.js';

async function client(url) {
  const ws = new WebSocket(url);
  const inbox = []; const waiters = [];
  ws.on('message', raw => {
    const item = JSON.parse(raw);
    const index = waiters.findIndex(w => w.predicate(item));
    if (index >= 0) { const w = waiters.splice(index, 1)[0]; clearTimeout(w.timer); w.resolve(item); }
    else inbox.push(item);
  });
  await once(ws, 'open');
  return {ws, send: message => ws.send(JSON.stringify(message)),
    next(predicate) {
      const index = inbox.findIndex(predicate);
      if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = {predicate, resolve, timer: setTimeout(() => reject(new Error('Timed out waiting for server event')), 4000)};
        waiters.push(waiter);
      });
    },
  };
}
const type = t => m => m.type === t;
const phase = p => m => m.type === 'state' && m.room.phase === p;

test('two real websocket clients create, join, answer, review, finish, restart and resume', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'menana-e2e-'));
  let time = 100000;
  let app = startServer({port: 0, dataDir: directory, now: () => time});
  const sockets = [];
  try {
    await once(app.http, 'listening');
    const port = app.http.address().port;
    const health = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.json());
    assert.equal(health.ok, true); assert.ok(health.questions >= 300);
    const url = `ws://127.0.0.1:${port}/ws`;
    const host = await client(url); sockets.push(host.ws);
    host.send({type: 'create', name: 'أحمد', settings: {rounds: 1, questionsPerRound: 1, seconds: 20, halfWhenBothCorrect: true, level: 'mixed', categories: ['علوم']}});
    const session = await host.next(type('session'));
    assert.equal(session.token.length, 43);
    const guest = await client(url); sockets.push(guest.ws);
    guest.send({type: 'join', code: session.code, name: 'منى'});
    const guestSession = await guest.next(type('session'));
    await host.next(m => m.type === 'state' && m.room.players.length === 2);
    host.send({type: 'ready', ready: true}); guest.send({type: 'ready', ready: true});
    await host.next(m => m.type === 'state' && m.room.players.every(p => p.ready));
    host.send({type: 'start', index: -1}); await host.next(phase('countdown'));
    time += 3000; const question = (await host.next(phase('question'))).room;
    assert.equal(question.history.length, 0); assert.equal(question.question.answers, undefined);
    const q = app.bank.find(q => q.id === app.store.rooms.get(session.code).deck[0]);
    time += 2000; host.send({type: 'answer', index: 0, text: q.answers[0], elapsedMs: 0});
    const hidden = (await guest.next(m => m.type === 'state' && m.room.submitted.length === 1)).room;
    assert.equal(hidden.ownAnswer, null); assert.equal(hidden.history.length, 0);
    time += 2000; guest.send({type: 'answer', index: 0, text: 'غلطة مطبعية'});
    const review = (await host.next(phase('review'))).room;
    assert.equal(review.ranking[0].score, 20);
    guest.send({type: 'override', index: 0, playerId: guestSession.playerId, correct: true});
    assert.match((await guest.next(type('error'))).message, /صاحب الغرفة/);
    host.send({type: 'override', index: 0, playerId: guestSession.playerId, correct: true});
    const revised = (await host.next(m => m.type === 'state' && m.room.audit.length === 1)).room;
    assert.deepEqual(revised.ranking.map(p => p.score), [10, 10]);
    assert.equal(revised.ranking[0].id, session.playerId);
    assert.equal(revised.history[0].answers[guestSession.playerId].elapsedMs, 4000);
    host.send({type: 'signal', signal: {kind: 'available'}});
    assert.equal((await guest.next(type('signal'))).signal.kind, 'available');
    host.send({type: 'next', index: 0}); await host.next(phase('complete'));
    const saved = readFileSync(join(directory, 'rooms.json'), 'utf8');
    assert.ok(!saved.includes(session.token)); assert.ok(!saved.includes(guestSession.token));
    await app.close();
    app = startServer({port: 0, dataDir: directory, now: () => time}); await once(app.http, 'listening');
    const resumed = await client(`ws://127.0.0.1:${app.http.address().port}/ws`); sockets.push(resumed.ws);
    resumed.send({type: 'resume', code: session.code, token: session.token});
    assert.equal((await resumed.next(type('session'))).playerId, session.playerId);
    assert.equal((await resumed.next(phase('complete'))).room.ranking[0].score, 10);
    const attacker = await client(`ws://127.0.0.1:${app.http.address().port}/ws`); sockets.push(attacker.ws);
    attacker.send({type: 'resume', code: session.code, token: 'wrong-token'});
    assert.match((await attacker.next(type('error'))).message, /مفتاح/);
  } finally {
    for (const ws of sockets) ws.terminate(); await app.close();
    rmSync(directory, {recursive: true, force: true});
  }
});
