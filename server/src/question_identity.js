// Answer matching can ignore punctuation, but question identity must preserve
// operators, word boundaries and distinct Arabic letters. Pictures also matter.
import {createHash} from 'node:crypto';

export function questionIdentity(prompt, image = null) {
  const text = prompt.normalize('NFC').trim().replace(/\s+/gu, ' ');
  const picture = image ? createHash('sha256').update(image).digest('hex') : null;
  return JSON.stringify([text, picture]);
}
