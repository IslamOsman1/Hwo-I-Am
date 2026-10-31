import {createServer} from 'node:http';
import {randomInt, timingSafeEqual} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {WebSocketServer, WebSocket} from 'ws';
import {RoomStore} from './store.js';
import {iceConfig} from './ice.js';
import {GameError, check, digest, createRoom, joinRoom, command, advanceClock, publicRoom} from './game.js';

export function startServer({port = Number(process.env.PORT || 3000), dataDir = process.env.DATA_DIR || './storage', now = Date.now} = {}) {
  const bank = JSON.parse(readFileSync(fileURLToPath(new URL('../data/questions.json', import.meta.url)), 'utf8'));
  const store = new RoomStore(dataDir);
  const peers = new Map();
  const ipLimits = new Map();
  const send = (ws, value) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };
  const online = code => new Set([...(peers.get(code)?.keys() ?? [])]);
  const broadcast = code => {
    const room = store.rooms.get(code);
    if (!room) return;
    for (const [id, ws] of peers.get(code) ?? []) send(ws, {type: 'state', room: publicRoom(room, id, bank, online(code), now())});
  };
  function iceFor(id) {
    return iceConfig(id, now());
  }
  const http = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.url === '/health') { res.end(JSON.stringify({ok: true, version: '2.0.0', questions: bank.length})); return; }
    res.statusCode = 404; res.end('{"error":"Not found"}');
  });
  const wss = new WebSocketServer({noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false});
  http.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws') { socket.destroy(); return; }
    const ip = req.socket.remoteAddress;
    const bucket = ipLimits.get(ip) ?? {at: now(), count: 0};
    if (now() - bucket.at > 60000) { bucket.at = now(); bucket.count = 0; }
    ipLimits.set(ip, bucket);
    if (++bucket.count > 60 || wss.clients.size >= 1000) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    ws.alive = true; ws.identity = null; ws.window = {at: now(), count: 0};
    const authTimer = setTimeout(() => { if (!ws.identity) ws.close(4001, 'Authentication timeout'); }, 15000);
    ws.on('pong', () => { ws.alive = true; });
    const attach = (room, id, token) => {
      if (!peers.has(room.code)) peers.set(room.code, new Map());
      const old = peers.get(room.code).get(id);
      peers.get(room.code).set(id, ws); ws.identity = {code: room.code, id};
      old?.close(4002, 'Session resumed elsewhere'); clearTimeout(authTimer);
      send(ws, {type: 'session', code: room.code, playerId: id, ...(token ? {token} : {}), ...iceFor(id)});
      broadcast(room.code);
    };
    ws.on('message', bytes => {
      try {
        if (now() - ws.window.at >= 10000) ws.window = {at: now(), count: 0};
        check(++ws.window.count <= 150, 'طلبات كتير؛ استنى شوية');
        const message = JSON.parse(bytes.toString());
        check(message && typeof message.type === 'string', 'طلب مش صحيح');
        if (message.type === 'ping') { send(ws, {type: 'pong', sentAt: message.sentAt, serverNow: now()}); return; }
        if (!ws.identity) {
          if (message.type === 'create') {
            check(store.rooms.size < 2000, 'السيرفر مشغول؛ جرّب بعد شوية');
            let code;
            do { code = String(randomInt(100000, 1000000)); } while (store.rooms.has(code));
            const {room, token} = createRoom(code, message.name, message.settings, bank, now());
            store.save(room); attach(room, room.hostId, token); return;
          }
          const code = String(message.code ?? '').trim();
          const saved = store.rooms.get(code); check(saved, 'كود الغرفة مش موجود أو انتهت صلاحيته');
          if (message.type === 'join') {
            const room = structuredClone(saved);
            const {player, token} = joinRoom(room, message.name, now());
            store.save(room); attach(room, player.id, token); return;
          }
          if (message.type === 'resume') {
            check(typeof message.token === 'string' && message.token.length <= 100, 'بيانات الرجوع مش صحيحة');
            const hash = digest(message.token);
            const player = saved.players.find(p => timingSafeEqual(Buffer.from(hash), Buffer.from(p.tokenHash)));
            check(player, 'مفتاح الرجوع للغرفة مش صحيح'); attach(saved, player.id); return;
          }
          throw new GameError('ادخل أو أنشئ غرفة الأول');
        }
        const {code, id} = ws.identity;
        if (message.type === 'signal') {
          check(message.signal && typeof message.signal === 'object' && JSON.stringify(message.signal).length <= 60000, 'بيانات اتصال مش صحيحة');
          for (const [otherId, peer] of peers.get(code) ?? []) if (otherId !== id) send(peer, {type: 'signal', from: id, signal: message.signal});
          return;
        }
        if (message.type === 'leave') {
          // Keep both seats reserved so either player can resume from the same phone.
          ws.close(1000, 'Left room'); return;
        }
        let room = structuredClone(store.rooms.get(code));
        if (advanceClock(room, bank, now())) { room.revision++; store.save(room); broadcast(code); room = structuredClone(room); }
        command(room, id, message, bank, now(), online(code));
        room.revision++; store.save(room); broadcast(code);
      } catch (error) {
        if (!(error instanceof GameError) && !(error instanceof SyntaxError)) console.error('Room operation failed:', error.message);
        send(ws, {type: 'error', message: error instanceof GameError ? error.message : 'حصلت مشكلة في الطلب؛ جرّب تاني'});
      }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      clearTimeout(authTimer);
      if (!ws.identity) return;
      const {code, id} = ws.identity;
      if (peers.get(code)?.get(id) !== ws) return;
      peers.get(code).delete(id);
      if (!peers.get(code).size) peers.delete(code);
      broadcast(code);
    });
  });
  const clock = setInterval(() => {
    try {
      for (const saved of store.rooms.values()) {
        if (!['question', 'countdown'].includes(saved.phase)) continue;
        const room = structuredClone(saved);
        if (advanceClock(room, bank, now())) { room.revision++; store.save(room); broadcast(room.code); }
      }
    } catch (error) { console.error('Clock commit failed:', error.message); }
  }, 100);
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; ws.ping(); }
    for (const [ip, bucket] of ipLimits) if (now() - bucket.at > 120000) ipLimits.delete(ip);
    try { store.clean(now()); } catch (error) { console.error('Cleanup failed:', error.message); }
  }, 30000);
  http.listen(port, '0.0.0.0');
  const close = async () => {
    clearInterval(clock); clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => http.close(resolve));
  };
  return {http, wss, store, bank, close};
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const app = startServer();
  app.http.on('listening', () => console.log(`MenAna trivia listening on ${app.http.address().port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { await app.close(); process.exit(0); });
}
