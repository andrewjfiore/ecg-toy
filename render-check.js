/* Sanity-check the sampled signal for every diagnosis x lead. Guards against a
   timing change silently producing NaNs, flat lines, or absurd voltages. */
const ECG = require('./ecg-engine.js');
let bad = [];
ECG.DX.forEach(d => {
  const spec = JSON.parse(JSON.stringify(d.engineSpec)); spec.seed = 4242;
  ECG.ALL12.forEach(L => {
    const v = ECG.sampleLead(spec, L, 0, 2500, 2);
    let mn = Infinity, mx = -Infinity, nan = 0;
    for (let i = 0; i < v.length; i++) {
      if (!isFinite(v[i])) { nan++; continue; }
      if (v[i] < mn) mn = v[i];
      if (v[i] > mx) mx = v[i];
    }
    const tag = d.id + ' ' + d.name + ' ' + L;
    if (nan) bad.push(tag + ': ' + nan + ' non-finite samples');
    else if (mx - mn < 0.05) bad.push(tag + ': flat (' + (mx - mn).toFixed(3) + ' mV)');
    else if (mn < -8 || mx > 8) bad.push(tag + ': implausible voltage ' + mn.toFixed(1) + '..' + mx.toFixed(1) + ' mV');
  });
});
// beat count sanity: rate should roughly match the declared rate
ECG.DX.forEach(d => {
  if (!d.rate || d.rate < 20) return;
  const rh = ECG.buildRhythm(d.engineSpec, 10000);
  const bpm = rh.vEvents.length / 10 * 60;
  if (Math.abs(bpm - d.rate) > Math.max(12, d.rate * 0.22))
    bad.push(d.id + ' ' + d.name + ': rendered ~' + Math.round(bpm) + '/min vs declared ' + d.rate);
});
console.log(bad.length ? 'RENDER ISSUES (' + bad.length + '):\n  ' + bad.join('\n  ')
  : 'render check OK: ' + ECG.DX.length + ' diagnoses x 12 leads, finite non-flat traces, rates match');
process.exit(bad.length ? 1 : 0);
