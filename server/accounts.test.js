import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MongoMemoryServer} from 'mongodb-memory-server-core';
import {connectAccounts} from './src/accounts.js';
import {startServer} from './src/server.js';
import WebSocket from 'ws';
import sharp from 'sharp';

async function peer(url, sockets) {
  const ws = new WebSocket(url); sockets.push(ws);
  const inbox = []; const waiting = [];
  ws.on('message', bytes => {
    const data = JSON.parse(bytes);
    const index = waiting.findIndex(w => w.predicate(data));
    if (index < 0) inbox.push(data);
    else { const item = waiting.splice(index, 1)[0]; clearTimeout(item.timer); item.resolve(data); }
  });
  await once(ws, 'open');
  return {send: data => ws.send(JSON.stringify(data)), next(predicate) {
    const index = inbox.findIndex(predicate);
    if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
    return new Promise((resolve, reject) => { waiting.push({predicate, resolve, timer: setTimeout(() => reject(new Error('Custom room response timeout')), 5000)}); });
  }};
}

test('real MongoDB accounts, profiles, sessions, pack ownership, publishing and durable reconnect', {timeout: 240000}, async () => {
  const mongo = await MongoMemoryServer.create();
  const accounts = await connectAccounts(mongo.getUri(), 'menana_test');
  const directory = mkdtempSync(join(tmpdir(), 'menana-account-test-'));
  let time = Date.now(); const sockets = [];
  const app = startServer({port: 0, dataDir: directory, accountApi: accounts.api, now: () => time});
  await once(app.http, 'listening');
  const base = `http://127.0.0.1:${app.http.address().port}`;
  async function request(path, method = 'GET', body, token) {
    const response = await fetch(base + path, {method, headers: {'Content-Type': 'application/json', ...(token ? {Authorization: `Bearer ${token}`} : {})}, ...(body ? {body: JSON.stringify(body)} : {})});
    return {status: response.status, ...await response.json()};
  }
  try {
    const a = await request('/api/auth/register', 'POST', {email: 'a@example.test', password: 'test-password-123', name: 'أحمد'});
    const b = await request('/api/auth/register', 'POST', {email: 'b@example.test', password: 'another-password-123', name: 'منى'});
    assert.equal(a.status, 201); assert.equal(b.status, 201);
    assert.equal(a.user.name, 'أحمد'); assert.ok(!a.user.password);
    const raw = await accounts.api.users.findOne({email: 'a@example.test'});
    assert.ok(raw.password.hash && raw.password.salt); assert.ok(!JSON.stringify(raw).includes('test-password-123'));
    assert.equal((await request('/api/auth/login', 'POST', {email: 'a@example.test', password: 'wrong-password'})).status, 401);
    assert.equal((await request('/api/auth/login', 'POST', {email: {$ne: ''}, password: 'test-password-123'})).status, 400);
    assert.equal((await request('/api/me')).status, 401);
    const image = 'data:image/png;base64,' + (await sharp({create: {width: 256, height: 256, channels: 3, background: '#503080'}}).png().toBuffer()).toString('base64');
    const profile = await request('/api/me', 'PUT', {name: 'أحمد الجديد', bio: 'بحب الأسئلة', avatar: image}, a.token);
    assert.equal(profile.user.name, 'أحمد الجديد');
    assert.ok(profile.user.avatar.startsWith('data:image/jpeg;base64,'));
    assert.equal((await sharp(Buffer.from(profile.user.avatar.split(',')[1], 'base64')).metadata()).width, 128);
    assert.equal((await request('/api/me', 'PUT', {name: 'أحمد', avatar: 'data:image/png;base64,AAAA'}, a.token)).status, 400);
    const draft = await request('/api/packs', 'POST', {title: 'باقة خاصة', description: 'تجربة', isPublic: false, cover: image, questions: [{prompt: 'عاصمة مصر؟', answers: ['القاهرة', 'قاهرة'], image}]}, a.token);
    assert.equal(draft.status, 201);
    assert.equal((await request('/api/packs')).packs.length, 0);
    assert.equal((await request(`/api/packs/${draft.pack.id}`, 'GET', null, b.token)).status, 404);
    await assert.rejects(accounts.api.packForGame(draft.pack.id, b.token), /خاصة/);
    const custom = await accounts.api.packForGame(draft.pack.id, a.token);
    assert.equal(custom.bank[0].answers.length, 2);
    const host = await peer(base.replace('http:', 'ws:') + '/ws', sockets);
    host.send({type: 'create', name: 'ignored', accountToken: a.token, packId: draft.pack.id, settings: {rounds: 1, questionsPerRound: 1, seconds: 20, halfWhenBothCorrect: true}});
    const session = await host.next(x => x.type === 'session');
    const lobby = (await host.next(x => x.type === 'state')).room;
    assert.equal(lobby.players[0].name, 'أحمد الجديد'); assert.equal(lobby.pack.title, 'باقة خاصة');
    const guest = await peer(base.replace('http:', 'ws:') + '/ws', sockets);
    guest.send({type: 'join', code: session.code, name: 'ignored', accountToken: b.token});
    await guest.next(x => x.type === 'session');
    host.send({type: 'ready', ready: true}); guest.send({type: 'ready', ready: true});
    await host.next(x => x.type === 'state' && x.room.players.length === 2 && x.room.players.every(p => p.ready));
    host.send({type: 'start', index: -1}); await host.next(x => x.type === 'state' && x.room.phase === 'countdown');
    time += 3000;
    const current = (await host.next(x => x.type === 'state' && x.room.phase === 'question')).room;
    assert.equal(current.question.prompt, 'عاصمة مصر؟'); assert.ok(!current.question.answers); assert.ok(!current.customBank);
    assert.ok(current.question.image.startsWith('data:image/jpeg;base64,'));
    assert.ok(current.players[0].avatar.startsWith('data:image/jpeg;base64,'));
    time += 1000; host.send({type: 'answer', index: 0, text: 'قاهرة'});
    const hidden = (await guest.next(x => x.type === 'state' && x.room.submitted.length === 1)).room;
    assert.equal(hidden.ownAnswer, null); assert.equal(hidden.history.length, 0);
    time += 1000; guest.send({type: 'answer', index: 0, text: 'القاهرة'});
    const result = (await host.next(x => x.type === 'state' && x.room.phase === 'review')).room;
    assert.deepEqual(result.ranking.map(p => p.score), [10, 10]);
    assert.equal(result.history[0].answer, 'القاهرة');
    const publish = {...draft.pack, isPublic: true};
    assert.equal((await request(`/api/packs/${draft.pack.id}`, 'PUT', publish, a.token)).status, 400);
    publish.questions = Array.from({length: 13}, (_, i) => ({prompt: `سؤال ${i}`, answers: [`إجابة ${i}`]}));
    const saved = await request(`/api/packs/${draft.pack.id}`, 'PUT', publish, a.token);
    assert.equal(saved.status, 200); assert.equal(saved.pack.revision, 2);
    assert.equal((await request(`/api/packs/${draft.pack.id}`, 'PUT', publish, a.token)).status, 409);
    const catalog = await request('/api/packs');
    assert.equal(catalog.packs.length, 1); assert.equal(catalog.packs[0].questionCount, 13);
    assert.ok(!('questions' in catalog.packs[0]));
    assert.equal((await request('/api/packs?q=' + encodeURIComponent('.*'))).packs.length, 0);
    assert.equal((await accounts.api.packForGame(draft.pack.id)).bank.length, 13);
    const reconnect = await connectAccounts(mongo.getUri(), 'menana_test');
    try { assert.equal((await reconnect.api.authenticate(a.token)).name, 'أحمد الجديد'); }
    finally { await reconnect.close(); }
    const changed = await request('/api/me/password', 'PUT', {currentPassword: 'test-password-123', password: 'new-password-123'}, a.token);
    assert.equal(changed.status, 200);
    assert.equal((await request('/api/me', 'GET', null, a.token)).status, 401);
    assert.equal((await request('/api/me', 'GET', null, changed.token)).status, 200);
    await request('/api/auth/logout', 'POST', {}, changed.token);
    assert.equal((await request('/api/me', 'GET', null, changed.token)).status, 401);
  } finally {
    for (const socket of sockets) socket.terminate();
    await app.close(); await accounts.close(); await mongo.stop(); rmSync(directory, {recursive: true, force: true});
  }
});
