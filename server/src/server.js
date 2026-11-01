import {createServer} from 'node:http';
import {randomInt, timingSafeEqual} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {WebSocketServer, WebSocket} from 'ws';
import {RoomStore} from './store.js';
import {iceConfig} from './ice.js';
import {connectAccounts} from './accounts.js';
import {flagBank, flagPack} from './flag_game.js';
import {GameError, check, digest, createRoom, joinRoom, command, advanceClock, publicRoom} from './game.js';

export function startServer({port = Number(process.env.PORT || 3000), dataDir = process.env.DATA_DIR || './storage', now = Date.now, accountApi = null} = {}) {
  const bank = JSON.parse(readFileSync(fileURLToPath(new URL('../data/questions.json', import.meta.url)), 'utf8'));
  const store = new RoomStore(dataDir);
  const peers = new Map();
  const ipLimits = new Map();
  const send = (ws, value) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };
  const online = code => new Set([...(peers.get(code)?.keys() ?? [])]);
  const bankFor = room => room.customBank ?? (room.gameId === 'flags' ? flagBank : bank);
  const broadcast = code => {
    const room = store.rooms.get(code);
    if (!room) return;
    for (const [id, ws] of peers.get(code) ?? []) send(ws, {type: 'state', room: publicRoom(room, id, bankFor(room), online(code), now())});
  };
  function iceFor(id) {
    return iceConfig(id, now());
  }
  const http = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.url === '/health') { res.end(JSON.stringify({ok: true, version: '4.2.0', flags: flagBank.length, questions: bank.length, accounts: !!accountApi})); return; }
    if (req.url?.startsWith('/api/')) {
      if (accountApi) { void accountApi.handle(req, res); return; }
      res.statusCode = 503; res.end(JSON.stringify({error: 'الحسابات قيد التجهيز؛ جرّب بعد شوية'})); return;
    }
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
    let work = Promise.resolve();
    let queued = 0;
    ws.on('message', bytes => {
      if (++queued > 32) { ws.close(1008, 'Too many pending requests'); return; }
      work = work.then(async () => {
      if (ws.readyState !== WebSocket.OPEN) return;
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
            const user = message.accountToken && accountApi ? await accountApi.authenticate(message.accountToken) : null;
            check(!message.gameId || message.gameId === 'flags', 'اللعبة مش متاحة');
            check(!(message.gameId && message.packId), 'اختار لعبة واحدة');
            let custom;
            if (message.packId) {
              check(accountApi, 'الباقات قيد التجهيز');
              custom = await accountApi.packForGame(message.packId, message.accountToken);
              check([...store.rooms.values()].filter(r => r.customBank).length < 100, 'غرف الباقات مشغولة دلوقتي؛ جرّب لاحقًا');
            }
            const flags = message.gameId === 'flags';
            const chosenBank = custom?.bank ?? (flags ? flagBank : bank);
            const settings = custom ? {...message.settings, categories: ['باقة مخصصة'], level: 'mixed'} : flags ? {...message.settings, categories: ['أعلام الدول'], level: 'mixed'} : message.settings;
            const {room, token} = createRoom(code, user?.name ?? message.name, settings, chosenBank, now());
            if (accountApi) room.access = await accountApi.roomAccess(message.access, user);
            else check(!message.access || message.access.mode === 'anyone', 'سجّل دخولك عشان تستخدم خصوصية الغرفة');
            if (user) { room.players[0].accountId = user._id; room.players[0].avatar = user.avatar; }
            if (custom) { room.customBank = chosenBank; room.pack = custom.pack; }
            if (flags) { room.gameId = 'flags'; room.pack = flagPack; }
            store.save(room); attach(room, room.hostId, token); return;
          }
          const code = String(message.code ?? '').trim();
          const saved = store.rooms.get(code); check(saved, 'كود الغرفة مش موجود أو انتهت صلاحيته');
          if (message.type === 'join') {
            const room = structuredClone(saved);
            const user = message.accountToken && accountApi ? await accountApi.authenticate(message.accountToken) : null;
            if (accountApi) await accountApi.allowJoin(room, user);
            const {player, token} = joinRoom(room, user?.name ?? message.name, now());
            if (user) { player.accountId = user._id; player.avatar = user.avatar; }
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
        if (message.type === 'invite') {
          const room = structuredClone(store.rooms.get(code));
          check(accountApi && room.hostId === id && room.phase === 'lobby' && room.players.length < 2, 'صاحب الغرفة بس يقدر يدعو صديق وفيه مكان قبل البداية');
          const user = await accountApi.authenticate(message.accountToken);
          accountApi.rate(`invite:${user._id}`, 10);
          check(room.access?.hostAccountId === user._id, 'الدعوة من حساب صاحب الغرفة فقط');
          check(typeof message.friendId === 'string' && await accountApi.areFriends(user._id, message.friendId), 'اختار صديق مقبول عندك');
          check(room.access.invitedIds.includes(message.friendId) || room.access.invitedIds.length < 100, 'وصلت للحد الأقصى للدعوات');
          if (!room.access.invitedIds.includes(message.friendId)) room.access.invitedIds.push(message.friendId);
          await accountApi.invite(room, user, message.friendId);
          room.revision++; room.updatedAt = now(); store.save(room); broadcast(code); return;
        }
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
        const activeBank = bankFor(room);
        if (advanceClock(room, activeBank, now())) { room.revision++; store.save(room); broadcast(code); room = structuredClone(room); }
        command(room, id, message, activeBank, now(), online(code));
        if (message.type === 'start' && room.pack && !room.gameId && accountApi) {
          void accountApi.played(room.pack.id).catch(() => console.error('Pack play count update failed'));
        }
        room.revision++; store.save(room); broadcast(code);
      } catch (error) {
        if (!(error instanceof GameError) && !(error instanceof SyntaxError)) console.error('Room operation failed:', error.message);
        send(ws, {type: 'error', message: error instanceof GameError || error.status ? error.message : 'حصلت مشكلة في الطلب؛ جرّب تاني'});
      }
    }).catch(() => { ws.close(1011, 'Operation failed'); }).finally(() => { queued--; }); });
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
        if (saved.phase === 'countdown' ? now() < saved.startsAt : now() < saved.deadline) continue;
        const room = structuredClone(saved);
        if (advanceClock(room, bankFor(room), now())) { room.revision++; store.save(room); broadcast(room.code); }
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
  const accounts = process.env.MONGODB_URI ? await connectAccounts(process.env.MONGODB_URI, process.env.MONGODB_DB || 'menana') : null;
  const app = startServer({accountApi: accounts?.api});
  app.http.on('listening', () => console.log(`MenAna trivia listening on ${app.http.address().port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { await app.close(); await accounts?.close(); process.exit(0); });
}
