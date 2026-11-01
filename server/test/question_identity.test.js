import {test} from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {packFields} from '../src/accounts.js';
import {questionIdentity} from '../src/question_identity.js';

const pack = questions => ({title: 'اختبار', description: '', isPublic: false, questions});
const question = prompt => ({prompt, answers: ['إجابة']} );

test('different operators, spaces and Arabic letters are not duplicate questions', async () => {
  const prompts = ['ناتج ٢ + ٢؟', 'ناتج ٢ - ٢؟', 'ناتج ٢ × ٢؟', 'ناتج ٢ ÷ ٢؟', 'أين يقع العلم؟', 'اين يقع العلم؟', 'مين ده؟', 'مينده؟', 'ما معنى عَلَم؟', 'ما معنى عِلْم؟', 'ما قيمة x؟', 'ما قيمة X؟'];
  const saved = await packFields(pack(prompts.map(question)));
  assert.equal(saved.questions.length, prompts.length);
});

test('actual repeated text identifies both question numbers and preserves author text', async () => {
  await assert.rejects(packFields(pack([question('سؤال أول؟'), question('سؤال مختلف؟'), question('  سؤال   أول؟  ')])), error => error.status === 400 && /رقم 3.*رقم 1/.test(error.message));
  assert.equal(questionIdentity('Question?'), questionIdentity(' Question? '));
});

test('same prompt with different pictures is valid; same picture is duplicate', async () => {
  const picture = async color => 'data:image/png;base64,' + (await sharp({create: {width: 8, height: 8, channels: 3, background: color}}).png().toBuffer()).toString('base64');
  const a = await picture('#ff0000'), b = await picture('#0000ff');
  const first = {...question('مين ده؟'), image: a};
  const saved = await packFields(pack([first, {...question('مين ده؟'), image: b}]));
  assert.equal(saved.questions.length, 2);
  await assert.rejects(packFields(pack([first, first])), /رقم 2.*رقم 1/);
});

test('duplicate editor IDs do not prevent saving distinct questions', async () => {
  const id = 'a'.repeat(24);
  const saved = await packFields(pack([{...question('سؤال أول؟'), id}, {...question('سؤال تاني؟'), id}]));
  assert.equal(saved.questions[0].id, id);
  assert.notEqual(saved.questions[1].id, id);
});
