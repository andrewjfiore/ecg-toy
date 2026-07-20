/* validate-vignettes.js - keep the clinical vignettes honest.
 *
 * Two things can quietly break this exercise:
 *
 *   1. Too few stories per diagnosis. If a diagnosis always arrives with the same
 *      vignette, a student learns the story rather than the tracing.
 *   2. A vignette that states the ECG finding. The original set did this in 19 of
 *      30 cases ("PR interval measures 260 ms", "coved ST elevation in V1-V2",
 *      "QTc 520 ms"), which let a student answer without reading the ECG at all.
 *
 * Both are mechanical to check, so they are checked rather than trusted.
 *
 *   node validate-vignettes.js
 */
var ECG = require('./ecg-engine.js');

var MIN_VARIANTS = 3;

/* Interval, morphology, lead and axis language. If a vignette says any of this,
   it is describing the tracing the student is supposed to be reading. */
var ECG_TALK = [
  /\bPR\b/i, /\bQRS\b/i, /\bQTc?\b/i, /\bST\b/i,
  /\b[PQRSTU][ -]wave/i, /\bdelta wave/i, /\bepsilon\b/i, /\bJ point/i,
  /peaked|coved|saddle|sawtooth|slurred|scooped|notched|biphasic/i,
  /dropped (beat|qrs|complex)/i, /grouped beating/i, /dissociat/i,
  /axis deviation/i, /\bR[- ]wave progression/i,
  /\bleads? (I|II|III|aVR|aVL|aVF|V[1-6])\b/i, /\bV[1-6]\b/,
  /\b\d+\s*ms\b/i, /millisecond/i, /\bmm\b(?!\s*Hg)/,   // mm of deflection, not mm Hg
  /narrow[- ]complex|wide[- ]complex|broad complex/i,
];

/* Naming the rhythm or syndrome is naming the answer. */
var NAMED_ENTITY = [
  /sinus (tachy|brady)cardia/i, /atrial (fibrillation|flutter)/i,
  /ventricular (tachy|fibrillation)/i, /supraventricular/i,
  /torsade/i, /wenckebach/i, /mobitz/i, /brugada/i, /wolff|parkinson[- ]white/i,
  /bundle branch/i, /heart block/i, /\bAV block/i, /hyperkalemi|hypokalemi/i,
  /pericarditis/i, /\bSTEMI\b/i, /\bNSTEMI\b/i, /hypertrophy/i, /long QT/i,
];

/* A lab value that is itself the diagnosis. */
var TELLTALE_LAB = [/potassium\s*(of\s*)?\d/i, /\bK\+?\s*(of\s*)?\d/i, /troponin\s*(of\s*)?\d/i];

/* Rhythm and conduction cases are decided by rate and regularity. Both are
   readable off the tracing, so a stem that states either lets the student answer
   without looking at it.

   The carve-out for the other categories is narrower than it looks. Those cases
   are all sinus, but they are sinus at DIFFERENT rates (inferior STEMI renders 58,
   PE 112, most others 80-96), so a stated rate can still separate a case from a
   cross-category distractor. It cannot separate a case from its same-category
   peers, which is what usually fills the option list, so this check stays scoped
   to rhythm and conduction. Revisit if a category's distractor pool changes. */
var RATE_SENSITIVE_CATS = ['rhythm', 'conduction'];
/* Only a CARDIAC rate counts. Respiratory rate is an ordinary vital sign and an
   age ("her brother died suddenly at 19") is not a pulse, so both must survive. */
var RATE_TELLS = [
  /\b(heart rate|pulse|ventricular rate|ventricular response)\b[^.]{0,20}?\b\d{1,3}\b/i,
  /\b(heart rate|pulse)\b[^.]{0,12}?\bin the \d{2,3}s\b/i,
  /\bpulse (is |of )?(in the )?\d/i,
];
var REGULARITY_TELLS = [
  /\b(ir)?regular(ly)?\b/i,
  /\bskipping\b|\bflutter(ing)?\b|\bflip[- ]?flop/i,
  /\bracing\b|\bpounding\b|\bgalloping\b/i,
  /\bmissed?\s+beats?\b|\bextra beats?\b|\bout of time\b/i,
];

var errors = [], warnings = [];

ECG.DX.forEach(function (d) {
  var vs = d.clinicals || [];
  var tag = d.id + ' ' + d.name;

  if (vs.length < MIN_VARIANTS) {
    errors.push(tag + ': only ' + vs.length + ' vignette(s); needs at least ' + MIN_VARIANTS +
      ' so the same diagnosis does not always arrive with the same story.');
    return;
  }
  var seen = {};
  vs.forEach(function (v, i) {
    var norm = String(v).toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen[norm]) errors.push(tag + ' [' + i + ']: duplicate of vignette ' + seen[norm]);
    seen[norm] = i;

    ECG_TALK.forEach(function (re) {
      var m = String(v).match(re);
      if (m) errors.push(tag + ' [' + i + ']: describes the tracing ("' + m[0] + '") - the student should read that off the ECG.');
    });
    NAMED_ENTITY.forEach(function (re) {
      var m = String(v).match(re);
      if (m) errors.push(tag + ' [' + i + ']: names the entity ("' + m[0] + '").');
    });
    TELLTALE_LAB.forEach(function (re) {
      var m = String(v).match(re);
      if (m) errors.push(tag + ' [' + i + ']: quotes the diagnostic lab ("' + m[0] + '") - give the clinical cause instead.');
    });
    /* The diagnosis's own distinctive words. Bare anatomical adjectives are
       excluded: "atrial septal defect" is a legitimate comorbidity in an atrial
       flutter case, and the multi-word entity names are caught above anyway. */
    String(d.name).toLowerCase().replace(/[()\/]/g, ' ').split(/\s+/)
      .filter(function (w) {
        return w.length > 6 && ['acute', 'effect', 'syndrome', 'degree', 'complete',
          'atrial', 'ventricular', 'sinus', 'bundle', 'branch'].indexOf(w) < 0;
      })
      .forEach(function (w) {
        if (norm.indexOf(w) >= 0) errors.push(tag + ' [' + i + ']: contains the diagnosis word "' + w + '".');
      });

    if (RATE_SENSITIVE_CATS.indexOf(d.category) >= 0) {
      RATE_TELLS.forEach(function (re) {
        var m = String(v).match(re);
        if (m) errors.push(tag + ' [' + i + ']: states the rate ("' + m[0].trim() +
          '"). In a ' + d.category + ' case the rate is the discriminator, so it has to come off the tracing.');
      });
      REGULARITY_TELLS.forEach(function (re) {
        var m = String(v).match(re);
        if (m) errors.push(tag + ' [' + i + ']: describes regularity ("' + m[0].trim() +
          '"). In a ' + d.category + ' case that is the answer.');
      });
    }

    if (String(v).length > 260) warnings.push(tag + ' [' + i + ']: long (' + String(v).length + ' chars).');
    if (/[–—]/.test(v)) errors.push(tag + ' [' + i + ']: em or en dash in copy.');
  });

  // surface variety: three stories that open the same way are not three stories
  var opens = vs.map(function (v) { return String(v).slice(0, 18).toLowerCase(); });
  if (new Set(opens).size < vs.length) warnings.push(tag + ': two vignettes open almost identically.');
});

warnings.forEach(function (w) { console.log('note:  ' + w); });
if (errors.length) {
  console.error('\nVIGNETTE VALIDATION FAILED (' + errors.length + '):');
  errors.slice(0, 40).forEach(function (e) { console.error('  - ' + e); });
  if (errors.length > 40) console.error('  ... and ' + (errors.length - 40) + ' more');
  process.exit(1);
}
var total = ECG.DX.reduce(function (n, d) { return n + (d.clinicals || []).length; }, 0);
console.log('\nvignette validation OK: ' + ECG.DX.length + ' diagnoses, ' + total +
  ' vignettes, none naming the finding or the diagnosis.');
