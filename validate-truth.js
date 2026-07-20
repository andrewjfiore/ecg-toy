/* validate-truth.js - mechanical cross-check of the per-lead answer key against
 * the engine spec. Run as part of the build; exits non-zero on contradictions.
 *
 * Why this exists: the answer key was authored by reading the engine, and reading
 * can miss things. It did. RBBB sets spec.qrsWidth = 130, which computeLead()
 * applies to EVERY lead via p.qrsScale, so the QRS renders wide in all twelve --
 * but the key initially called eight of them normal, which would have failed a
 * student for correctly seeing a wide QRS in lead II. A global property in the
 * spec is a fact, not a judgement call, so it gets checked by code.
 *
 * The rule: if a diagnosis carries a GLOBAL abnormality, no lead may be 'norm'.
 * A lead may still be 'either' (present but not perceptible at that amplitude),
 * because 'either' is excluded from grading and so cannot fail anyone.
 *
 *   node validate-truth.js
 */
var ECG = require('./ecg-engine.js');
var truth = require('./ecg-lead-truth.json');

var LEADS = ['I', 'II', 'III', 'aVR', 'aVL', 'aVF', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6'];
/* flags computeLead() applies unconditionally, before any leadOverride */
var GLOBAL_FLAGS = ['noP', 'lowP', 'peakedT', 'flatT', 'longQT', 'shortQT', 'uWave', 'prDep', 'deltaWPW'];
var WIDE_QRS_MS = 120;

function globalReasons(spec) {
  var r = [];
  if (spec.qrsWidth && spec.qrsWidth > WIDE_QRS_MS) r.push('qrsWidth ' + spec.qrsWidth + ' ms (p.qrsScale applies to every lead)');
  if (spec.rhythm && spec.rhythm !== 'sinus') r.push("rhythm '" + spec.rhythm + "' (buildRhythm event train affects every lead)");
  if (spec.special) r.push("special '" + spec.special + "'");
  var fl = Object.keys(spec.flags || {}).filter(function (f) { return GLOBAL_FLAGS.indexOf(f) >= 0 && spec.flags[f]; });
  if (fl.length) r.push('flags ' + fl.join(', ') + ' (applied in computeLead to every lead)');
  return r;
}

var errors = [], warnings = [], missing = [];

ECG.DX.forEach(function (d) {
  var t = truth[d.id];
  if (!t || !t.leads) { missing.push(d.id + ' (' + d.name + ')'); return; }

  LEADS.forEach(function (L) {
    var v = t.leads[L];
    if (['abn', 'norm', 'either'].indexOf(v) < 0) {
      errors.push(d.id + ' ' + d.name + ' lead ' + L + ': invalid call "' + v + '"');
    }
  });

  var reasons = globalReasons(d.spec || {});
  if (!reasons.length) return;

  var norm = LEADS.filter(function (L) { return t.leads[L] === 'norm'; });
  if (norm.length) {
    errors.push(d.id + ' ' + d.name + ': leads ' + norm.join(', ') + ' marked NORMAL despite ' +
      reasons.join(' + ') + '. A student marking these abnormal would be failed for reading correctly.');
  }
  var either = LEADS.filter(function (L) { return t.leads[L] === 'either'; });
  if (either.length) {
    warnings.push(d.id + ' ' + d.name + ': ' + either.length + ' lead(s) ungraded (' + either.join(', ') +
      ') under a global finding - acceptable, but each should be genuinely imperceptible.');
  }
});

/* A lead the spec explicitly rewrites cannot be 'normal'. */
ECG.DX.forEach(function (d) {
  var t = truth[d.id]; if (!t || !t.leads) return;
  Object.keys((d.spec || {}).leadOverride || {}).forEach(function (L) {
    if (t.leads[L] === 'norm') {
      errors.push(d.id + ' ' + d.name + ' lead ' + L + ': marked NORMAL but spec.leadOverride[' + L + '] explicitly alters it.');
    }
  });
});

var graded = 0, ungraded = 0;
Object.keys(truth).forEach(function (id) {
  LEADS.forEach(function (L) { truth[id].leads[L] === 'either' ? ungraded++ : graded++; });
});

if (missing.length) errors.push('no answer key for: ' + missing.join(', '));

warnings.forEach(function (w) { console.log('note:  ' + w); });
if (errors.length) {
  console.error('\nTRUTH VALIDATION FAILED (' + errors.length + '):');
  errors.forEach(function (e) { console.error('  - ' + e); });
  process.exit(1);
}
console.log('\ntruth validation OK: ' + Object.keys(truth).length + ' diagnoses, ' +
  graded + ' graded leads, ' + ungraded + ' ungraded.');
