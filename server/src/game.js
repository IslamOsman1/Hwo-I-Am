import {randomBytes, randomInt, createHash} from 'node:crypto';

export class GameError extends Error {}
export const check = (ok, message) => { if (!ok) throw new GameError(message); };
export const digest = value => createHash('sha256').update(value).digest('hex');
export function normalize(value) {
  return String(value).normalize('NFKC').toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي').replace(/[٠-٩]/g, x => String(x.charCodeAt(0) - 1632))
    .replace(/[۰-۹]/g, x => String(x.charCodeAt(0) - 1776))
    .replace(/[^\p{L}\p{N}]/gu, '');
}
function integer(value, min, max, label) {
  check(Number.isInteger(value) && value >= min && value <= max, `${label}: من ${min} لـ${max}`);
  return value;
}
export function playerName(value) {
  check(typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 24, 'اكتب اسم من حرف لـ٢٤ حرف');
  return value.trim();
}
export function settingsFor(input, bank) {
  check(input && typeof input === 'object', 'إعدادات الغرفة مش كاملة');
  const categories = [...new Set(input.categories ?? [])];
  const known = new Set(bank.map(q => q.category));
  check(categories.length > 0 && categories.every(c => known.has(c)), 'اختار مجال واحد على الأقل');
  check(['easy', 'medium', 'mixed'].includes(input.level), 'اختار مستوى صحيح');
  check(typeof input.halfWhenBothCorrect === 'boolean', 'اختار نظام النقاط');
  const settings = {
    rounds: integer(input.rounds, 1, 20, 'الجولات'),
    questionsPerRound: integer(input.questionsPerRound, 1, 100, 'أسئلة الجولة'),
    seconds: integer(input.seconds, 5, 120, 'وقت الإجابة بالثواني'),
    halfWhenBothCorrect: input.halfWhenBothCorrect, level: input.level, categories,
  };
  const available = eligible(bank, settings).length;
  check(available >= settings.questionsPerRound, `المجالات والمستوى دول فيهم ${available} سؤال مختلف؛ قلل أسئلة الجولة أو زوّد المجالات`);
  return settings;
}
function eligible(bank, settings) {
  return bank.filter(q => settings.categories.includes(q.category) &&
    (settings.level === 'mixed' || q.level === settings.level));
}
export function shuffled(values) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1); [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
function deckFor(bank, settings) {
  const pool = eligible(bank, settings);
  const used = new Set();
  const result = [];
  for (let round = 0; round < settings.rounds; round++) {
    const selected = [];
    for (let i = 0; i < settings.questionsPerRound; i++) {
      let candidates = pool.filter(q => !used.has(q.id) && !selected.includes(q.id));
      if (!candidates.length) {
        used.clear(); candidates = pool.filter(q => !selected.includes(q.id));
      }
      // Select categories equally, so the arithmetic bank doesn't dominate mixed play.
      const groups = [...new Set(candidates.map(q => q.category))];
      const category = groups[randomInt(groups.length)];
      const group = candidates.filter(q => q.category === category);
      const q = group[randomInt(group.length)];
      selected.push(q.id); used.add(q.id);
    }
    result.push(...selected);
  }
  return result;
}
export function createRoom(code, name, input, bank, now) {
  const token = randomBytes(32).toString('base64url');
  const player = {id: randomBytes(12).toString('hex'), tokenHash: digest(token), name: playerName(name), ready: false};
  const settings = settingsFor(input, bank);
  return {token, room: {code, hostId: player.id, settings, players: [player],
    deck: deckFor(bank, settings), index: -1, phase: 'lobby', startsAt: null,
    deadline: null, answers: {}, history: [], audit: [], revision: 0, updatedAt: now}};
}
export function joinRoom(room, name, now) {
  check(room.phase === 'lobby' && room.players.length === 1, 'الغرفة بدأت أو كاملة');
  name = playerName(name);
  check(normalize(name) !== normalize(room.players[0].name), 'اختار اسم مختلف عن اللاعب التاني');
  const token = randomBytes(32).toString('base64url');
  const player = {id: randomBytes(12).toString('hex'), tokenHash: digest(token), name, ready: false};
  room.players.push(player); room.updatedAt = now;
  return {token, player};
}
export function ranking(room) {
  const scores = room.players.map(p => ({id: p.id, name: p.name, ...(p.avatar ? {avatar: p.avatar} : {}), score: 0, correct: 0, totalMs: 0, averageMs: null}));
  for (const item of room.history) {
    const count = Object.values(item.answers).filter(a => a.correct).length;
    for (const p of scores) {
      const a = item.answers[p.id];
      if (!a?.correct) continue;
      p.score += count === 2 && room.settings.halfWhenBothCorrect ? 10 : 20;
      p.correct++; p.totalMs += a.elapsedMs;
    }
  }
  for (const p of scores) p.averageMs = p.correct ? p.totalMs / p.correct : null;
  scores.sort((a, b) => b.score - a.score || (a.averageMs ?? Infinity) - (b.averageMs ?? Infinity));
  scores.forEach((p, i) => {
    const prev = scores[i - 1];
    p.rank = prev && prev.score === p.score && prev.averageMs === p.averageMs ? prev.rank : i + 1;
  });
  return scores;
}
function reveal(room, bank, now) {
  if (room.phase !== 'question') return;
  const q = bank.find(q => q.id === room.deck[room.index]);
  room.history.push({index: room.index, questionId: q.id, prompt: q.prompt,
    category: q.category, answer: q.answers[0], explanation: q.explanation, ...(q.image ? {image: q.image} : {}),
    answers: structuredClone(room.answers)});
  room.phase = 'review'; room.updatedAt = now;
}
export function advanceClock(room, bank, now) {
  if (room.phase === 'countdown' && now >= room.startsAt) {
    room.phase = 'question'; room.startsAt = now;
    room.deadline = now + room.settings.seconds * 1000; room.updatedAt = now;
    return true;
  }
  if (room.phase === 'question' && now >= room.deadline) {
    reveal(room, bank, now); return true;
  }
  return false;
}
export function command(room, playerId, message, bank, now, online) {
  const player = room.players.find(p => p.id === playerId);
  check(player, 'اللاعب مش موجود');
  switch (message.type) {
    case 'ready':
      check(room.phase === 'lobby', 'المباراة بدأت');
      player.ready = message.ready === true;
      break;
    case 'start':
    case 'next': {
      check(playerId === room.hostId, 'صاحب الغرفة بس يقدر يبدأ السؤال');
      check(message.type === 'start' ? room.phase === 'lobby' : room.phase === 'review', 'المرحلة اتغيرت؛ راجع الشاشة');
      check(message.index === room.index, 'الطلب ده لسؤال قديم');
      check(room.players.length === 2 && room.players.every(p => online.has(p.id)), 'مستنيين اللاعب التاني يتصل');
      check(room.players.every(p => p.ready), 'لازم الاتنين يضغطوا جاهز');
      if (room.index + 1 === room.deck.length) { room.phase = 'complete'; break; }
      room.index++; room.answers = {}; room.deadline = null;
      room.startsAt = now + 3000; room.phase = 'countdown';
      break;
    }
    case 'answer': {
      check(room.phase === 'question' && now < room.deadline, 'وقت الإجابة خلص');
      check(message.index === room.index, 'الإجابة دي لسؤال قديم');
      check(!room.answers[playerId], 'إجابتك اتسجلت خلاص');
      check(typeof message.text === 'string' && message.text.trim().length > 0 && message.text.length <= 240, 'اكتب إجابة من حرف لـ٢٤٠ حرف');
      const q = bank.find(q => q.id === room.deck[room.index]);
      const correct = q.answers.some(a => normalize(a) === normalize(message.text));
      room.answers[playerId] = {text: message.text.trim(), elapsedMs: Math.max(0, now - room.startsAt), correct, overridden: false};
      if (Object.keys(room.answers).length === 2) reveal(room, bank, now);
      break;
    }
    case 'override': {
      check(playerId === room.hostId, 'صاحب الغرفة بس يقدر يراجع التصحيح');
      check(['review', 'complete'].includes(room.phase), 'المراجعة بعد انتهاء السؤال');
      const item = room.history.find(q => q.index === message.index);
      const answer = item?.answers[message.playerId];
      check(answer, 'مفيش إجابة مكتوبة نراجعها');
      check(typeof message.correct === 'boolean', 'حدد صح أو غلط');
      check(room.audit.length < 10000, 'وصلت للحد الأقصى للمراجعات');
      room.audit.push({by: playerId, playerId: message.playerId, index: message.index, from: answer.correct, to: message.correct, at: now});
      answer.correct = message.correct; answer.overridden = true;
      break;
    }
    default: throw new GameError('طلب مش معروف');
  }
  room.updatedAt = now;
}
export function publicRoom(room, viewerId, bank, online, now) {
  const current = room.index >= 0 ? bank.find(q => q.id === room.deck[room.index]) : null;
  return {code: room.code, hostId: room.hostId, settings: room.settings,
    phase: room.phase, index: room.index, total: room.deck.length,
    round: room.index >= 0 ? Math.floor(room.index / room.settings.questionsPerRound) + 1 : 1,
    questionInRound: room.index >= 0 ? room.index % room.settings.questionsPerRound + 1 : 0,
    startsAt: room.startsAt, deadline: room.deadline, serverNow: now, revision: room.revision,
    ...(room.pack ? {pack: room.pack} : {}),
    players: room.players.map(({id, name, ready, avatar}) => ({id, name, ready, ...(avatar ? {avatar} : {}), online: online.has(id)})),
    question: room.phase === 'question' && current ? {prompt: current.prompt, category: current.category, level: current.level, ...(current.image ? {image: current.image} : {})} : null,
    submitted: Object.keys(room.answers), ownAnswer: room.answers[viewerId]?.text ?? null,
    history: room.history, audit: room.audit, ranking: ranking(room)};
}
