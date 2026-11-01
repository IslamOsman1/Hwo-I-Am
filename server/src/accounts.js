import {MongoClient} from 'mongodb';
import {randomBytes, scrypt, timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import sharp from 'sharp';
import {digest, normalize, playerName, GameError} from './game.js';

const derive = promisify(scrypt);
const DAY = 86400000;
const passwordOptions = {N: 65536, r: 8, p: 2, maxmem: 128 * 1024 * 1024};
class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function requireValue(ok, message, status = 400) { if (!ok) throw new ApiError(status, message); }
function text(value, max, label, optional = false) {
  requireValue(typeof value === 'string' && value.trim().length <= max && (optional || value.trim().length > 0), `${label}: اكتب من ${optional ? 0 : 1} لـ${max} حرف`);
  return value.trim();
}
function emailFor(value) {
  const email = text(value, 254, 'الإيميل').toLowerCase();
  requireValue(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'اكتب إيميل صحيح');
  return email;
}
function checkPassword(value) { requireValue(typeof value === 'string' && value.length >= 8 && value.length <= 128, 'الباسورد من ٨ لـ١٢٨ حرف'); }
async function passwordHash(value, salt = randomBytes(16).toString('hex')) {
  return {salt, hash: (await derive(value, salt, 32, passwordOptions)).toString('hex')};
}
async function passwordMatches(value, saved) {
  const calculated = await passwordHash(value, saved.salt);
  return timingSafeEqual(Buffer.from(calculated.hash, 'hex'), Buffer.from(saved.hash, 'hex'));
}
const publicUser = user => ({id: user._id, name: user.name, email: user.email,
  bio: user.bio, avatar: user.avatar, createdAt: user.createdAt, emailVerified: false,
  role: user.role === 'admin' ? 'admin' : 'member', friendCode: user.friendCode ?? user._id.toUpperCase()});
const friendProfile = user => ({id: user._id, name: user.name, avatar: user.avatar,
  friendCode: user.friendCode ?? user._id.toUpperCase()});
const summary = p => ({id: p._id, title: p.title, description: p.description, cover: p.cover,
  questionCount: p.questions.length, isPublic: p.isPublic, author: p.author,
  plays: p.plays, shareCode: p.shareCode, revision: p.revision, updatedAt: p.updatedAt});
const editable = p => ({...summary(p), questions: p.questions});
const newId = () => randomBytes(12).toString('hex');
let imageJobs = 0;

async function imageFor(value, dimension = 640) {
  if (value == null || value === '') return null;
  requireValue(typeof value === 'string' && value.length <= 600000, 'الصورة كبيرة؛ اختار صورة أصغر');
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  requireValue(match, 'اختار صورة JPG أو PNG أو WebP');
  requireValue(imageJobs < 2, 'معالجة الصور مشغولة لحظة؛ جرّب تاني', 503);
  imageJobs++;
  try {
    const bytes = await sharp(Buffer.from(match[2], 'base64'), {limitInputPixels: 16000000})
      .rotate().resize(dimension, dimension, {fit: 'inside', withoutEnlargement: true}).jpeg({quality: 68}).toBuffer();
    requireValue(bytes.length <= 180000, 'الصورة كبيرة؛ اختار صورة أبسط');
    return `data:image/jpeg;base64,${bytes.toString('base64')}`;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'الصورة غير مدعومة أو تالفة');
  } finally { imageJobs--; }
}
async function packFields(input) {
  requireValue(input && typeof input === 'object', 'بيانات الباقة مش صحيحة');
  const title = text(input.title, 68, 'اسم الباقة');
  const description = text(input.description ?? '', 300, 'الوصف', true);
  requireValue(Array.isArray(input.questions) && input.questions.length <= 1000, 'الباقة بحد أقصى ١٠٠٠ سؤال');
  requireValue(typeof input.isPublic === 'boolean', 'اختار خصوصية الباقة');
  requireValue(!input.isPublic || input.questions.length >= 13, 'النشر العام محتاج ١٣ سؤال على الأقل');
  const questions = [];
  const prompts = new Set();
  const ids = new Set();
  for (const value of input.questions) {
    requireValue(value && typeof value === 'object' && !Array.isArray(value), 'بيانات السؤال مش صحيحة');
    const prompt = text(value.prompt, 225, 'السؤال');
    requireValue(!prompts.has(normalize(prompt)), 'فيه سؤال متكرر في الباقة'); prompts.add(normalize(prompt));
    requireValue(Array.isArray(value.answers) && value.answers.length >= 1 && value.answers.length <= 10, 'اكتب إجابة أساسية وبحد أقصى ٩ بدائل');
    const answers = [...new Set(value.answers.map(a => text(a, 80, 'الإجابة')))];
    requireValue(answers.every(a => normalize(a).length > 0), 'الإجابة لازم تحتوي حروف أو أرقام');
    const id = typeof value.id === 'string' && /^[a-f0-9]{24}$/.test(value.id) ? value.id : newId();
    requireValue(!ids.has(id), 'معرّف سؤال متكرر؛ افتح الباقة من جديد'); ids.add(id);
    questions.push({id,
      prompt, answers, explanation: text(value.explanation ?? '', 300, 'التوضيح', true),
      image: await imageFor(value.image), category: 'باقة مخصصة', level: value.level === 'medium' ? 'medium' : 'easy'});
  }
  const result = {title, description, questions, isPublic: input.isPublic, cover: await imageFor(input.cover)};
  requireValue(Buffer.byteLength(JSON.stringify(result)) <= 3 * 1024 * 1024, 'حجم الباقة كبير؛ قلل عدد الصور أو حجمها');
  return result;
}
async function readBody(req) {
  requireValue(req.headers['content-type']?.startsWith('application/json'), 'الطلب لازم يكون JSON', 415);
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 6 * 1024 * 1024) throw new ApiError(413, 'حجم الطلب أكبر من المسموح');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw new ApiError(400, 'الطلب غير صحيح'); }
}

export class AccountApi {
  constructor(db, {now = Date.now} = {}) {
    this.db = db; this.now = now; this.limits = new Map(); this.hashes = 0;
    this.users = db.collection('users'); this.sessions = db.collection('sessions'); this.packs = db.collection('packs');
    this.friends = db.collection('friendships');
    this.invites = db.collection('game_invites');
  }
  async init() {
    await Promise.all([
      this.users.createIndex({email: 1}, {unique: true}),
      this.users.createIndex({friendCode: 1}, {unique: true, sparse: true}),
      this.friends.createIndex({members: 1, status: 1}),
      this.invites.createIndex({expiresAt: 1}, {expireAfterSeconds: 0}),
      this.invites.createIndex({toUserId: 1}),
      this.sessions.createIndex({expiresAt: 1}, {expireAfterSeconds: 0}),
      this.sessions.createIndex({userId: 1}),
      this.packs.createIndex({ownerId: 1, updatedAt: -1}),
      this.packs.createIndex({isPublic: 1, updatedAt: -1}),
      this.packs.createIndex({shareCode: 1}, {unique: true}),
    ]);
    return this;
  }
  rate(key, count, window = 60000) {
    const now = this.now();
    for (const [id, value] of this.limits) if (value.until <= now) this.limits.delete(id);
    const value = this.limits.get(key) ?? {count: 0, until: now + window};
    requireValue(++value.count <= count, 'محاولات كتير؛ استنى دقيقة وجرّب تاني', 429);
    this.limits.set(key, value);
  }
  async hashWork(work) {
    requireValue(this.hashes < 2, 'الدخول مشغول لحظة؛ جرّب تاني', 503);
    this.hashes++;
    try { return await work(); } finally { this.hashes--; }
  }
  async authenticate(token) {
    requireValue(typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token), 'سجّل دخولك الأول', 401);
    const session = await this.sessions.findOne({_id: digest(token), expiresAt: {$gt: new Date(this.now())}});
    const user = session && await this.users.findOne({_id: session.userId});
    requireValue(user, 'جلسة الدخول انتهت؛ ادخل تاني', 401);
    requireValue((session.version ?? 0) === (user.sessionVersion ?? 0), 'الباسورد اتغيّر؛ سجّل دخولك تاني', 401);
    return user;
  }
  requireAdmin(user) { requireValue(user.role === 'admin', 'إنشاء وتعديل الباقات للأدمن فقط', 403); }
  async bootstrapAdmin(email, password) {
    email = emailFor(email);
    let user = await this.users.findOne({email});
    if (user?.role === 'admin') return;
    checkPassword(password);
    if (user) {
      requireValue(await this.hashWork(() => passwordMatches(password, user.password)), 'Existing admin email has a different password', 403);
      await this.users.updateOne({_id: user._id}, {$set: {role: 'admin'}});
    } else {
      user = {_id: newId(), email, password: await this.hashWork(() => passwordHash(password)), name: 'Fouad Osman', bio: '', avatar: null, role: 'admin', friendCode: randomBytes(6).toString('hex').toUpperCase(), createdAt: this.now()};
      await this.users.insertOne(user);
    }
  }
  pair(a, b) { return [a, b].sort().join(':'); }
  async areFriends(a, b) { return !!await this.friends.findOne({_id: this.pair(a, b), status: 'accepted'}); }
  async roomAccess(input, user) {
    const mode = input?.mode ?? 'anyone';
    requireValue(['anyone', 'friends', 'invite'].includes(mode), 'اختار مين يقدر يدخل الغرفة');
    requireValue(mode === 'anyone' || user, 'سجّل دخولك عشان تحدد دخول الأصدقاء', 401);
    requireValue(input?.invitedIds == null || Array.isArray(input.invitedIds), 'قائمة الدعوات غير صحيحة');
    const invitedIds = [...new Set(input?.invitedIds ?? [])];
    requireValue(invitedIds.length <= 100 && invitedIds.every(id => typeof id === 'string' && /^[a-f0-9]{24}$/.test(id)), 'قائمة الدعوات غير صحيحة');
    for (const id of invitedIds) requireValue(user && await this.areFriends(user._id, id), 'الدعوة لازم تكون لصديق مقبول عندك');
    return {mode, hostAccountId: user?._id ?? null, invitedIds};
  }
  async allowJoin(room, user) {
    const access = room.access;
    if (!access || access.mode === 'anyone') return;
    requireValue(user, 'الغرفة دي محتاجة تسجيل دخول', 401);
    if (access.mode === 'friends') requireValue(await this.areFriends(access.hostAccountId, user._id), 'الغرفة متاحة لأصدقاء صاحبها فقط', 403);
    if (access.mode === 'invite') requireValue(access.invitedIds.includes(user._id), 'صاحب الغرفة لازم يبعت لك دعوة الأول', 403);
  }
  async invite(room, from, to) {
    await this.invites.updateOne({_id: `${room.code}:${to}`}, {$set: {toUserId: to, roomCode: room.code,
      title: room.pack?.title ?? 'تحدي المعلومات', fromName: from.name, fromAvatar: from.avatar,
      expiresAt: new Date(this.now() + 2 * 60 * 60000)}}, {upsert: true});
  }
  async newSession(user) {
    const token = randomBytes(32).toString('base64url');
    await this.sessions.insertOne({_id: digest(token), userId: user._id, version: user.sessionVersion ?? 0, createdAt: new Date(this.now()), expiresAt: new Date(this.now() + 30 * DAY)});
    const old = await this.sessions.find({userId: user._id}).sort({createdAt: -1}).skip(10).project({_id: 1}).toArray();
    if (old.length) await this.sessions.deleteMany({_id: {$in: old.map(s => s._id)}});
    return {token, user: publicUser(user)};
  }
  async packForGame(id, token) {
    requireValue(typeof id === 'string' && /^[a-f0-9]{24}$/.test(id), 'الباقة غير موجودة', 404);
    const pack = await this.packs.findOne({_id: id});
    requireValue(pack, 'الباقة غير موجودة', 404);
    if (!pack.isPublic) {
      const user = await this.authenticate(token);
      requireValue(pack.ownerId === user._id, 'الباقة دي خاصة بصاحبها', 403);
    }
    requireValue(pack.questions.length > 0, 'ضيف سؤال واحد على الأقل قبل اللعب');
    return {bank: pack.questions.map(q => ({...q, id: `${pack._id}-${q.id}`})), pack: {id: pack._id, title: pack.title, description: pack.description, author: pack.author, cover: pack.cover, questionCount: pack.questions.length, plays: pack.plays}};
  }
  async played(id) { await this.packs.updateOne({_id: id}, {$inc: {plays: 1}}); }
  async handle(req, res) {
    const send = (status, value) => { res.statusCode = status; res.end(JSON.stringify(value)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      const route = url.pathname;
      const method = req.method;
      const token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization ?? '')?.[1];
      const ip = process.env.RENDER ? String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress).split(',').at(-1).trim() : req.socket.remoteAddress;
      this.rate(`ip:${ip}`, 120);
      if (method === 'POST' && ['/api/auth/register', '/api/auth/login'].includes(route)) {
        this.rate(`auth:${ip}`, 20);
        const input = await readBody(req);
        const email = emailFor(input.email); checkPassword(input.password);
        this.rate(`email:${digest(email)}`, 10);
        if (route.endsWith('register')) {
          const name = playerName(input.name);
          const password = await this.hashWork(() => passwordHash(input.password));
          const user = {_id: newId(), email, password, name, bio: '', avatar: null, role: 'member', friendCode: randomBytes(6).toString('hex').toUpperCase(), createdAt: this.now()};
          try { await this.users.insertOne(user); }
          catch (error) { if (error.code === 11000) throw new ApiError(409, 'الإيميل ده مسجّل بالفعل؛ جرّب تسجيل الدخول'); throw error; }
          send(201, await this.newSession(user)); return;
        }
        const user = await this.users.findOne({email});
        const correct = await this.hashWork(() => passwordMatches(input.password, user?.password ?? {salt: 'invalid-account-dummy-salt', hash: '0'.repeat(64)}));
        requireValue(user && correct, 'الإيميل أو الباسورد مش صحيح', 401);
        send(200, await this.newSession(user)); return;
      }
      if (route === '/api/auth/logout' && method === 'POST') {
        if (token) await this.sessions.deleteOne({_id: digest(token)});
        send(200, {ok: true}); return;
      }
      if (route === '/api/me') {
        const user = await this.authenticate(token);
        if (method === 'GET') { send(200, {user: publicUser(user)}); return; }
        if (method === 'PUT') {
          const input = await readBody(req);
          const changes = {name: playerName(input.name), bio: text(input.bio ?? '', 160, 'نبذة', true), avatar: await imageFor(input.avatar, 128)};
          await this.users.updateOne({_id: user._id}, {$set: changes});
          send(200, {user: publicUser({...user, ...changes})}); return;
        }
      }
      if (route === '/api/me/password' && method === 'PUT') {
        const user = await this.authenticate(token); this.rate(`password:${user._id}`, 5);
        const input = await readBody(req); checkPassword(input.password); checkPassword(input.currentPassword);
        const correct = await this.hashWork(() => passwordMatches(input.currentPassword, user.password));
        requireValue(correct, 'الباسورد الحالي مش صحيح', 403);
        const password = await this.hashWork(() => passwordHash(input.password));
        // Compare-and-swap prevents a stale simultaneous password change.
        const updated = await this.users.updateOne({_id: user._id, 'password.hash': user.password.hash}, {$set: {password}, $inc: {sessionVersion: 1}});
        requireValue(updated.modifiedCount === 1, 'الحساب اتحدث؛ سجّل دخولك تاني', 409);
        const version = (user.sessionVersion ?? 0) + 1;
        await this.sessions.deleteMany({userId: user._id, version: {$ne: version}});
        send(200, await this.newSession({...user, password, sessionVersion: version})); return;
      }
      if (route === '/api/people' && method === 'GET') {
        const user = await this.authenticate(token);
        const q = text(url.searchParams.get('q') ?? '', 68, 'البحث');
        requireValue(q.length >= 2, 'اكتب حرفين على الأقل للبحث');
        const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const people = await this.users.find({_id: {$ne: user._id}, $or: [{name: {$regex: escaped, $options: 'i'}}, {friendCode: q.toUpperCase()}, {_id: q.toLowerCase()}]}).project({password: 0, email: 0}).limit(20).toArray();
        const relations = await this.friends.find({members: user._id}).toArray();
        send(200, {people: people.map(p => {
          const relation = relations.find(r => r.members.includes(p._id));
          return {...friendProfile(p), relationship: !relation ? 'none' : relation.status === 'accepted' ? 'friends' : relation.requestedBy === user._id ? 'outgoing' : 'incoming'};
        })}); return;
      }
      if (route === '/api/friends' && method === 'GET') {
        const user = await this.authenticate(token);
        const relations = await this.friends.find({members: user._id}).limit(1000).toArray();
        const otherIds = relations.map(r => r.members.find(id => id !== user._id));
        const people = await this.users.find({_id: {$in: otherIds}}).project({password: 0, email: 0}).toArray();
        const result = {friends: [], incoming: [], outgoing: [], invitations: await this.invites.find({toUserId: user._id, expiresAt: {$gt: new Date(this.now())}}).project({_id: 0, toUserId: 0}).limit(30).toArray()};
        for (const relation of relations) {
          const person = people.find(p => relation.members.includes(p._id));
          if (!person) continue;
          const group = relation.status === 'accepted' ? 'friends' : relation.requestedBy === user._id ? 'outgoing' : 'incoming';
          result[group].push(friendProfile(person));
        }
        send(200, result); return;
      }
      const friendRoute = /^\/api\/friends\/([a-f0-9]{24})$/.exec(route);
      if (friendRoute && method === 'POST') {
        const user = await this.authenticate(token); this.rate(`friend:${user._id}`, 30);
        const other = friendRoute[1]; requireValue(other !== user._id, 'مينفعش تضيف نفسك');
        requireValue(await this.users.findOne({_id: other}), 'الشخص مش موجود', 404);
        const input = await readBody(req);
        const pair = this.pair(user._id, other);
        if (input.action === 'request') {
          requireValue(await this.friends.countDocuments({members: user._id}) < 500, 'وصلت للحد الحالي لقائمة الأصدقاء');
          requireValue(await this.friends.countDocuments({members: other}) < 500, 'قائمة طلبات الشخص ده ممتلئة حاليًا');
          const relation = await this.friends.findOneAndUpdate({_id: pair}, {$setOnInsert: {members: [user._id, other], requestedBy: user._id, status: 'pending', createdAt: this.now()}}, {upsert: true, returnDocument: 'after'});
          requireValue(relation.status !== 'accepted', 'إنتوا أصدقاء بالفعل', 409);
          requireValue(relation.requestedBy === user._id, 'عندك طلب من الشخص ده؛ تقدر تقبله', 409);
        } else if (input.action === 'accept') {
          const result = await this.friends.updateOne({_id: pair, status: 'pending', requestedBy: other}, {$set: {status: 'accepted', acceptedAt: this.now()}});
          requireValue(result.modifiedCount === 1, 'مفيش طلب وارد نقدر نقبله', 409);
        } else {
          requireValue(['decline', 'cancel', 'remove'].includes(input.action), 'طلب صداقة غير صحيح');
          const filter = {_id: pair, status: input.action === 'remove' ? 'accepted' : 'pending'};
          if (input.action !== 'remove') filter.requestedBy = input.action === 'cancel' ? user._id : other;
          requireValue((await this.friends.deleteOne(filter)).deletedCount === 1, 'الطلب اتغيّر؛ حدّث القائمة', 409);
        }
        send(200, {ok: true}); return;
      }
      if (route === '/api/packs' && method === 'GET') {
        const mine = url.searchParams.get('scope') === 'mine';
        const user = mine ? await this.authenticate(token) : null;
        const q = (url.searchParams.get('q') ?? '').trim().slice(0, 68);
        const filter = mine ? {ownerId: user._id} : {isPublic: true};
        if (q) filter.$or = [{title: {$regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i'}}, {shareCode: q.toUpperCase()}];
        const page = Math.max(0, Math.min(1000, Number(url.searchParams.get('page')) || 0));
        const packs = await this.packs.find(filter).sort({updatedAt: -1}).skip(page * 20).limit(21).toArray();
        send(200, {packs: packs.slice(0, 20).map(summary), hasMore: packs.length > 20}); return;
      }
      if (route === '/api/packs' && method === 'POST') {
        const user = await this.authenticate(token); this.rate(`save:${user._id}`, 20);
        this.requireAdmin(user);
        requireValue(await this.packs.countDocuments({ownerId: user._id}) < 20, 'الحد الحالي ٢٠ باقة للحساب');
        const fields = await packFields(await readBody(req));
        const pack = {...fields, _id: newId(), ownerId: user._id, author: user.name,
          shareCode: randomBytes(6).toString('hex').toUpperCase(), plays: 0, revision: 1, updatedAt: this.now(), createdAt: this.now()};
        await this.packs.insertOne(pack); send(201, {pack: editable(pack)}); return;
      }
      const match = /^\/api\/packs\/([a-f0-9]{24})$/.exec(route);
      if (match) {
        const user = await this.authenticate(token);
        const pack = await this.packs.findOne({_id: match[1], ownerId: user._id});
        requireValue(pack, 'الباقة مش موجودة أو مش من إنشاءك', 404);
        if (method === 'GET') { send(200, {pack: editable(pack)}); return; }
        if (method === 'PUT') {
          this.requireAdmin(user);
          this.rate(`save:${user._id}`, 20);
          const input = await readBody(req); const fields = await packFields(input);
          requireValue(Number.isInteger(input.revision), 'نسخة الباقة غير صحيحة');
          const updated = await this.packs.findOneAndUpdate({_id: pack._id, ownerId: user._id, revision: input.revision},
            {$set: {...fields, author: user.name, updatedAt: this.now()}, $inc: {revision: 1}}, {returnDocument: 'after'});
          requireValue(updated, 'الباقة اتعدلت من جهاز تاني؛ ارجع وافتح النسخة الجديدة', 409);
          send(200, {pack: editable(updated)}); return;
        }
      }
      throw new ApiError(404, 'الطلب مش موجود');
    } catch (error) {
      if (error instanceof GameError) error.status = 400;
      if (!res.destroyed && !res.writableEnded) send(error.status ?? 500, {error: error.status ? error.message : 'حصلت مشكلة؛ جرّب تاني بعد شوية'});
      if (!error.status) console.error('Account operation failed:', error.name);
    }
  }
}

export async function connectAccounts(uri, name = 'menana') {
  const client = new MongoClient(uri, {maxPoolSize: 8, serverSelectionTimeoutMS: 15000, appName: 'MenAna'});
  try {
    await client.connect();
    const api = await new AccountApi(client.db(name)).init();
    if (process.env.ADMIN_EMAIL) await api.bootstrapAdmin(process.env.ADMIN_EMAIL, process.env.ADMIN_BOOTSTRAP_PASSWORD);
    return {api, close: () => client.close()};
  } catch (error) { await client.close(); throw error; }
}
