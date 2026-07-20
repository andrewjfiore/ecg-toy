/* measure-timing.js - diagnostic tool for the beat timing model. Not a test;
 * run it when changing QRS_CAL, tOffset, or the qrsComps templates.
 *
 * Background: the Gaussian QRS template renders only ~0.52x its nominal duration
 * once the tails fall below what a reader can see. spec.qrsWidth was therefore
 * not the rendered width -- a normal 90 ms QRS drew at ~47 ms, and RBBB, LBBB and
 * the complete-heart-block escape all drew NARROW (66-76 ms) in the eight leads
 * carrying no qrsComps override, inverting the defining feature of a bundle
 * branch block. QRS_CAL corrects that; this tool is how it was measured.
 *
 *   node measure-timing.js [lead]
 */
var ECG = require('./ecg-engine.js');
var LEAD = process.argv[2] || 'II';

function quietSpec(over) {
  var s = ECG.mergeSpec(Object.assign({ rate: 60, seed: 7, rrJitter: 0, pMag: 0, tMag: 0, stMag: 0 }, over || {}));
  Object.keys(s.precordial).forEach(function (k) { s.precordial[k].t = 0; s.precordial[k].p = 0; s.precordial[k].st = 0; });
  return s;
}
/* rendered QRS duration: where the trace leaves and returns to baseline */
function renderedQRS(spec, lead, thresh) {
  var v = ECG.sampleLead(spec, lead, 0, 4000, 1), pk = 0, pi = 0, i;
  for (i = 300; i < v.length - 300; i++) if (Math.abs(v[i]) > Math.abs(pk)) { pk = v[i]; pi = i; }
  function walk(dir) {
    var k = pi, q = 0;
    while (k > 1 && k < v.length - 2) {
      k += dir;
      if (Math.abs(v[k]) < thresh) { if (++q >= 20) return k - dir * 20; } else q = 0;
    }
    return k;
  }
  return Math.abs(walk(1) - walk(-1));
}
/* QT via T-peak detection, anchored to the engine's own J point */
function qt(dx, lead) {
  var sp = dx.engineSpec, v = ECG.sampleLead(sp, lead, 0, 6000, 1), rh = ECG.buildRhythm(sp, 6000);
  if (rh.vEvents.length < 3) return null;
  var q0 = Math.round(rh.vEvents[1].t), j = ECG.qrsEndMs(sp, lead), base = v[q0 - 70] || 0;
  var lo = Math.round(q0 + j), hi = Math.round(Math.min(rh.vEvents[2].t - 40, q0 + 900));
  var pk = 0, ti = lo, i;
  for (i = lo; i < hi; i++) if (Math.abs(v[i] - base) > Math.abs(pk)) { pk = v[i] - base; ti = i; }
  var e = ti; while (e < hi && Math.abs(v[e] - base) > Math.abs(pk) * 0.1) e++;
  var rr = rh.vEvents[2].t - rh.vEvents[1].t;
  return { QT: Math.round(e - q0), rr: Math.round(rr), qtc: Math.round((e - q0) / Math.sqrt(rr / 1000)) };
}

console.log('QRS_CAL = ' + ECG.QRS_CAL + '   (lead ' + LEAD + ')\n');
console.log('nominal -> rendered QRS');
[80, 90, 120, 130, 150, 170].forEach(function (w) {
  var r = renderedQRS(quietSpec({ qrsWidth: w }), LEAD, 0.05);
  console.log('  ' + String(w).padStart(4) + ' ms -> ' + String(Math.round(r)).padStart(4) + ' ms   (ratio ' + (r / w).toFixed(2) + ')');
});

console.log('\nper diagnosis');
console.log('  (the width probe needs a quiet baseline either side of one QRS, so it is');
console.log('   meaningless for AFib, flutter, VFib and pericarditis, where the baseline');
console.log('   never goes quiet. WPW really is wide - the delta wave is the diagnosis.');
console.log('   render-check.js validates the signal itself for every case.)');
console.log('  dx                        nominal  rendered   QT    QTc');
ECG.DX.forEach(function (d) {
  var nom = (d.spec || {}).qrsWidth || 90;
  var sp = quietSpec(Object.assign({}, d.spec, { rate: d.rate > 30 ? d.rate : 60 }));
  var w = Math.round(renderedQRS(sp, LEAD, 0.05));
  var q = qt(d, LEAD);
  var flag = (nom > 120 && w <= 120) ? '  << should be wide' : (nom <= 120 && w > 120 ? '  << unexpectedly wide' : '');
  console.log('  ' + d.name.slice(0, 24).padEnd(25) + String(nom).padStart(5) + String(w).padStart(9) +
    String(q ? q.QT : '-').padStart(7) + String(q ? q.qtc : '-').padStart(6) + flag);
});
