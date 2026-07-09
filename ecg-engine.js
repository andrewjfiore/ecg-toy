/* ============================================================================
 * ecg-engine.js  -  Parametric 12-lead ECG synthesis engine (vanilla JS)
 *
 * Approach: event-driven sum-of-Gaussians.
 *   - Each cardiac wave (P, Q, R, S, ST, T, U) is a Gaussian.
 *   - Atrial and ventricular activity are separate event trains, so rhythm
 *     disturbances (AV block, AFib, flutter, VT, complete dissociation) fall
 *     out naturally.
 *   - Limb (frontal-plane) leads are produced by projecting P / QRS / T / ST
 *     VECTORS onto the hexaxial reference. Axis deviation and reciprocal ST
 *     changes are then automatic and physiologic.
 *   - Precordial (horizontal-plane) leads use explicit R-wave-progression
 *     templates plus per-territory ST patterns.
 *   - The signal is sampled at high resolution and emitted as a smooth SVG
 *     polyline calibrated to standard ECG paper (25 mm/s, 10 mm/mV).
 *
 * This file is the single source of truth. It is inlined into ecg-trainer.html
 * and ecg-qa.html by build.js, and exercised directly by ecg-tests.js in Node.
 * ==========================================================================*/
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------- calib */
  var MM_PER_S = 25;     // paper speed
  var MM_PER_MV = 10;    // gain

  var LIMB = ['I', 'II', 'III', 'aVR', 'aVL', 'aVF'];
  var PREC = ['V1', 'V2', 'V3', 'V4', 'V5', 'V6'];
  var ALL12 = ['I', 'II', 'III', 'aVR', 'aVL', 'aVF', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6'];
  // hexaxial reference axis for each limb lead (degrees)
  var LIMB_ANGLE = { I: 0, II: 60, III: 120, aVR: -150, aVL: -30, aVF: 90 };
  // standard 3x4 print layout (row-major)
  var LAYOUT_ROWS = [
    ['I', 'aVR', 'V1', 'V4'],
    ['II', 'aVL', 'V2', 'V5'],
    ['III', 'aVF', 'V3', 'V6']
  ];

  // Normal precordial template (mV): R-wave progression, T waves, small septal q
  function normalPrecordial() {
    return {
      V1: { r: 0.20, s: -1.05, q: 0, t: -0.03, p: 0.04 },
      V2: { r: 0.45, s: -1.65, q: 0, t: 0.42, p: 0.06 },
      V3: { r: 0.75, s: -1.05, q: 0, t: 0.52, p: 0.06 },
      V4: { r: 1.20, s: -0.55, q: 0, t: 0.50, p: 0.05 },
      V5: { r: 1.35, s: -0.28, q: -0.06, t: 0.42, p: 0.05 },
      V6: { r: 1.05, s: -0.14, q: -0.06, t: 0.36, p: 0.04 }
    };
  }

  /* ---------------------------------------------------------------- utils */
  function gauss(t, a, mu, sigma) {
    if (!a) return 0;
    var d = (t - mu) / sigma;
    return a * Math.exp(-0.5 * d * d);
  }
  function deg2rad(d) { return d * Math.PI / 180; }
  function project(leadAngle, vecAngle, mag) {
    return mag * Math.cos(deg2rad(vecAngle - leadAngle));
  }
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* --------------------------------------------------------------- spec base */
  function baseSpec() {
    return {
      rate: 72, rhythm: 'sinus', atrialRate: null, pr: 160, qrsWidth: 90,
      axis: 60, qrsMag: 1.35, pAxis: 55, pMag: 0.12, tAxis: 40, tMag: 0.35,
      stAxis: 0, stMag: 0, stSig: 42, tOffset: 235, tSig: 54, uAmp: 0,
      rrJitter: 0.03, seed: 12345, special: null,
      precordial: normalPrecordial(),
      flags: {},          // peakedT, longQT, shortQT, prDep, deltaWPW, etc.
      leadOverride: {}     // per-lead fine control
    };
  }

  // deep-ish merge of overrides onto a base spec (precordial merges per lead)
  function mergeSpec(over) {
    var s = baseSpec();
    for (var k in over) {
      if (k === 'precordial') {
        for (var L in over.precordial) {
          s.precordial[L] = Object.assign(s.precordial[L] || {}, over.precordial[L]);
        }
      } else if (k === 'flags') {
        Object.assign(s.flags, over.flags);
      } else if (k === 'leadOverride') {
        Object.assign(s.leadOverride, over.leadOverride);
      } else {
        s[k] = over[k];
      }
    }
    return s;
  }

  /* --------------------------------------------------------- rhythm builder */
  // Returns { pEvents:[{t,amp}], vEvents:[{t,ampScale,widthScale,polarity,tag}],
  //           atrialCont: fn(t,lead)|null, special:string|null }
  function buildRhythm(spec, durMs) {
    var rng = mulberry32(spec.seed);
    var pEvents = [], vEvents = [];
    var atrialCont = null;
    var rate = spec.rate;
    var rr = 60000 / rate;

    function jitter() { return 1 + (rng() - 0.5) * 2 * spec.rrJitter; }

    switch (spec.rhythm) {
      case 'sinus': {
        var t = 250;
        while (t < durMs + rr) {
          pEvents.push({ t: t, amp: 1 });
          vEvents.push({ t: t + spec.pr });
          t += rr * jitter();
        }
        break;
      }
      case 'avblock1': { // long PR, 1:1
        var t1 = 250;
        while (t1 < durMs + rr) {
          pEvents.push({ t: t1, amp: 1 });
          vEvents.push({ t: t1 + spec.pr });
          t1 += rr * jitter();
        }
        break;
      }
      case 'wenckebach': { // progressive PR then dropped beat, group beating
        var aRR = 60000 / (spec.atrialRate || 75);
        var prCycle = [180, 240, 320]; // 4th P blocked
        var i = 0, ta = 250;
        while (ta < durMs + aRR) {
          pEvents.push({ t: ta, amp: 1 });
          var phase = i % 4;
          if (phase < 3) vEvents.push({ t: ta + prCycle[phase] });
          ta += aRR; i++;
        }
        break;
      }
      case 'mobitz2': { // constant PR, sudden dropped QRS (3:2)
        var aRR2 = 60000 / (spec.atrialRate || 75);
        var j = 0, tb = 250;
        while (tb < durMs + aRR2) {
          pEvents.push({ t: tb, amp: 1 });
          if (j % 3 !== 2) vEvents.push({ t: tb + spec.pr });
          tb += aRR2; j++;
        }
        break;
      }
      case 'chb': { // complete heart block: independent atrial + ventricular
        var aRR3 = 60000 / (spec.atrialRate || 82);
        var vRR3 = 60000 / (spec.rate || 38);
        var tap = 300;
        while (tap < durMs + aRR3) { pEvents.push({ t: tap, amp: 1 }); tap += aRR3; }
        var tvp = 650;
        while (tvp < durMs + vRR3) { vEvents.push({ t: tvp }); tvp += vRR3; }
        break;
      }
      case 'afib': {
        atrialCont = makeFibBaseline(rng);
        var ta2 = 300;
        while (ta2 < durMs + rr) {
          vEvents.push({ t: ta2 });
          // irregularly irregular: wide RR distribution
          ta2 += rr * (0.55 + rng() * 0.9);
        }
        break;
      }
      case 'flutter': {
        var ff = 60000 / (spec.atrialRate || 300); // ~200 ms
        atrialCont = makeFlutterBaseline(ff);
        var ratio = spec.conductionRatio || 4;    // 4:1 -> ~75 bpm
        var tv = 300 + ff * 2;
        while (tv < durMs + ff * ratio) { vEvents.push({ t: tv }); tv += ff * ratio; }
        break;
      }
      case 'svt': { // regular narrow, no visible P
        var rrs = 60000 / (spec.rate || 180);
        var ts = 300;
        while (ts < durMs + rrs) { vEvents.push({ t: ts }); ts += rrs; }
        break;
      }
      case 'vt': { // monomorphic wide-complex tachy
        var rrv = 60000 / (spec.rate || 165);
        var tvt = 300;
        while (tvt < durMs + rrv) { vEvents.push({ t: tvt, widthScale: 2.2, ampScale: 1 }); tvt += rrv; }
        break;
      }
      case 'torsades': { // polymorphic VT: amplitude/polarity envelope twists
        var rrt = 60000 / (spec.rate || 230);
        var tt = 300, k = 0;
        while (tt < durMs + rrt) {
          var env = Math.sin(2 * Math.PI * 0.55 * tt / 1000); // twisting envelope
          vEvents.push({ t: tt, widthScale: 1.9, ampScale: 0.6 + 0.9 * Math.abs(env), polarity: env >= 0 ? 1 : -1 });
          tt += rrt; k++;
        }
        break;
      }
      case 'vfib': {
        return { pEvents: [], vEvents: [], atrialCont: null, special: 'vfib', rng: rng };
      }
      default: {
        var td = 250;
        while (td < durMs + rr) { pEvents.push({ t: td, amp: 1 }); vEvents.push({ t: td + spec.pr }); td += rr; }
      }
    }
    return { pEvents: pEvents, vEvents: vEvents, atrialCont: atrialCont, special: spec.special, rng: rng };
  }

  // Coarse fibrillatory baseline (AFib): sum of a few random low-freq sinusoids
  function makeFibBaseline(rng) {
    var comps = [];
    for (var i = 0; i < 7; i++) {
      comps.push({ f: 4 + rng() * 6, ph: rng() * 6.28, a: 0.015 + rng() * 0.045 });
    }
    return function (t, lead) {
      var scale = (lead === 'V1' || lead === 'V2') ? 1.6 : (lead === 'aVR' ? 0.5 : 1.0);
      var v = 0;
      for (var i = 0; i < comps.length; i++) v += comps[i].a * Math.sin(2 * Math.PI * comps[i].f * t / 1000 + comps[i].ph);
      return v * scale;
    };
  }

  // Sawtooth flutter baseline (atrial ~300/min). Negative sawtooth inferiorly.
  function makeFlutterBaseline(ff) {
    return function (t, lead) {
      var ph = (t % ff) / ff;               // 0..1
      // asymmetric sawtooth: slow downslope then quick return
      var saw = ph < 0.7 ? (ph / 0.7) : (1 - (ph - 0.7) / 0.3);
      var v = (saw - 0.5) * 2 * 0.16;       // +-0.16 mV
      var pol = (lead === 'II' || lead === 'III' || lead === 'aVF') ? -1
        : (lead === 'V1' || lead === 'aVR') ? 1 : (lead === 'I' || lead === 'aVL') ? 0.2 : 0.4;
      return v * pol;
    };
  }

  /* -------------------------------------------------- per-lead parameters */
  function computeLead(spec, lead) {
    var ws = spec.qrsWidth / 90;               // width scale
    var f = spec.flags || {};
    var p = {
      p: 0, q: 0, r: 0, s: 0, t: 0, u: spec.uAmp || 0, st: 0,
      qrsScale: ws, tSig: spec.tSig, tOffset: spec.tOffset, stSig: spec.stSig,
      prDep: 0, delta: 0, deltaA: 0, qrsComps: null, biphasicP: false
    };

    if (LIMB.indexOf(lead) >= 0) {
      var ang = LIMB_ANGLE[lead];
      var netR = project(ang, spec.axis, spec.qrsMag);
      p.p = project(ang, spec.pAxis, spec.pMag);
      p.t = project(ang, spec.tAxis, spec.tMag);
      p.st = project(ang, spec.stAxis, spec.stMag);
      if (netR >= 0) {
        p.r = netR;
        p.q = -0.05 * spec.qrsMag * (lead === 'aVR' ? 0 : 1);
        p.s = -0.13 * spec.qrsMag;
      } else {
        p.r = 0.08 * spec.qrsMag;               // small r
        p.s = netR - 0.08 * spec.qrsMag;        // deep S / QS
        p.q = 0;
      }
    } else {
      var b = spec.precordial[lead] || {};
      p.r = (b.r || 0); p.s = (b.s || 0); p.q = (b.q || 0); p.t = (b.t || 0); p.p = (b.p || 0.05);
      p.st = (b.st || 0);
      if (b.biphasicP) p.biphasicP = true;
    }

    /* ------- global flag modifiers ------- */
    if (f.peakedT) { p.tSig = 26; p.t = Math.sign(p.t || 1) * Math.max(Math.abs(p.t) * 1.6, 0.75); }
    if (f.flatT) { p.t *= 0.35; }
    if (f.longQT) { p.tOffset = spec.tOffset + 110; p.tSig = spec.tSig + 18; }
    if (f.shortQT) { p.tOffset = spec.tOffset - 70; p.tSig = spec.tSig - 8; }
    if (f.uWave) { p.u = (LIMB.indexOf(lead) >= 0) ? 0.12 : 0.18; }
    if (f.prDep) { p.prDep = (lead === 'aVR') ? -0.06 : 0.06; }          // aVR -> PR elevation
    if (f.lowP) { p.p *= 0.25; }
    if (f.noP) { p.p = 0; }
    if (f.deltaWPW) { p.delta = 1; p.deltaA = (p.r >= Math.abs(p.s) ? 1 : -1) * 0.22 * spec.qrsMag; }

    /* ------- per-lead overrides (BBB comps, S1Q3T3, strain, ...) ------- */
    var ov = spec.leadOverride[lead];
    if (ov) {
      if (ov.qrsComps) p.qrsComps = ov.qrsComps;
      if (ov.st != null) p.st = ov.st;
      if (ov.t != null) p.t = ov.t;
      if (ov.tSig != null) p.tSig = ov.tSig;
      if (ov.r != null) p.r = ov.r;
      if (ov.s != null) p.s = ov.s;
      if (ov.q != null) p.q = ov.q;
      if (ov.qrsScale != null) p.qrsScale = ov.qrsScale;
      if (ov.tInv) p.t = -Math.abs(p.t || 0.3);
      if (ov.addQ) p.q = (p.q || 0) + ov.addQ;
      if (ov.addS) p.s = (p.s || 0) + ov.addS;
      if (ov.rMul != null) p.r *= ov.rMul;
    }
    return p;
  }

  /* ------------------------------------------------------- signal builder */
  function qrsTAt(t, q0, p, ve) {
    var ws = p.qrsScale * (ve.widthScale || 1);
    var amp = (ve.ampScale != null) ? ve.ampScale : 1;
    var pol = (ve.polarity != null) ? ve.polarity : 1;
    var v = 0;
    if (p.qrsComps) {
      for (var i = 0; i < p.qrsComps.length; i++) {
        var c = p.qrsComps[i];
        v += gauss(t, c.a * amp * pol, q0 + c.mu * ws, c.sigma * ws);
      }
    } else {
      if (p.delta) v += gauss(t, p.deltaA * amp, q0 - 6, 24);   // WPW slurred delta upstroke
      v += gauss(t, p.q * amp, q0 + 8 * ws, 5 * ws);
      v += gauss(t, p.r * amp * pol, q0 + 22 * ws, 7.5 * ws);
      v += gauss(t, p.s * amp, q0 + 40 * ws, 9 * ws);
    }
    if (p.st) v += gauss(t, p.st, q0 + 92 * ws, p.stSig);
    v += gauss(t, p.t * amp * pol, q0 + p.tOffset, p.tSig);
    if (p.u) v += gauss(t, p.u, q0 + p.tOffset + 135, 44);
    return v;
  }

  function sampleLead(spec, lead, t0, durMs, dt) {
    dt = dt || 2;
    var rhythm = buildRhythm(spec, t0 + durMs);
    var p = computeLead(spec, lead);
    var rng = mulberry32((spec.seed || 1) + lead.charCodeAt(0) + (lead.charCodeAt(1) || 0));
    var wanderPh = rng() * 6.28, wanderPh2 = rng() * 6.28;
    var n = Math.round(durMs / dt), out = new Float32Array(n);
    var pe = rhythm.pEvents, ve = rhythm.vEvents;

    // vfib chaotic generator
    var vfibComps = null;
    if (rhythm.special === 'vfib') {
      vfibComps = [];
      for (var q = 0; q < 9; q++) vfibComps.push({ f: 3 + rng() * 6, ph: rng() * 6.28, a: 0.18 + rng() * 0.28 });
    }

    for (var i = 0; i < n; i++) {
      var t = t0 + i * dt;
      var v = 0;
      // atrial
      for (var a = 0; a < pe.length; a++) {
        var pt = pe[a].t;
        if (Math.abs(t - pt) < 260) {
          if (p.biphasicP) {
            v += gauss(t, Math.abs(p.p) * 0.9, pt + 30, 16) + gauss(t, -Math.abs(p.p) * 0.7, pt + 70, 16);
          } else {
            v += gauss(t, p.p * pe[a].amp, pt + 45, 19);
          }
          if (p.prDep) v += gauss(t, -p.prDep, pt + 95, 34);
        }
      }
      if (rhythm.atrialCont) v += rhythm.atrialCont(t, lead);
      // ventricular
      for (var b = 0; b < ve.length; b++) {
        if (Math.abs(t - ve[b].t) < 520) v += qrsTAt(t, ve[b].t, p, ve[b]);
      }
      // vfib chaos
      if (vfibComps) {
        for (var c = 0; c < vfibComps.length; c++) v += vfibComps[c].a * Math.sin(2 * Math.PI * vfibComps[c].f * t / 1000 + vfibComps[c].ph);
      }
      // baseline wander + fine noise (deterministic)
      v += 0.028 * Math.sin(2 * Math.PI * 0.22 * t / 1000 + wanderPh);
      v += 0.014 * Math.sin(2 * Math.PI * 0.55 * t / 1000 + wanderPh2);
      v += (rng() - 0.5) * 0.014;
      out[i] = v;
    }
    return out;
  }

  /* --------------------------------------------------------------- render */
  // Build an SVG polyline path for one lead panel.
  // opts: {pxPerMm, durMs, dt, x0, baselineY, gain(mv->px handled by pxPerMm)}
  function leadPath(spec, lead, opts) {
    var pxPerMm = opts.pxPerMm;
    var durMs = opts.durMs;
    var dt = opts.dt || 2;
    var x0 = opts.x0 || 0;
    var baselineY = opts.baselineY;
    var pxPerMs = MM_PER_S * pxPerMm / 1000;   // horizontal
    var pxPerMv = MM_PER_MV * pxPerMm;         // vertical
    var samples = sampleLead(spec, lead, 0, durMs, dt);
    var d = '';
    for (var i = 0; i < samples.length; i++) {
      var x = x0 + i * dt * pxPerMs;
      var y = baselineY - samples[i] * pxPerMv;
      d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
    }
    return d;
  }

  /* --------------------------------------------------- coronary territory */
  var TERRITORY = {
    LAD: { leads: ['V1', 'V2', 'V3', 'V4'], name: 'LAD', region: 'Anteroseptal', color: '#2563eb' },
    LCx: { leads: ['I', 'aVL', 'V5', 'V6'], name: 'LCx', region: 'Lateral', color: '#7c3aed' },
    RCA: { leads: ['II', 'III', 'aVF'], name: 'RCA', region: 'Inferior', color: '#ea580c' }
  };
  function leadTerritory(lead) {
    for (var k in TERRITORY) if (TERRITORY[k].leads.indexOf(lead) >= 0) return TERRITORY[k];
    return null;
  }
  // reciprocal partners (for ST-elevation teaching)
  var RECIP = {
    II: ['I', 'aVL'], III: ['I', 'aVL'], aVF: ['I', 'aVL'],
    I: ['III', 'aVF'], aVL: ['III', 'aVF'],
    V1: ['II', 'III', 'aVF'], V2: ['II', 'III', 'aVF']
  };
  function reciprocalLeads(lead) { return RECIP[lead] || []; }

  /* ==================================================================== */
  /* DIAGNOSIS CATALOG                                                     */
  /* Each entry: id, name, category, clinical, teaching, rate/rhythm/axis  */
  /* labels, keyLeads map (lead -> finding), territory, and engine spec.   */
  /* ==================================================================== */
  var DX = [];
  function add(o) { DX.push(o); }

  /* ---- RHYTHM ---- */
  add({
    id: 'ecg-001', name: 'Normal sinus rhythm', category: 'rhythm',
    clinical: '24-year-old healthy volunteer for a pre-participation sports physical. No symptoms.',
    rate: 72, rhythm: 'sinus', axis: 'normal', territory: null,
    keyLeads: {},
    teaching: 'Regular rhythm 60-100/min, an upright P before every QRS (upright in I and II, inverted in aVR), constant PR 120-200 ms, narrow QRS under 120 ms, and normal R-wave progression across the precordium. Establish the normal before you can call anything abnormal.',
    spec: {}
  });
  add({
    id: 'ecg-002', name: 'Sinus bradycardia', category: 'rhythm',
    clinical: 'Conditioned 30-year-old endurance athlete, resting heart rate in the 40s, asymptomatic.',
    rate: 46, rhythm: 'sinus', axis: 'normal', territory: null, keyLeads: {},
    teaching: 'Sinus mechanism with a rate under 60/min. Normal P-QRS-T; each P conducts. Common in athletes, sleep, high vagal tone, and with beta-blockers or nondihydropyridine calcium-channel blockers. Treat only if symptomatic.',
    spec: { rate: 46 }
  });
  add({
    id: 'ecg-003', name: 'Sinus tachycardia', category: 'rhythm',
    clinical: '28-year-old with fever and dehydration from gastroenteritis. Rate 122, regular.',
    rate: 122, rhythm: 'sinus', axis: 'normal', territory: null, keyLeads: {},
    teaching: 'Sinus mechanism above 100/min with a normal P before every QRS. It is a response, not a primary arrhythmia, so look for the cause: fever, pain, hypovolemia, anemia, hyperthyroidism, PE, sympathomimetics. Treat the trigger.',
    spec: { rate: 122, pr: 150 }
  });
  add({
    id: 'ecg-004', name: 'Atrial fibrillation', category: 'rhythm',
    clinical: '74-year-old with palpitations and an irregular pulse. Long-standing hypertension.',
    rate: 96, rhythm: 'afib', axis: 'normal', territory: null,
    keyLeads: { II: 'no P waves; irregular RR', V1: 'fibrillatory baseline' },
    teaching: 'Irregularly irregular RR intervals with no discrete P waves and a fibrillatory baseline (best seen in V1 and II). The commonest sustained arrhythmia. Manage rate versus rhythm control and, above all, stroke prevention guided by CHA2DS2-VASc.',
    spec: { rhythm: 'afib', rate: 96 }
  });
  add({
    id: 'ecg-005', name: 'Atrial flutter', category: 'rhythm',
    clinical: '68-year-old with palpitations; ventricular rate almost exactly 75, regular.',
    rate: 75, rhythm: 'flutter', axis: 'normal', territory: null,
    keyLeads: { II: 'sawtooth flutter waves', III: 'sawtooth flutter waves', aVF: 'sawtooth flutter waves' },
    teaching: 'Regular sawtooth flutter (F) waves at about 300/min, classically negative in II, III and aVF from a counterclockwise right-atrial macro-reentrant circuit. Ventricular rate is a fraction of 300 (2:1 gives 150, 4:1 gives 75). Definitive therapy is cavotricuspid isthmus ablation.',
    spec: { rhythm: 'flutter', atrialRate: 300, conductionRatio: 4 }
  });
  add({
    id: 'ecg-006', name: 'Supraventricular tachycardia (AVNRT)', category: 'rhythm',
    clinical: '22-year-old with abrupt-onset palpitations, rate 185, narrow and regular.',
    rate: 185, rhythm: 'svt', axis: 'normal', territory: null,
    keyLeads: { II: 'narrow regular tachycardia, no visible P' },
    teaching: 'Regular narrow-complex tachycardia around 150-250/min with P waves buried in or just after the QRS. Usually AV-nodal reentry. Try vagal maneuvers, then IV adenosine to transiently block the AV node.',
    spec: { rhythm: 'svt', rate: 185 }
  });
  add({
    id: 'ecg-007', name: 'Ventricular tachycardia', category: 'rhythm',
    clinical: '63-year-old with prior MI, palpitations and lightheadedness. Wide, regular, rate 165.',
    rate: 165, rhythm: 'vt', axis: 'normal', territory: null,
    keyLeads: { II: 'wide monomorphic tachycardia', V1: 'wide QRS' },
    teaching: 'Regular wide-complex tachycardia (QRS over 120 ms) at over 100/min. In anyone with structural heart disease assume VT until proven otherwise. Unstable means synchronized cardioversion; a pulseless patient gets defibrillation.',
    spec: { rhythm: 'vt', rate: 165, qrsWidth: 170 }
  });
  add({
    id: 'ecg-008', name: 'Ventricular fibrillation', category: 'rhythm',
    clinical: 'Collapsed 60-year-old, no pulse. Monitor shows chaotic activity.',
    rate: 0, rhythm: 'vfib', axis: null, territory: null,
    keyLeads: { II: 'chaotic, no organized QRS' },
    teaching: 'Chaotic, irregular deflections with no identifiable P, QRS or T. It is a non-perfusing rhythm. Immediate defibrillation and high-quality CPR are the only effective treatments.',
    spec: { rhythm: 'vfib', special: 'vfib' }
  });

  /* ---- CONDUCTION ---- */
  add({
    id: 'ecg-009', name: 'First-degree AV block', category: 'conduction',
    clinical: 'Routine ECG, asymptomatic 55-year-old. PR interval measures 260 ms.',
    rate: 68, rhythm: 'sinus', axis: 'normal', territory: null,
    keyLeads: { II: 'PR interval > 200 ms, every P conducts' },
    teaching: 'PR interval fixed and prolonged beyond 200 ms with 1:1 conduction (every P is followed by a QRS). Usually benign and needs no treatment on its own.',
    spec: { rhythm: 'avblock1', pr: 260, rate: 68 }
  });
  add({
    id: 'ecg-010', name: 'Mobitz I (Wenckebach)', category: 'conduction',
    clinical: 'Inferior-MI patient on telemetry; grouped beating noted.',
    rate: 60, rhythm: 'wenckebach', axis: 'normal', territory: null,
    keyLeads: { II: 'progressive PR lengthening, then a dropped QRS' },
    teaching: 'Progressive PR prolongation until a P wave fails to conduct and a QRS is dropped, producing group beating and a lengthening-then-pause pattern. Block is in the AV node, usually benign; observe or treat the cause.',
    spec: { rhythm: 'wenckebach', atrialRate: 72 }
  });
  add({
    id: 'ecg-011', name: 'Mobitz II', category: 'conduction',
    clinical: 'Syncope in a 70-year-old; constant PR with intermittent dropped beats.',
    rate: 50, rhythm: 'mobitz2', axis: 'normal', territory: null,
    keyLeads: { II: 'constant PR, sudden non-conducted P (dropped QRS)' },
    teaching: 'Fixed PR interval with sudden failure to conduct a P wave and no preceding PR lengthening. Block is infranodal (His-Purkinje), so it is unstable and prone to progress to complete block. It warrants a pacemaker.',
    spec: { rhythm: 'mobitz2', atrialRate: 75 }
  });
  add({
    id: 'ecg-012', name: 'Third-degree (complete) AV block', category: 'conduction',
    clinical: '78-year-old with fatigue and near-syncope; atrial and ventricular rates differ.',
    rate: 38, rhythm: 'chb', axis: 'normal', territory: null,
    keyLeads: { II: 'AV dissociation: P waves march through independent QRS' },
    teaching: 'Complete AV dissociation: the atria (P waves) and ventricles (escape QRS) beat independently, with the atrial rate faster than the ventricular. PR intervals are random. Treat with a permanent pacemaker.',
    spec: { rhythm: 'chb', atrialRate: 82, rate: 38, qrsWidth: 130 }
  });
  add({
    id: 'ecg-013', name: 'Right bundle branch block (RBBB)', category: 'conduction',
    clinical: 'Incidental finding on a pre-operative ECG in a 61-year-old.',
    rate: 72, rhythm: 'sinus', axis: 'normal', territory: null,
    keyLeads: { V1: "rSR' (M-shaped) wide QRS", V6: 'wide terminal S wave', I: 'wide terminal S wave' },
    teaching: "QRS over 120 ms with an rSR' (M-shaped) complex in V1-V2 and a wide slurred S wave in I and V6, plus discordant T-wave inversion in the right precordial leads. Late right-ventricular activation. Can be a normal variant.",
    spec: {
      qrsWidth: 130,
      leadOverride: {
        V1: { qrsComps: [{ a: 0.25, mu: 12, sigma: 8 }, { a: -0.35, mu: 34, sigma: 10 }, { a: 0.85, mu: 66, sigma: 12 }], t: -0.28, tSig: 46 },
        V2: { qrsComps: [{ a: 0.30, mu: 12, sigma: 8 }, { a: -0.45, mu: 34, sigma: 10 }, { a: 0.70, mu: 66, sigma: 12 }], t: -0.22 },
        V6: { qrsComps: [{ a: -0.06, mu: 8, sigma: 6 }, { a: 1.0, mu: 26, sigma: 9 }, { a: -0.45, mu: 62, sigma: 16 }] },
        I: { qrsComps: [{ a: 0.9, mu: 24, sigma: 9 }, { a: -0.4, mu: 60, sigma: 16 }] }
      }
    }
  });
  add({
    id: 'ecg-014', name: 'Left bundle branch block (LBBB)', category: 'conduction',
    clinical: '69-year-old with heart failure; broad QRS on ECG.',
    rate: 74, rhythm: 'sinus', axis: 'normal', territory: null,
    keyLeads: { V1: 'broad negative QS complex', V6: 'broad notched (M-shaped) R wave', I: 'broad monophasic R, no septal q' },
    teaching: 'QRS over 120 ms with a broad, notched, monophasic R in I, aVL, V5-V6 and a deep wide QS in V1-V3, with no septal q waves. Appropriate discordance means the ST-T points opposite the main QRS. New LBBB with ischemic symptoms is an ACS equivalent, and LBBB invalidates ordinary ST-based MI reading (use Sgarbossa).',
    spec: {
      qrsWidth: 150, axis: 20,
      leadOverride: {
        V1: { qrsComps: [{ a: 0.06, mu: 10, sigma: 8 }, { a: -1.5, mu: 55, sigma: 20 }], st: 0.18, t: 0.28 },
        V2: { qrsComps: [{ a: 0.06, mu: 10, sigma: 8 }, { a: -1.7, mu: 55, sigma: 20 }], st: 0.22, t: 0.30 },
        V3: { qrsComps: [{ a: 0.06, mu: 10, sigma: 8 }, { a: -1.3, mu: 55, sigma: 20 }], st: 0.15, t: 0.25 },
        V5: { qrsComps: [{ a: 1.2, mu: 40, sigma: 16 }, { a: 1.15, mu: 74, sigma: 16 }], st: -0.12, t: -0.30 },
        V6: { qrsComps: [{ a: 1.15, mu: 40, sigma: 16 }, { a: 1.1, mu: 74, sigma: 16 }], st: -0.12, t: -0.28 },
        I: { qrsComps: [{ a: 0.9, mu: 40, sigma: 16 }, { a: 0.85, mu: 74, sigma: 16 }], st: -0.08, t: -0.22 },
        aVL: { qrsComps: [{ a: 0.8, mu: 40, sigma: 16 }, { a: 0.75, mu: 74, sigma: 16 }], t: -0.18 }
      }
    }
  });
  add({
    id: 'ecg-015', name: 'Wolff-Parkinson-White (WPW)', category: 'conduction',
    clinical: '19-year-old with intermittent palpitations; short PR and slurred QRS upstroke.',
    rate: 74, rhythm: 'sinus', axis: 'normal', territory: null,
    keyLeads: { II: 'short PR (<120 ms), delta wave', V4: 'delta wave (slurred upstroke)' },
    teaching: 'Short PR under 120 ms, a delta wave (slurred initial QRS upstroke) and a widened QRS from pre-excitation through an accessory pathway that bypasses the AV node. Risk of AV re-entrant tachycardia; in pre-excited AFib, avoid AV-nodal blockers.',
    spec: { pr: 105, qrsWidth: 118, flags: { deltaWPW: true } }
  });

  /* ---- ISCHEMIA ---- */
  add({
    id: 'ecg-016', name: 'Acute anterior STEMI (LAD)', category: 'ischemia',
    clinical: '58-year-old man, crushing substernal chest pain for 40 minutes, diaphoretic.',
    rate: 88, rhythm: 'sinus', axis: 'normal', territory: 'LAD / anteroseptal',
    keyLeads: { V1: 'ST elevation', V2: 'ST elevation', V3: 'ST elevation', V4: 'ST elevation' },
    teaching: 'Convex ("tombstone") ST elevation across the precordial leads V1-V4 localizes to the LAD and the anteroseptal wall. This is the highest-risk territory. Reciprocal inferior ST depression may appear. Immediate reperfusion: primary PCI, or fibrinolysis if PCI is unavailable.',
    spec: {
      rate: 88, stAxis: -10, stMag: 0.08,
      precordial: { V1: { st: 0.28, t: 0.35 }, V2: { st: 0.42, t: 0.5 }, V3: { st: 0.40, t: 0.5 }, V4: { st: 0.30, t: 0.42 }, V5: { st: 0.12 } }
    }
  });
  add({
    id: 'ecg-017', name: 'Acute inferior STEMI (RCA)', category: 'ischemia',
    clinical: '66-year-old with chest pain, nausea and bradycardia; hypotensive after nitroglycerin.',
    rate: 58, rhythm: 'sinus', axis: 'normal', territory: 'RCA / inferior',
    keyLeads: { II: 'ST elevation', III: 'ST elevation', aVF: 'ST elevation', I: 'reciprocal ST depression', aVL: 'reciprocal ST depression' },
    teaching: 'ST elevation in II, III and aVF with reciprocal ST depression in I and aVL localizes to the inferior wall, usually an RCA occlusion (III elevation greater than II favors RCA). Get right-sided leads: RV involvement makes the patient preload-dependent, so avoid nitrates. Bradycardia and AV block are common.',
    spec: { rate: 58, stAxis: 100, stMag: 0.36, pr: 190 }
  });
  add({
    id: 'ecg-018', name: 'Acute lateral STEMI (LCx)', category: 'ischemia',
    clinical: '61-year-old with chest pain radiating to the left arm.',
    rate: 84, rhythm: 'sinus', axis: 'normal', territory: 'LCx / lateral',
    keyLeads: { I: 'ST elevation', aVL: 'ST elevation', V5: 'ST elevation', V6: 'ST elevation', III: 'reciprocal ST depression' },
    teaching: 'ST elevation in the lateral leads I, aVL, V5 and V6 points to the left circumflex or a diagonal branch, with reciprocal ST depression inferiorly. High lateral (I, aVL) elevation with inferior reciprocal change is a classic pairing.',
    spec: {
      rate: 84, stAxis: -30, stMag: 0.26,
      precordial: { V5: { st: 0.26, t: 0.4 }, V6: { st: 0.24, t: 0.36 }, V4: { st: 0.12 } }
    }
  });
  add({
    id: 'ecg-019', name: 'Posterior MI', category: 'ischemia',
    clinical: '60-year-old with chest pain; tall R waves and ST depression in V1-V3.',
    rate: 80, rhythm: 'sinus', axis: 'normal', territory: 'RCA/LCx / posterior',
    keyLeads: { V1: 'ST depression + tall R', V2: 'ST depression + tall R', V3: 'ST depression' },
    teaching: 'A posterior infarct is a mirror image in the anterior leads: horizontal ST depression with tall broad R waves and upright T waves in V1-V3 (R/S over 1 in V2). Confirm with posterior leads V7-V9, which show the true ST elevation. Often accompanies an inferior or lateral STEMI.',
    spec: {
      rate: 80,
      precordial: {
        V1: { r: 1.0, s: -0.25, st: -0.22, t: 0.28 },
        V2: { r: 1.3, s: -0.35, st: -0.26, t: 0.32 },
        V3: { r: 1.0, s: -0.6, st: -0.18, t: 0.2 }
      }
    }
  });
  add({
    id: 'ecg-020', name: 'NSTEMI / ischemia (ST depression, TWI)', category: 'ischemia',
    clinical: '70-year-old with exertional chest pain at rest; troponin rising, no ST elevation.',
    rate: 92, rhythm: 'sinus', axis: 'normal', territory: 'subendocardial',
    keyLeads: { V4: 'ST depression', V5: 'ST depression + T inversion', V6: 'ST depression + T inversion', I: 'T inversion', aVL: 'T inversion' },
    teaching: 'Horizontal or downsloping ST depression and symmetric T-wave inversion without ST elevation indicate subendocardial ischemia. With a positive troponin this is NSTEMI. Management is antithrombotic therapy and risk-stratified (often early) invasive angiography, not immediate lytics.',
    spec: {
      rate: 92,
      leadOverride: {
        I: { st: -0.08, tInv: true }, aVL: { st: -0.08, tInv: true },
        II: { st: -0.06 }
      },
      precordial: {
        V4: { st: -0.15, t: -0.15 }, V5: { st: -0.18, t: -0.25 }, V6: { st: -0.16, t: -0.22 }
      }
    }
  });

  /* ---- CHAMBER ENLARGEMENT ---- */
  add({
    id: 'ecg-021', name: 'Left ventricular hypertrophy (LVH)', category: 'chamber',
    clinical: '64-year-old with long-standing hypertension; loud A2 and an S4.',
    rate: 74, rhythm: 'sinus', axis: 'normal', territory: null,
    keyLeads: { V1: 'deep S wave', V2: 'deep S wave', V5: 'tall R wave + strain', V6: 'tall R wave + strain' },
    teaching: 'Voltage criteria such as Sokolow-Lyon (S in V1 plus R in V5 or V6 over 35 mm) with a lateral "strain" pattern of downsloping ST depression and asymmetric T inversion in I, aVL, V5-V6. Left axis is common. Causes: hypertension and aortic stenosis.',
    spec: {
      rate: 74, axis: 5, qrsMag: 1.9,
      precordial: {
        V1: { r: 0.18, s: -2.6 }, V2: { r: 0.35, s: -3.0 }, V3: { r: 0.7, s: -1.6 },
        V5: { r: 3.0, s: -0.2, st: -0.14, t: -0.35 }, V6: { r: 2.6, s: -0.1, st: -0.13, t: -0.32 }
      },
      leadOverride: { I: { st: -0.08, tInv: true }, aVL: { st: -0.08, tInv: true } }
    }
  });
  add({
    id: 'ecg-022', name: 'Right ventricular hypertrophy (RVH)', category: 'chamber',
    clinical: '52-year-old with COPD and pulmonary hypertension; right axis deviation.',
    rate: 86, rhythm: 'sinus', axis: 'right', territory: null,
    keyLeads: { V1: 'tall R (R>S) + strain', V6: 'deep S wave', II: 'tall peaked P (P pulmonale)' },
    teaching: 'Right axis deviation with a dominant R wave in V1 (R/S over 1) and deep S waves in V5-V6, often with right-precordial strain (TWI V1-V3) and peaked P pulmonale. Causes: pulmonary hypertension, chronic lung disease, and pulmonic stenosis.',
    spec: {
      rate: 86, axis: 115, qrsMag: 1.3, pMag: 0.2, pAxis: 75,
      precordial: {
        V1: { r: 1.3, s: -0.2, t: -0.25, st: -0.06 }, V2: { r: 1.0, s: -0.5, t: -0.2 },
        V5: { r: 0.5, s: -0.9 }, V6: { r: 0.35, s: -0.8 }
      }
    }
  });

  /* ---- METABOLIC ---- */
  add({
    id: 'ecg-023', name: 'Hyperkalemia', category: 'metabolic',
    clinical: 'Dialysis patient who missed a session; potassium 7.4 mEq/L. Tall peaked T waves.',
    rate: 70, rhythm: 'sinus', axis: 'normal', territory: null,
    keyLeads: { II: 'tall peaked (tented) T waves', V3: 'peaked T waves', V4: 'peaked T waves' },
    teaching: 'Sequence with rising K+: tall narrow peaked (tented) T waves first, then PR prolongation and P-wave flattening, then QRS widening, and finally a sine-wave pattern preceding arrest. Treat with IV calcium (membrane stabilization), then insulin plus glucose and albuterol to shift K+, then dialysis or other removal.',
    spec: { rate: 70, qrsWidth: 118, pr: 210, flags: { peakedT: true, lowP: true } }
  });
  add({
    id: 'ecg-024', name: 'Hypokalemia', category: 'metabolic',
    clinical: 'Patient on high-dose loop diuretics with weakness; potassium 2.6 mEq/L.',
    rate: 76, rhythm: 'sinus', axis: 'normal', territory: null,
    keyLeads: { II: 'U waves, flattened T', V3: 'prominent U wave', V4: 'prominent U wave, ST depression' },
    teaching: 'Flattened T waves, ST depression and prominent U waves (a positive deflection after the T), which can fuse into an apparent long QT. Predisposes to torsades. Replace potassium and check magnesium, since hypokalemia is refractory until the magnesium is corrected.',
    spec: { rate: 76, flags: { uWave: true, flatT: true }, leadOverride: { II: { st: -0.05 }, V4: { st: -0.08 }, V5: { st: -0.06 } } }
  });

  /* ---- OTHER ---- */
  add({
    id: 'ecg-025', name: 'Acute pericarditis', category: 'other',
    clinical: '32-year-old with sharp pleuritic chest pain, better leaning forward, after a viral illness.',
    rate: 96, rhythm: 'sinus', axis: 'normal', territory: null,
    keyLeads: { II: 'diffuse concave ST elevation, PR depression', I: 'concave ST elevation', V5: 'concave ST elevation', aVR: 'PR elevation, ST depression' },
    teaching: 'Diffuse, concave-upward ST elevation across multiple territories with PR-segment depression, and reciprocal PR elevation with ST depression in aVR. The widespread distribution (not fitting one artery) and PR changes separate it from STEMI. Spodick sign and later T-wave inversion may follow.',
    spec: {
      rate: 96, stAxis: 45, stMag: 0.13, flags: { prDep: true },
      precordial: { V2: { st: 0.1 }, V3: { st: 0.12 }, V4: { st: 0.12 }, V5: { st: 0.11 }, V6: { st: 0.09 } }
    }
  });
  add({
    id: 'ecg-026', name: 'Brugada syndrome (type 1)', category: 'other',
    clinical: '35-year-old man, family history of sudden death; coved ST elevation in V1-V2.',
    rate: 72, rhythm: 'sinus', axis: 'normal', territory: null,
    keyLeads: { V1: 'coved ST elevation, T inversion', V2: 'coved ST elevation, T inversion' },
    teaching: 'Type 1 pattern: a coved (downsloping) ST elevation of at least 2 mm descending into an inverted T wave in the right precordial leads V1-V2, from a sodium-channelopathy. Risk of polymorphic VT and sudden cardiac death; an ICD is the only proven protection.',
    spec: {
      rate: 72,
      leadOverride: {
        V1: { qrsComps: [{ a: 0.2, mu: 12, sigma: 8 }, { a: 0.55, mu: 40, sigma: 12 }, { a: 0.5, mu: 70, sigma: 26 }], st: 0, t: -0.32, tSig: 46 },
        V2: { qrsComps: [{ a: 0.25, mu: 12, sigma: 8 }, { a: 0.6, mu: 40, sigma: 12 }, { a: 0.55, mu: 70, sigma: 26 }], st: 0, t: -0.35, tSig: 46 }
      }
    }
  });
  add({
    id: 'ecg-027', name: 'Pulmonary embolism (right heart strain)', category: 'other',
    clinical: '54-year-old post-op with sudden dyspnea and pleuritic pain; sinus tachycardia.',
    rate: 112, rhythm: 'sinus', axis: 'right', territory: null,
    keyLeads: { I: 'S wave (S1)', III: 'Q wave and T inversion (Q3T3)', V1: 'T inversion (RV strain)', V2: 'T inversion' },
    teaching: 'The most common finding is plain sinus tachycardia. The classic (but insensitive) S1Q3T3 is an S wave in I, with a Q wave and inverted T in III, from acute right-heart strain; right precordial T-wave inversion and a new incomplete RBBB may appear. Diagnose with CT angiography, not the ECG.',
    spec: {
      rate: 112, axis: 100,
      leadOverride: {
        I: { addS: -0.35 },
        III: { addQ: -0.22, tInv: true },
        aVF: { tInv: true }
      },
      precordial: { V1: { t: -0.22 }, V2: { t: -0.25 }, V3: { t: -0.15 } }
    }
  });
  add({
    id: 'ecg-028', name: 'Long QT syndrome', category: 'other',
    clinical: '17-year-old with exertional syncope; family history of sudden death. QTc 520 ms.',
    rate: 68, rhythm: 'sinus', axis: 'normal', territory: null,
    keyLeads: { II: 'prolonged QT interval', V4: 'prolonged QT, broad T' },
    teaching: 'QT prolonged for rate (QTc over 470 ms in men, over 480 ms in women), from congenital channelopathy or acquired causes (drugs, hypokalemia, hypomagnesemia, hypocalcemia). The danger is torsades de pointes. Remove offending drugs, correct electrolytes, and consider beta-blockers or an ICD.',
    spec: { rate: 68, flags: { longQT: true } }
  });
  add({
    id: 'ecg-029', name: 'Torsades de pointes', category: 'other',
    clinical: 'Patient on QT-prolonging drugs with syncope; polymorphic wide-complex tachycardia.',
    rate: 240, rhythm: 'torsades', axis: null, territory: null,
    keyLeads: { II: 'polymorphic VT twisting around baseline' },
    teaching: 'Polymorphic VT in which the QRS amplitude and axis appear to twist around the baseline, arising from a prolonged QT. Treat with IV magnesium, correct electrolytes, stop the offending drug, and increase the rate (pacing or isoproterenol); defibrillate if unstable.',
    spec: { rhythm: 'torsades', rate: 240, qrsWidth: 150 }
  });
  add({
    id: 'ecg-030', name: 'Digitalis effect', category: 'other',
    clinical: '72-year-old on digoxin for rate control; scooped ST segments (not toxicity).',
    rate: 66, rhythm: 'sinus', axis: 'normal', territory: null,
    keyLeads: { V5: 'scooped ("Salvador Dali") ST depression', V6: 'scooped ST depression', II: 'sagging ST, short QT' },
    teaching: 'Therapeutic digitalis produces a sagging, scooped ST depression (the "Salvador Dali mustache"), a short QT and flattened or inverted T waves, most visible in leads with tall R waves. This is a drug effect, not toxicity; toxicity instead causes arrhythmias such as atrial tachycardia with block or bidirectional VT.',
    spec: {
      rate: 66, flags: { shortQT: true },
      leadOverride: { II: { st: -0.08 }, III: { st: -0.06 }, aVF: { st: -0.06 } },
      precordial: { V4: { st: -0.1, t: -0.06 }, V5: { st: -0.14, t: -0.08 }, V6: { st: -0.12, t: -0.06 } }
    }
  });

  // Resolve each DX into a full engine spec (merge overrides onto base)
  DX.forEach(function (d) { d.engineSpec = mergeSpec(d.spec || {}); });

  /* ------------------------------------------------------- axis helper */
  // Determine axis category from net QRS in I and aVF (and II for LAD threshold).
  function axisFromLeads(spec) {
    var i = project(0, spec.axis, spec.qrsMag);
    var f = project(90, spec.axis, spec.qrsMag);
    var ii = project(60, spec.axis, spec.qrsMag);
    if (i >= 0 && f >= 0) return 'normal';
    if (i >= 0 && f < 0) return (ii < 0) ? 'left' : 'normal';
    if (i < 0 && f >= 0) return 'right';
    return 'extreme';
  }

  /* --------------------------------------------------------- SVG render */
  // Choose a vertical gain (mm/mV, <=10 standard) that fits the tallest
  // deflection of the case into the panel, so every lead stays on ONE scale.
  function fitGain(spec, leads, durMs, halfHeightMm) {
    var maxAbs = 0.6;
    for (var i = 0; i < leads.length; i++) {
      var s = sampleLead(spec, leads[i], 0, durMs, 6);
      for (var k = 0; k < s.length; k++) { var a = Math.abs(s[k]); if (a > maxAbs) maxAbs = a; }
    }
    return Math.min(10, (halfHeightMm - 1.5) / maxAbs);
  }

  var _gridSeq = 0;
  function gridDefs(pxPerMm, prefix) {
    var mm = pxPerMm, big = pxPerMm * 5;
    return '<defs>' +
      '<pattern id="' + prefix + 'sm" width="' + mm + '" height="' + mm + '" patternUnits="userSpaceOnUse">' +
      '<path d="M ' + mm + ' 0 L 0 0 0 ' + mm + '" fill="none" stroke="var(--ecg-grid-minor)" stroke-width="0.5"/></pattern>' +
      '<pattern id="' + prefix + 'lg" width="' + big + '" height="' + big + '" patternUnits="userSpaceOnUse">' +
      '<rect width="' + big + '" height="' + big + '" fill="url(#' + prefix + 'sm)"/>' +
      '<path d="M ' + big + ' 0 L 0 0 0 ' + big + '" fill="none" stroke="var(--ecg-grid-major)" stroke-width="1"/></pattern>' +
      '</defs>';
  }

  // One lead panel as a self-contained <svg>. o: {durMs,pxPerMm,heightMm,gain,
  // label,showCal,baselineFrac}. Returns SVG markup string.
  function panelSVG(spec, lead, o) {
    o = o || {};
    var pxPerMm = o.pxPerMm || 4;
    var durMs = o.durMs || 2500;
    var hMm = o.heightMm || 38;
    var wMm = durMs / 1000 * MM_PER_S;
    var W = Math.round(wMm * pxPerMm), H = Math.round(hMm * pxPerMm);
    var baseY = H * (o.baselineFrac || 0.5);
    var gain = o.gain || 10;
    var pxPerMv = gain * pxPerMm, pxPerMs = MM_PER_S * pxPerMm / 1000;
    var pfx = 'g' + (_gridSeq++) + '_';
    var s = gridDefs(pxPerMm, pfx);
    s += '<rect width="' + W + '" height="' + H + '" fill="url(#' + pfx + 'lg)"/>';
    // optional calibration pulse (1 mV, 200 ms) at left
    var x0 = 4;
    if (o.showCal) {
      var ch = pxPerMv, cw = 0.2 * MM_PER_S * pxPerMm;
      s += '<path d="M2 ' + baseY + ' L' + (2 + cw * 0.4) + ' ' + baseY + ' L' + (2 + cw * 0.4) + ' ' + (baseY - ch) +
        ' L' + (2 + cw) + ' ' + (baseY - ch) + ' L' + (2 + cw) + ' ' + baseY + ' L' + (2 + cw * 1.4) + ' ' + baseY + '" fill="none" stroke="var(--ecg-trace)" stroke-width="1.4"/>';
      x0 = 2 + cw * 1.6;
    }
    var samples = sampleLead(spec, lead, 0, durMs, 2);
    var avail = W - x0 - 2;
    var d = '';
    for (var i = 0; i < samples.length; i++) {
      var x = x0 + i * 2 * pxPerMs;
      if (x > x0 + avail) break;
      var y = baseY - samples[i] * pxPerMv;
      d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
    }
    s += '<path d="' + d + '" fill="none" stroke="var(--ecg-trace)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>';
    if (o.label) s += '<text x="' + (x0 + 2) + '" y="16" font-size="12" font-weight="700" fill="var(--ecg-trace)" font-family="inherit">' + o.label + '</text>';
    return '<svg class="ecg-panel-svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">' + s + '</svg>';
  }

  // Full 12-lead + rhythm strip block (used by QA harness and non-interactive views)
  function twelveLeadSVG(spec, o) {
    o = o || {};
    var pxPerMm = o.pxPerMm || 3.6;
    var durMs = 2500, hMm = 34;
    var gain = fitGain(spec, ALL12, durMs, hMm / 2);
    var cellW = Math.round(durMs / 1000 * MM_PER_S * pxPerMm);
    var cellH = Math.round(hMm * pxPerMm);
    var out = '<div class="ecg-12-grid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:2px;">';
    for (var r = 0; r < LAYOUT_ROWS.length; r++) {
      for (var c = 0; c < LAYOUT_ROWS[r].length; c++) {
        var L = LAYOUT_ROWS[r][c];
        out += '<div class="ecg-cell">' + panelSVG(spec, L, { durMs: durMs, pxPerMm: pxPerMm, heightMm: hMm, gain: gain, label: L, showCal: (r === 0 && c === 0) }) + '</div>';
      }
    }
    out += '</div>';
    out += '<div class="ecg-rhythm" style="margin-top:2px;">' + panelSVG(spec, 'II', { durMs: 10000, pxPerMm: pxPerMm, heightMm: 30, gain: gain, label: 'II', showCal: true }) + '</div>';
    return out;
  }

  /* ------------------------------------------------------------- exports */
  var API = {
    fitGain: fitGain, panelSVG: panelSVG, twelveLeadSVG: twelveLeadSVG, gridDefs: gridDefs,
    MM_PER_S: MM_PER_S, MM_PER_MV: MM_PER_MV,
    LIMB: LIMB, PREC: PREC, ALL12: ALL12, LAYOUT_ROWS: LAYOUT_ROWS, LIMB_ANGLE: LIMB_ANGLE,
    gauss: gauss, project: project, mulberry32: mulberry32,
    baseSpec: baseSpec, mergeSpec: mergeSpec, buildRhythm: buildRhythm,
    computeLead: computeLead, sampleLead: sampleLead, leadPath: leadPath,
    TERRITORY: TERRITORY, leadTerritory: leadTerritory, reciprocalLeads: reciprocalLeads,
    axisFromLeads: axisFromLeads,
    DX: DX,
    byId: function (id) { return DX.filter(function (d) { return d.id === id; })[0]; },
    byCategory: function (c) { return DX.filter(function (d) { return d.category === c; }); },
    CATEGORIES: [
      { id: 'rhythm', label: 'Rhythm' },
      { id: 'conduction', label: 'Conduction' },
      { id: 'ischemia', label: 'Ischemia / infarct' },
      { id: 'chamber', label: 'Chamber enlargement' },
      { id: 'metabolic', label: 'Metabolic / electrolyte' },
      { id: 'other', label: 'Other' }
    ]
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.ECG = API;

})(typeof window !== 'undefined' ? window : globalThis);
