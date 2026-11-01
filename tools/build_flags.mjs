// Flag sources and API: https://flagpedia.net/download/api
// 193 UN member states plus Palestine and the Holy See (195 total).
import {mkdir, writeFile} from 'node:fs/promises';
const codes = `af al dz ad ao ag ar am au at az bs bh bd bb by be bz bj bt bo ba bw br bn bg bf bi cv kh cm ca cf td cl cn co km cg cd cr ci hr cu cy cz dk dj dm do ec eg sv gq er ee sz et fj fi fr ga gm ge de gh gr gd gt gn gw gy ht hn hu is in id ir iq ie il it jm jp jo kz ke ki kp kr kw kg la lv lb ls lr ly li lt lu mg mw my mv ml mt mh mr mu mx fm md mc mn me ma mz mm na nr np nl nz ni ne ng mk no om pk pw pa pg py pe ph pl pt qa ro ru rw kn lc vc ws sm st sa sn rs sc sl sg sk si sb so za ss es lk sd sr se ch sy tj tz th tl tg to tt tn tr tm tv ug ua ae gb us uy uz vu va ve vn ye zm zw ps`.split(/\s+/);
if (codes.length !== 195 || new Set(codes).size !== 195) throw Error(`Invalid country set: ${codes.length}`);
const ar = new Intl.DisplayNames(['ar'], {type: 'region'});
const en = new Intl.DisplayNames(['en'], {type: 'region'});
const aliases = {
  eg: ['مصر', 'جمهورية مصر العربية'], sa: ['السعودية', 'المملكة العربية السعودية'],
  ae: ['الإمارات', 'الامارات العربية المتحدة'], gb: ['بريطانيا', 'المملكة المتحدة', 'المملكة المتحدة لبريطانيا العظمى وأيرلندا الشمالية', 'UK', 'United Kingdom'],
  us: ['أمريكا', 'امريكا', 'الولايات المتحدة', 'الولايات المتحدة الأمريكية', 'USA', 'United States', 'United States of America'],
  tr: ['تركيا', 'Turkey', 'Türkiye'], ps: ['فلسطين', 'دولة فلسطين', 'Palestine'], va: ['الفاتيكان', 'دولة الفاتيكان', 'Holy See', 'Vatican', 'Vatican City'],
  kr: ['كوريا الجنوبية', 'South Korea'], kp: ['كوريا الشمالية', 'North Korea'],
  cd: ['الكونغو الديمقراطية', 'جمهورية الكونغو الديمقراطية', 'DR Congo', 'Democratic Republic of the Congo'],
  cg: ['الكونغو', 'جمهورية الكونغو', 'Republic of the Congo', 'Congo'],
  ci: ['ساحل العاج', 'كوت ديفوار', 'Ivory Coast', "Cote d'Ivoire"],
  cz: ['التشيك', 'جمهورية التشيك', 'Czech Republic', 'Czechia'],
  sz: ['إسواتيني', 'اسواتيني', 'سوازيلاند', 'Swaziland'], cv: ['الرأس الأخضر', 'كابو فيردي', 'Cape Verde'],
  mm: ['ميانمار', 'بورما', 'Burma'], tl: ['تيمور الشرقية', 'East Timor'],
  mk: ['مقدونيا الشمالية', 'مقدونيا', 'North Macedonia'], ba: ['البوسنة والهرسك', 'البوسنة'],
  ru: ['روسيا', 'روسيا الاتحادية', 'Russian Federation'], sy: ['سوريا', 'سورية'],
  tn: ['تونس'], ma: ['المغرب'], om: ['عمان', 'سلطنة عمان'], qa: ['قطر'],
  ve: ['فنزويلا'], la: ['لاوس', 'Lao PDR'], bn: ['بروناي', 'Brunei'],
  fm: ['ميكرونيزيا', 'Micronesia'], st: ['ساو تومي وبرينسيبي', 'ساوتومي وبرينسيب'],
};
const easy = new Set('eg sa ae bh kw qa om jo lb sy iq ps ye ly tn dz ma sd so dj km mr tr us gb fr de it es pt br ar ca mx jp cn in kr ru au za gr ch se no dk fi nl be ie at nz id my pk bd ir ua pl'.split(' '));
const countries = codes.map(code => ({code, answers: [...new Set([...(aliases[code] ?? []), ar.of(code.toUpperCase()), en.of(code.toUpperCase())])]}));
const flags = new Array(countries.length);
let cursor = 0;
async function worker() {
  for (;;) {
    const index = cursor++;
    if (index >= countries.length) return;
    const {code, answers} = countries[index];
    let bytes;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(`https://flagcdn.com/w320/${code}.png`, {signal: AbortSignal.timeout(30000)});
        if (!response.ok) throw Error(`HTTP ${response.status}`);
        bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw Error('Invalid PNG');
        break;
      } catch (error) { if (attempt === 2) throw Error(`${code}: ${error.message}`); }
    }
    flags[index] = {id: `flag_${code}`, prompt: 'ده علم أنهي دولة؟', category: 'أعلام الدول', level: easy.has(code) ? 'easy' : 'medium', answers, explanation: `الإجابة: ${answers[0]}`, image: `data:image/png;base64,${bytes.toString('base64')}`};
    if (code === 'eg') {
      await writeFile(new URL('../assets/data/flag_eg.png', import.meta.url), bytes);
    }
  }
}
await mkdir(new URL('../server/data/', import.meta.url), {recursive:true});
await mkdir(new URL('../assets/data/', import.meta.url), {recursive:true});
await Promise.all(Array.from({length: 4}, worker));
await writeFile(new URL('../server/data/flags.json', import.meta.url), JSON.stringify(flags));
await writeFile(new URL('../server/data/flags-source.json', import.meta.url), JSON.stringify({source: 'https://flagpedia.net/download/api', images: 'https://flagcdn.com', scope: '193 UN members plus Palestine and Holy See', count: flags.length, downloaded: new Date().toISOString(), countries}, null, 2));
console.log(`Built ${flags.length} country flags with Arabic and English answer aliases.`);
