/* Feed the validator known-bad vignettes and known-good ones, confirm it
   separates them. Run from the repo root. */
const { execSync } = require('child_process');
const fs = require('fs');
const orig = fs.readFileSync('ecg-engine.js', 'utf8');

const BAD = [
  ['rate tell (rhythm case)', 'ecg-004', 'A 70-year-old man in pre-op clinic. His heart rate is 96 and his blood pressure is 138/86.'],
  ['regularity tell', 'ecg-004', 'A 70-year-old man in pre-op clinic with an irregular pulse and a blood pressure of 138/86.'],
  ['lay irregularity', 'ecg-004', 'A 34-year-old woman says her heart has felt like it is skipping since she woke up.'],
  ['ECG morphology', 'ecg-026', 'A 35-year-old man with a family history of sudden death; coved ST elevation is present.'],
  ['interval in ms', 'ecg-009', 'An asymptomatic 55-year-old at a routine visit. The PR interval measures 260 ms.'],
  ['telltale lab', 'ecg-023', 'A dialysis patient who missed a session; potassium 7.4 today.'],
  ['names entity', 'ecg-011', 'A 70-year-old with syncope, later found to have Mobitz type II block.'],
  ['lead name', 'ecg-019', 'A 60-year-old with chest pain and tall R waves in V1 to V3.'],
];
const GOOD = [
  ['respiratory rate is fine', 'ecg-003', 'A 19-year-old man with wheeze after a viral illness, respiratory rate 26, oxygen saturation 93 percent.'],
  ['age is not a pulse', 'ecg-007', 'A 24-year-old woman collapsed at a soccer match; her brother died suddenly at 19.'],
  ['mm Hg is fine', 'ecg-015', 'A 19-year-old with intermittent palpitations, blood pressure 112/68 mm Hg, otherwise well.'],
  ['comorbidity naming anatomy', 'ecg-005', 'A 34-year-old woman with an atrial septal defect repaired in childhood, now with two days of palpitations.'],
  ['heart rate OK in non-rhythm case', 'ecg-023', 'A dialysis patient who missed two sessions, heart rate 70, blood pressure 158/94 mm Hg.'],
];

function tryVignette(id, text) {
  // swap the first vignette of the given case
  const start = orig.indexOf("id: '" + id + "'");
  const m = /\n(\s*)clinicals: \[\n(\s*)"/.exec(orig.slice(start));
  const at = start + m.index + m[0].length;
  const close = orig.indexOf('"', at);
  const patched = orig.slice(0, at) + text.replace(/"/g, '\\"') + orig.slice(close);
  fs.writeFileSync('ecg-engine.js', patched);
  try {
    execSync('node validate-vignettes.js', { stdio: 'pipe' });
    return true;   // passed
  } catch (e) {
    return false;  // failed validation
  }
}

let wrong = [];
BAD.forEach(([label, id, text]) => { if (tryVignette(id, text)) wrong.push('MISSED: ' + label); });
GOOD.forEach(([label, id, text]) => { if (!tryVignette(id, text)) wrong.push('FALSE POSITIVE: ' + label); });
fs.writeFileSync('ecg-engine.js', orig);

console.log(BAD.length + ' bad + ' + GOOD.length + ' good cases tested');
if (wrong.length) { console.error(wrong.join('\n')); process.exit(1); }
console.log('validator separates leaks from legitimate clinical detail');
