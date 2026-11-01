import {readFileSync} from 'node:fs';

export const flagBank = JSON.parse(readFileSync(new URL('../data/flags.json', import.meta.url), 'utf8'));
export const flagPack = Object.freeze({
  id: 'builtin-flags', gameId: 'flags', title: 'خمن علم الدولة',
  description: '١٩٥ علم من كل حتة في العالم… شوف العلم واكتب اسم الدولة!',
  author: 'مين أنا', questionCount: flagBank.length, cover: flagBank.find(q => q.id === 'flag_eg').image,
});
