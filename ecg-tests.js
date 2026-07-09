/* Node validation for ecg-engine.js. Checks medical correctness of the
 * synthesis (ST vectors, reciprocals, axis, morphology sanity) so the trainer
 * teaches the right thing. Run: node ecg-tests.js  */
var ECG = require('./ecg-engine.js');

var pass = 0, fail = 0, notes = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; notes.push('FAIL: ' + msg); } }

// helper: mean ST-region voltage for a lead (J+40..J+120 after each QRS) via
// sampling the raw beat template deviation. We approximate by measuring the
// signal at the ST window of the first ventricular beat, minus PR baseline.
function stDeviation(dx, lead) {
  var spec = dx.engineSpec;
  var samples = ECG.sampleLead(spec, lead, 0, 2500, 2);
  var rhythm = ECG.buildRhythm(spec, 2500);
  if (!rhythm.vEvents.length) return 0;
  var q0 = rhythm.vEvents[0].t;
  function at(tms) { var idx = Math.round(tms / 2); return samples[idx] || 0; }
  // baseline = TP segment just before the P of beat 2 or well before QRS
  var base = at(q0 - 60);
  var stwin = (at(q0 + 90) + at(q0 + 110) + at(q0 + 130)) / 3;
  return stwin - base;
}
function peakR(dx, lead) {
  var spec = dx.engineSpec;
  var samples = ECG.sampleLead(spec, lead, 0, 2500, 2);
  var mx = -1e9, mn = 1e9;
  for (var i = 0; i < samples.length; i++) { if (samples[i] > mx) mx = samples[i]; if (samples[i] < mn) mn = samples[i]; }
  return { max: mx, min: mn };
}

// 1. Territory mapping is standard
ok(JSON.stringify(ECG.TERRITORY.LAD.leads) === JSON.stringify(['V1', 'V2', 'V3', 'V4']), 'LAD territory = V1-V4');
ok(JSON.stringify(ECG.TERRITORY.LCx.leads) === JSON.stringify(['I', 'aVL', 'V5', 'V6']), 'LCx territory = I,aVL,V5,V6');
ok(JSON.stringify(ECG.TERRITORY.RCA.leads) === JSON.stringify(['II', 'III', 'aVF']), 'RCA territory = II,III,aVF');

// 2. Inferior STEMI: ST elevation in II/III/aVF, reciprocal depression in I/aVL
var inf = ECG.byId('ecg-017');
ok(stDeviation(inf, 'II') > 0.1, 'inferior STEMI: ST elevation in II (' + stDeviation(inf, 'II').toFixed(2) + ')');
ok(stDeviation(inf, 'III') > 0.1, 'inferior STEMI: ST elevation in III (' + stDeviation(inf, 'III').toFixed(2) + ')');
ok(stDeviation(inf, 'aVF') > 0.1, 'inferior STEMI: ST elevation in aVF (' + stDeviation(inf, 'aVF').toFixed(2) + ')');
ok(stDeviation(inf, 'aVL') < -0.05, 'inferior STEMI: reciprocal depression in aVL (' + stDeviation(inf, 'aVL').toFixed(2) + ')');
ok(stDeviation(inf, 'I') < -0.02, 'inferior STEMI: reciprocal depression in I (' + stDeviation(inf, 'I').toFixed(2) + ')');
ok(stDeviation(inf, 'III') >= stDeviation(inf, 'II') - 0.01, 'inferior STEMI: III elevation >= II (RCA pattern)');

// 3. Anterior STEMI: ST elevation in V1-V4, not in inferior leads
var ant = ECG.byId('ecg-016');
ok(stDeviation(ant, 'V2') > 0.15, 'anterior STEMI: ST elevation in V2 (' + stDeviation(ant, 'V2').toFixed(2) + ')');
ok(stDeviation(ant, 'V3') > 0.15, 'anterior STEMI: ST elevation in V3');
ok(stDeviation(ant, 'II') < 0.1, 'anterior STEMI: no inferior elevation');

// 4. Lateral STEMI: elevation I/aVL/V5/V6
var lat = ECG.byId('ecg-018');
ok(stDeviation(lat, 'aVL') > 0.08, 'lateral STEMI: ST elevation in aVL (' + stDeviation(lat, 'aVL').toFixed(2) + ')');
ok(stDeviation(lat, 'V6') > 0.1, 'lateral STEMI: ST elevation in V6');
ok(stDeviation(lat, 'III') < 0, 'lateral STEMI: reciprocal depression inferiorly');

// 5. Posterior MI: ST depression + tall R in V1-V2
var post = ECG.byId('ecg-019');
ok(stDeviation(post, 'V2') < -0.08, 'posterior MI: ST depression in V2 (' + stDeviation(post, 'V2').toFixed(2) + ')');
var pR = peakR(post, 'V2');
ok(pR.max > Math.abs(pR.min), 'posterior MI: tall (dominant) R in V2');

// 6. NSTEMI: ST depression, no elevation anywhere
var nste = ECG.byId('ecg-020');
ok(stDeviation(nste, 'V5') < -0.08, 'NSTEMI: ST depression in V5');
var anyElev = false;
ECG.ALL12.forEach(function (L) { if (stDeviation(nste, L) > 0.1) anyElev = true; });
ok(!anyElev, 'NSTEMI: no ST elevation in any lead');

// 7. aVR is inverted in normal sinus (negative P, negative net QRS, negative T)
var nsr = ECG.byId('ecg-001');
var avr = peakR(nsr, 'aVR');
ok(Math.abs(avr.min) > avr.max, 'NSR: aVR net-negative QRS (physiologic inversion)');
var pII = ECG.computeLead(nsr.engineSpec, 'II').p;
var pAVR = ECG.computeLead(nsr.engineSpec, 'aVR').p;
ok(pII > 0 && pAVR < 0, 'NSR: P upright in II, inverted in aVR');

// 8. R-wave progression across precordium (V1 small R, V5 tall R)
ok(peakR(nsr, 'V5').max > peakR(nsr, 'V1').max, 'NSR: R-wave progression V1 -> V5');

// 9. Axis logic
ok(ECG.axisFromLeads(ECG.byId('ecg-022').engineSpec) === 'right', 'RVH: right axis');
ok(ECG.axisFromLeads(nsr.engineSpec) === 'normal', 'NSR: normal axis');

// 10. LVH voltage: deep S in V1/V2 + tall R in V5/V6 (Sokolow-Lyon > 3.5 mV)
var lvh = ECG.byId('ecg-021');
var sV1 = Math.abs(peakR(lvh, 'V1').min);
var rV5 = peakR(lvh, 'V5').max;
ok(sV1 + rV5 > 3.5, 'LVH: Sokolow-Lyon S(V1)+R(V5) > 35 mm (' + (sV1 + rV5).toFixed(2) + ' mV)');

// 11. Hyperkalemia: peaked (tall) T in precordial leads
var hyperk = ECG.byId('ecg-023');
var tHyper = ECG.computeLead(hyperk.engineSpec, 'V3');
ok(tHyper.t > 0.6 && tHyper.tSig < 35, 'hyperK: tall narrow (peaked) T waves');

// 12. AFib: irregular RR + no P waves
var afib = ECG.byId('ecg-004');
var r = ECG.buildRhythm(afib.engineSpec, 5000);
ok(r.pEvents.length === 0, 'AFib: no P-wave events');
var rrs = [];
for (var i = 1; i < r.vEvents.length; i++) rrs.push(r.vEvents[i].t - r.vEvents[i - 1].t);
var mean = rrs.reduce(function (a, b) { return a + b; }, 0) / rrs.length;
var varc = rrs.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / rrs.length;
ok(Math.sqrt(varc) / mean > 0.15, 'AFib: irregularly irregular RR (CV=' + (Math.sqrt(varc) / mean).toFixed(2) + ')');

// 13. Complete heart block: atrial rate > ventricular rate, dissociated
var chb = ECG.byId('ecg-012');
var rc = ECG.buildRhythm(chb.engineSpec, 6000);
ok(rc.pEvents.length > rc.vEvents.length, 'CHB: more P than QRS (AV dissociation)');

// 14. Flutter: continuous atrial sawtooth, ventricular a fraction of atrial
var flut = ECG.byId('ecg-005');
var rf = ECG.buildRhythm(flut.engineSpec, 6000);
ok(rf.atrialCont !== null && rf.pEvents.length === 0, 'flutter: continuous sawtooth baseline');

// 15. Wenckebach: some P waves are non-conducted (dropped QRS)
var wk = ECG.buildRhythm(ECG.byId('ecg-010').engineSpec, 8000);
ok(wk.pEvents.length > wk.vEvents.length, 'Wenckebach: dropped QRS (P>QRS)');

// 16. All diagnoses produce finite, bounded samples in every lead
var badness = 0;
ECG.DX.forEach(function (d) {
  ECG.ALL12.forEach(function (L) {
    var s = ECG.sampleLead(d.engineSpec, L, 0, 2500, 4);
    for (var k = 0; k < s.length; k++) { if (!isFinite(s[k]) || Math.abs(s[k]) > 6) { badness++; break; } }
  });
});
ok(badness === 0, 'all diagnoses: finite bounded samples in all leads (' + badness + ' bad)');

// 17. WPW: short PR and delta present
var wpw = ECG.byId('ecg-015');
ok(wpw.engineSpec.pr < 120, 'WPW: short PR (' + wpw.engineSpec.pr + ' ms)');
ok(ECG.computeLead(wpw.engineSpec, 'V4').delta === 1, 'WPW: delta wave flagged');

// 18. Count coverage
ok(ECG.DX.length >= 20, 'diagnosis coverage >= 20 (' + ECG.DX.length + ')');

console.log('\nECG engine tests: ' + pass + ' passed, ' + fail + ' failed, ' + ECG.DX.length + ' diagnoses.');
if (notes.length) { console.log(notes.join('\n')); process.exit(1); }
else console.log('ALL PASS');
