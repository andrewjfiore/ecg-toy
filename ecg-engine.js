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
        // width comes from spec.qrsWidth (170 ms) now that the template is
        // calibrated; the old 2.2x here was compensating for the narrow template
        // and would double-count, rendering a ~340 ms complex.
        while (tvt < durMs + rrv) { vEvents.push({ t: tvt, widthScale: 1, ampScale: 1 }); tvt += rrv; }
        break;
      }
      case 'torsades': { // polymorphic VT: amplitude/polarity envelope twists
        var rrt = 60000 / (spec.rate || 230);
        var tt = 300, k = 0;
        while (tt < durMs + rrt) {
          var env = Math.sin(2 * Math.PI * 0.55 * tt / 1000); // twisting envelope
          // width from spec.qrsWidth (150 ms); the twisting envelope stays in
          // ampScale/polarity, which is what actually makes torsades recognisable
          vEvents.push({ t: tt, widthScale: 1, ampScale: 0.6 + 0.9 * Math.abs(env), polarity: env >= 0 ? 1 : -1 });
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
      prDep: 0, delta: 0, deltaA: 0, qrsComps: null, biphasicP: false,
      qtScale: 1
    };

    /* QT tracks heart rate. Without this the engine drew a fixed ~390 ms QT at
       every rate, so the same repolarization read as an abnormally SHORT QT at
       46/min (QTc 344) and as frank LONG QT at 122/min (QTc 585) - the sinus
       tachycardia case measured out in the long-QT range. Scaling the ST-T
       interval by the square root of RR is Bazett rearranged, which is the
       correction a reader applies at the bedside, so what is drawn now matches
       the measurement a student is being taught to take. Clamped so the very fast
       rhythms do not collapse the T into the following QRS. */
    var rrMs = 60000 / (spec.rate && spec.rate > 20 ? spec.rate : 72);
    p.qtScale = Math.min(1.45, Math.max(0.55, Math.sqrt(rrMs / 833)));

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

  /* Calibrates the default QRS template so the rendered complex matches
     spec.qrsWidth on the grid. Measured empirically: see measure-qrs.js. */
  var QRS_CAL = 1.92;

  /* Milliseconds after the QRS onset at which the complex has decayed - the J
     point. Anything measuring the ST segment has to start from this rather than a
     fixed offset, because it moves with spec.qrsWidth: a 150 ms LBBB complex is
     still mid-QRS where a 90 ms complex is already on its ST segment. */
  function qrsEndMs(spec, lead) {
    var p = computeLead(spec, lead);
    if (p.qrsComps) {
      var end = 0;
      for (var i = 0; i < p.qrsComps.length; i++) {
        var c = p.qrsComps[i], e = (c.mu + 2.5 * c.sigma) * p.qrsScale;
        if (e > end) end = e;
      }
      return end;
    }
    return (40 + 2.5 * 9) * p.qrsScale * QRS_CAL;
  }

  /* ------------------------------------------------------- signal builder */
  function qrsTAt(t, q0, p, ve) {
    var ws = p.qrsScale * (ve.widthScale || 1);
    var amp = (ve.ampScale != null) ? ve.ampScale : 1;
    var pol = (ve.polarity != null) ? ve.polarity : 1;
    var v = 0;
    var qrsEnd;                                   // ms after q0 where the QRS has decayed
    if (p.qrsComps) {
      for (var i = 0; i < p.qrsComps.length; i++) {
        var c = p.qrsComps[i];
        v += gauss(t, c.a * amp * pol, q0 + c.mu * ws, c.sigma * ws);
        var e = (c.mu + 2.5 * c.sigma) * ws;
        if (qrsEnd == null || e > qrsEnd) qrsEnd = e;
      }
    } else {
      /* The default q/r/s triplet spans only ~0.52x its nominal duration once the
         Gaussian tails drop below what a reader can see, so spec.qrsWidth was not
         the rendered width: a normal 90 ms QRS drew at ~47 ms, and RBBB, LBBB and
         the complete-heart-block escape all drew NARROW (66-76 ms) in the eight
         leads that carry no qrsComps override. That inverts the defining feature
         of a bundle branch block. QRS_CAL restores rendered ~= nominal.
         It is applied ONLY here: qrsComps overrides above were hand-tuned against
         the uncalibrated scale and already render their intended width. */
      var wsd = ws * QRS_CAL;
      if (p.delta) v += gauss(t, p.deltaA * amp, q0 - 6, 24);   // WPW slurred delta upstroke
      v += gauss(t, p.q * amp, q0 + 8 * wsd, 5 * wsd);
      v += gauss(t, p.r * amp * pol, q0 + 22 * wsd, 7.5 * wsd);
      v += gauss(t, p.s * amp, q0 + 40 * wsd, 9 * wsd);
      qrsEnd = (40 + 2.5 * 9) * wsd;
    }
    /* The ST bump has to sit AFTER the QRS, not inside it. It used to be pinned at
       a flat 92 ms, which worked only because the uncalibrated complex ended by
       ~60 ms. Once the QRS renders its true width the S-wave tail reaches 92 ms and
       cancels the elevation -- anterior STEMI measured -0.11 mV in V2. Tying the ST
       to the computed QRS end keeps the same 30 ms J-point gap at every width
       (62.5 + 30 = 92.5, so normal-width output is unchanged). */
    if (p.st) v += gauss(t, p.st, q0 + qrsEnd + 30, p.stSig);
    /* The T wave is placed relative to the J point, not to the QRS onset. tOffset
       was authored against a J point of ~62.5 ms, so that offset is preserved and
       the ST segment keeps its length as the QRS widens. This is also the correct
       physiology: QT contains the QRS, so a 150 ms LBBB complex lengthens QT
       rather than eating into the ST segment. */
    var tCenter = q0 + qrsEnd + (p.tOffset - 62.5) * p.qtScale;
    v += gauss(t, p.t * amp * pol, tCenter, p.tSig * p.qtScale);
    if (p.u) v += gauss(t, p.u, tCenter + 135 * p.qtScale, 44 * p.qtScale);
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
    clinicals: [
      "A 34-year-old woman comes to the emergency department with two hours of chest discomfort that began while she was sitting at her desk this afternoon, the fourth such episode this month. She has no cardiac history, takes no medications, and her blood pressure at triage is 118/72 when a tracing is obtained.",
      "A 58-year-old woman is brought in by ambulance after she felt suddenly lightheaded at a grocery store and slid to the floor, waking within seconds without confusion. She takes lisinopril for hypertension, her blood pressure on arrival is 126/80, and paramedics recorded a tracing en route.",
      "A 62-year-old man is on hospital day three for community-acquired pneumonia and tells the team he has felt washed out since breakfast. He has been afebrile for 24 hours and is off supplemental oxygen, he is alert and warm and well perfused, and his blood pressure is 130/78 when a tracing is obtained on rounds."
    ],
    rate: 72, rhythm: 'sinus', axis: 'normal', territory: null,
    keyLeads: {},
    teaching: 'Regular rhythm 60-100/min, an upright P before every QRS (upright in I and II, inverted in aVR), constant PR 120-200 ms, narrow QRS under 120 ms, and normal R-wave progression across the precordium. Establish the normal before you can call anything abnormal.',
    spec: {}
  });
  add({
    id: 'ecg-002', name: 'Sinus bradycardia', category: 'rhythm',
    clinicals: [
      "A 19-year-old woman presents to student health for a pre-participation physical before the cross country season. She runs about 50 miles a week, takes no medications, and denies chest pain, palpitations, lightheadedness, or exercise intolerance; BP 110/66 and the cardiac exam is unremarkable.",
      "A 66-year-old man comes to the emergency department after realizing he took his morning blood pressure pill a second time by mistake. He feels mildly lightheaded when he stands but is alert and conversant, with warm extremities, clear lungs, and BP 108/62.",
      "A 52-year-old woman is on hospital day 2 of IV antibiotics for leg cellulitis and is resting overnight on telemetry. The night nurse obtains a routine tracing at 3 am; the patient is asleep, rouses easily, reports no symptoms, and has BP 118/72 with the erythema on her shin already receding."
    ],
    rate: 46, rhythm: 'sinus', axis: 'normal', territory: null, keyLeads: {},
    teaching: 'Sinus mechanism with a rate under 60/min. Normal P-QRS-T; each P conducts. Common in athletes, sleep, high vagal tone, and with beta-blockers or nondihydropyridine calcium-channel blockers. Treat only if symptomatic.',
    spec: { rate: 46 }
  });
  add({
    id: 'ecg-003', name: 'Sinus tachycardia', category: 'rhythm',
    clinicals: [
      "A 19-year-old man is in the emergency department with two days of worsening wheeze and cough after a viral upper respiratory infection, and he has taken three albuterol nebulizer treatments in the last hour. He is anxious and sitting forward, respiratory rate 26, blood pressure 128/74, temperature 37.1 C, oxygen saturation 93 percent on room air.",
      "A 34-year-old woman is on the medical ward receiving her second day of intravenous antibiotics for pyelonephritis. Her flank pain has improved, temperature is 38.8 C, blood pressure 108/66, and respiratory rate 20.",
      "A 58-year-old man comes to clinic with six weeks of fatigue and shortness of breath climbing his stairs, and he has been taking naproxen twice daily for knee arthritis and passing black tarry stools for the past week. He is pale with blanched conjunctivae, alert and conversant, with a blood pressure of 118/72 and a soft nontender abdomen."
    ],
    rate: 122, rhythm: 'sinus', axis: 'normal', territory: null, keyLeads: {},
    teaching: 'Sinus mechanism above 100/min with a normal P before every QRS. It is a response, not a primary arrhythmia, so look for the cause: fever, pain, hypovolemia, anemia, hyperthyroidism, PE, sympathomimetics. Treat the trigger.',
    spec: { rate: 122, pr: 150 }
  });
  add({
    id: 'ecg-004', name: 'Atrial fibrillation', category: 'rhythm',
    clinicals: [
      "A 70-year-old man with long-standing hypertension, obesity, and obstructive sleep apnea is seen in the pre-op clinic before an elective inguinal hernia repair. He denies chest pain or breathlessness, his blood pressure is 138/86, and a screening tracing is obtained.",
      "A 34-year-old woman comes to the emergency department with two days of palpitations and fatigue that began during a stretch of long shifts and poor sleep. She has no cardiac history, her blood pressure is 124/78, her temperature is 36.9 C, and she is comfortable at rest.",
      "A 58-year-old woman who had rheumatic fever as a child reports two months of getting winded carrying groceries up one flight of stairs, worse in the last week. Her blood pressure is 118/72, her oxygen saturation is 96 percent on room air, and a low-pitched diastolic murmur is audible at the apex."
    ],
    rate: 96, rhythm: 'afib', axis: 'normal', territory: null,
    keyLeads: { II: 'no P waves; irregular RR', V1: 'fibrillatory baseline' },
    teaching: 'Irregularly irregular RR intervals with no discrete P waves and a fibrillatory baseline (best seen in V1 and II). The commonest sustained arrhythmia. Manage rate versus rhythm control and, above all, stroke prevention guided by CHA2DS2-VASc.',
    spec: { rhythm: 'afib', rate: 96 }
  });
  add({
    id: 'ecg-005', name: 'Atrial flutter', category: 'rhythm',
    clinicals: [
      "A 71-year-old woman is seen in the pre-op clinic before elective knee replacement. She reports six weeks of intermittent palpitations at rest and getting winded on one flight of stairs; she is alert and comfortable, BP 132/78, lungs clear.",
      "A 58-year-old man is on telemetry on postoperative day 3 after right upper lobectomy. Overnight he noticed palpitations and became short of breath walking to the bathroom; he is comfortable now, warm and well perfused, BP 124/76, oxygen saturation 95 percent on room air.",
      "A 34-year-old woman with an atrial septal defect repaired surgically in childhood comes to the emergency department with two days of palpitations and lightheadedness on standing. She is alert and well perfused, BP 118/72, temperature 37.0 C."
    ],
    rate: 75, rhythm: 'flutter', axis: 'normal', territory: null,
    keyLeads: { II: 'sawtooth flutter waves', III: 'sawtooth flutter waves', aVF: 'sawtooth flutter waves' },
    teaching: 'Regular sawtooth flutter (F) waves at about 300/min, classically negative in II, III and aVF from a counterclockwise right-atrial macro-reentrant circuit. Ventricular rate is a fraction of 300 (2:1 gives 150, 4:1 gives 75). Definitive therapy is cavotricuspid isthmus ablation.',
    spec: { rhythm: 'flutter', atrialRate: 300, conductionRatio: 4 }
  });
  add({
    id: 'ecg-006', name: 'Supraventricular tachycardia (AVNRT)', category: 'rhythm',
    clinicals: [
      "A 24-year-old woman comes to the emergency department after the sudden onset of palpitations and mild chest discomfort while she was sitting on the couch watching television. She is alert and anxious but warm and well perfused, with blood pressure 104/68, temperature 37.0 C, respiratory rate 18, and oxygen saturation 99 percent on room air, and she reports three similar spells in the past year.",
      "A 58-year-old man waiting in preoperative holding for elective cataract surgery reports palpitations that began a few minutes ago while he was reading. He is comfortable and afebrile on maintenance fluids, blood pressure 118/74, respiratory rate 16, lungs clear, and he takes no cardiac medications.",
      "Paramedics are called to a farmers market for a 33-year-old woman who developed palpitations and lightheadedness while she was standing at a booth. She is alert and speaking in full sentences with warm dry skin, blood pressure 100/64, afebrile, and she has no chest injury, no bleeding and no known heart disease."
    ],
    rate: 185, rhythm: 'svt', axis: 'normal', territory: null,
    keyLeads: { II: 'narrow regular tachycardia, no visible P' },
    teaching: 'Regular narrow-complex tachycardia around 150-250/min with P waves buried in or just after the QRS. Usually AV-nodal reentry. Try vagal maneuvers, then IV adenosine to transiently block the AV node.',
    spec: { rhythm: 'svt', rate: 185 }
  });
  add({
    id: 'ecg-007', name: 'Ventricular tachycardia', category: 'rhythm',
    clinicals: [
      "A 58-year-old man is on day three of his admission for an anterior myocardial infarction treated with stenting when he abruptly develops palpitations and lightheadedness. He is awake and diaphoretic with cool fingertips, and his blood pressure is 88/54.",
      "A 24-year-old woman collapses at the end of a club soccer match and is awake but pale and confused when the ambulance crew reaches her. Her brother died suddenly at 19, her blood pressure is 94/60, and her teammates say she has had two prior episodes of palpitations during hard exertion.",
      "A 66-year-old woman waiting in pre-op holding for a laparoscopic cholecystectomy becomes lightheaded and short of breath while her IV is being placed. She has a cardiomyopathy from the doxorubicin she received for breast cancer eight years ago, and she is now cool and clammy with a blood pressure of 92/58."
    ],
    rate: 165, rhythm: 'vt', axis: 'normal', territory: null,
    keyLeads: { II: 'wide monomorphic tachycardia', V1: 'wide QRS' },
    teaching: 'Regular wide-complex tachycardia (QRS over 120 ms) at over 100/min. In anyone with structural heart disease assume VT until proven otherwise. Unstable means synchronized cardioversion; a pulseless patient gets defibrillation.',
    spec: { rhythm: 'vt', rate: 165, qrsWidth: 170 }
  });
  add({
    id: 'ecg-008', name: 'Ventricular fibrillation', category: 'rhythm',
    clinicals: [
      "A 52-year-old woman with hypertension and a 30 pack-year smoking history is found slumped at the kitchen table by her husband, who starts chest compressions immediately. Paramedics arrive six minutes later and find her unresponsive and apneic with no palpable carotid pulse, and this strip is recorded during a pause in compressions.",
      "A 68-year-old woman is on the step-down unit on hospital day 2 after primary PCI for an anterior myocardial infarction, and she was awake and comfortable at the last nursing check. The telemetry alarm sounds, and the nurse finds her unresponsive with no carotid pulse and an unobtainable blood pressure.",
      "A 19-year-old collegiate swimmer collapses at practice and arrives with bystander CPR in progress after 10 minutes. He is unresponsive with no palpable femoral pulse and no spontaneous respirations, and his coach reports that an uncle died suddenly at age 30."
    ],
    rate: 0, rhythm: 'vfib', axis: null, territory: null,
    keyLeads: { II: 'chaotic, no organized QRS' },
    teaching: 'Chaotic, irregular deflections with no identifiable P, QRS or T. It is a non-perfusing rhythm. Immediate defibrillation and high-quality CPR are the only effective treatments.',
    spec: { rhythm: 'vfib', special: 'vfib' }
  });

  /* ---- CONDUCTION ---- */
  add({
    id: 'ecg-009', name: 'First-degree AV block', category: 'conduction',
    clinicals: [
      "A 74-year-old woman returns to clinic two weeks after her atenolol dose was doubled for uncontrolled hypertension. She reports no dizziness, chest pain, or change in her usual two-mile walks; blood pressure is 134/78 and she is alert and well perfused with warm extremities.",
      "A 26-year-old landscaper comes to the emergency department with a week of fatigue and an expanding red rash on his thigh that appeared days after he pulled a tick off in June. He denies syncope, lightheadedness, and chest pain; temperature is 37.4 C, blood pressure 122/74, and an ECG is obtained as part of his evaluation.",
      "A 52-year-old woman is evaluated before elective bariatric surgery. She has obstructive sleep apnea treated with nightly CPAP, takes no cardiac medications, and has no exertional symptoms; blood pressure is 128/76 and the cardiac exam is unremarkable."
    ],
    rate: 68, rhythm: 'sinus', axis: 'normal', territory: null,
    keyLeads: { II: 'PR interval > 200 ms, every P conducts' },
    teaching: 'PR interval fixed and prolonged beyond 200 ms with 1:1 conduction (every P is followed by a QRS). Usually benign and needs no treatment on its own.',
    spec: { rhythm: 'avblock1', pr: 260, rate: 68 }
  });
  add({
    id: 'ecg-010', name: 'Mobitz I (Wenckebach)', category: 'conduction',
    clinicals: [
      "A 24-year-old collegiate distance runner is seen in the training room for preseason clearance. She feels well overall but reports two brief episodes of lightheadedness while lying down after long runs; blood pressure is 112/68, she is alert and conversant, and there is no murmur.",
      "A 58-year-old man is on telemetry on hospital day 2 after emergent stenting of an occluded right coronary artery. He is comfortable with no recurrent chest pain, blood pressure 116/72, lungs clear, and extremities warm and well perfused.",
      "A 67-year-old woman is evaluated in the pre-op clinic before total knee arthroplasty. Her diltiazem dose was doubled two weeks ago for blood pressure control, and since then she has felt mildly tired on her usual walks; blood pressure today is 124/76 and she is alert and in no distress."
    ],
    rate: 60, rhythm: 'wenckebach', axis: 'normal', territory: null,
    keyLeads: { II: 'progressive PR lengthening, then a dropped QRS' },
    teaching: 'Progressive PR prolongation until a P wave fails to conduct and a QRS is dropped, producing group beating and a lengthening-then-pause pattern. Block is in the AV node, usually benign; observe or treat the cause.',
    spec: { rhythm: 'wenckebach', atrialRate: 72 }
  });
  add({
    id: 'ecg-011', name: 'Mobitz II', category: 'conduction',
    clinicals: [
      "A 71-year-old woman is brought in after collapsing at a bus stop with no warning, striking her cheek on the curb and coming around within seconds. Her only medication is lisinopril, she is alert and conversant, and her blood pressure is 128/74.",
      "A 46-year-old woman with biopsy-proven pulmonary sarcoidosis reports three months of fatigue and lightheadedness whenever she climbs the stairs at work. Her lungs are clear, her blood pressure is 118/72 and her oxygen saturation is 98 percent on room air.",
      "A 66-year-old man is evaluated before elective knee replacement and mentions a month of feeling washed out and short of breath on hills. He takes only atorvastatin, he is afebrile and warm and well perfused, and his blood pressure is 134/80."
    ],
    rate: 50, rhythm: 'mobitz2', axis: 'normal', territory: null,
    keyLeads: { II: 'constant PR, sudden non-conducted P (dropped QRS)' },
    teaching: 'Fixed PR interval with sudden failure to conduct a P wave and no preceding PR lengthening. Block is infranodal (His-Purkinje), so it is unstable and prone to progress to complete block. It warrants a pacemaker.',
    spec: { rhythm: 'mobitz2', atrialRate: 75 }
  });
  add({
    id: 'ecg-012', name: 'Third-degree (complete) AV block', category: 'conduction',
    clinicals: [
      "EMS is called for an 81-year-old woman found sitting on her kitchen floor after a witnessed collapse. She is pale and slow to answer with cool hands, blood pressure 84/52, and she reports this is the third time in a month her legs have suddenly given out.",
      "A 29-year-old landscaper in rural Connecticut comes to clinic with three weeks of fever, aching joints, and an expanding rash on his thigh that appeared after a tick bite. He now feels lightheaded climbing stairs; he is alert and conversant, temperature 37.4 C, blood pressure 104/64.",
      "A 74-year-old woman is on telemetry on postoperative day two after surgical aortic valve replacement. Overnight she becomes dizzy and diaphoretic when the nurse sits her upright, with blood pressure 88/56 and clear lungs."
    ],
    rate: 38, rhythm: 'chb', axis: 'normal', territory: null,
    keyLeads: { II: 'AV dissociation: P waves march through independent QRS' },
    teaching: 'Complete AV dissociation: the atria (P waves) and ventricles (escape QRS) beat independently, with the atrial rate faster than the ventricular. PR intervals are random. Treat with a permanent pacemaker.',
    spec: { rhythm: 'chb', atrialRate: 82, rate: 38, qrsWidth: 130 }
  });
  add({
    id: 'ecg-013', name: 'Right bundle branch block (RBBB)', category: 'conduction',
    clinicals: [
      "A 58-year-old woman is evaluated in the pre-operative clinic before an elective total knee replacement. She has hypertension controlled on lisinopril, walks two miles most days without chest pain or breathlessness, and her blood pressure is 128/76 when the screening ECG is recorded.",
      "A 47-year-old man is on the telemetry ward, admitted two days ago for gallstone pancreatitis and now eating without abdominal pain. He is afebrile with a blood pressure of 130/82, and an ECG is recorded before he is moved to an unmonitored bed.",
      "A 29-year-old woman is brought to the emergency department after a car struck her bicycle at low speed, leaving a bruise across the left chest wall where the handlebars hit. She is fully alert and conversant with a blood pressure of 118/72 and clear lungs, and an ECG is obtained as part of the blunt chest trauma workup."
    ],
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
    clinicals: [
      "A 54-year-old woman with a 20-year history of poorly controlled hypertension is admitted to the medical ward overnight for observation after a mechanical fall at home, and a routine tracing is obtained. She reports no chest pain or lightheadedness, she is alert and conversant with warm extremities, blood pressure is 146/90, and the apical impulse is sustained and displaced laterally.",
      "A 57-year-old man with hypertension and a 30 pack-year smoking history calls EMS for 45 minutes of substernal pressure radiating to the left arm with sweating and nausea. He arrives diaphoretic and anxious, blood pressure is 154/92, oxygen saturation is 96 percent on room air, and the lungs are clear to auscultation.",
      "A 78-year-old woman is evaluated before elective hip replacement and reports several months of breathlessness and chest tightness when walking uphill. She has a harsh crescendo-decrescendo systolic murmur at the right upper sternal border radiating to both carotids with a soft second heart sound, and blood pressure is 118/76."
    ],
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
    clinicals: [
      "A 16-year-old girl comes to the office for a preparticipation physical before varsity soccer tryouts. She has no cardiac complaints, takes no medications, and feels well; blood pressure is 112/68 mm Hg, and a screening ECG is obtained per league policy.",
      "A 23-year-old man is brought to the emergency department after being struck in the chest by a line drive during a recreational softball game. He is alert and comfortable with localized chest wall tenderness, blood pressure 126/74 mm Hg, and oxygen saturation 99% on room air, and an ECG is obtained to screen for blunt cardiac injury.",
      "A 52-year-old woman is evaluated in the preoperative clinic before elective cholecystectomy for symptomatic gallstones. She walks two miles daily without difficulty, takes only levothyroxine, and is asymptomatic today, with blood pressure 134/80 mm Hg, and a routine preoperative ECG is recorded."
    ],
    rate: 74, rhythm: 'sinus', axis: 'normal', territory: null,
    keyLeads: { II: 'short PR (<120 ms), delta wave', V4: 'delta wave (slurred upstroke)' },
    teaching: 'Short PR under 120 ms, a delta wave (slurred initial QRS upstroke) and a widened QRS from pre-excitation through an accessory pathway that bypasses the AV node. Risk of AV re-entrant tachycardia; in pre-excited AFib, avoid AV-nodal blockers.',
    spec: { pr: 105, qrsWidth: 118, flags: { deltaWPW: true } }
  });

  /* ---- ISCHEMIA ---- */
  add({
    id: 'ecg-016', name: 'Acute anterior STEMI (LAD)', category: 'ischemia',
    clinicals: [
      "A 54-year-old woman with type 2 diabetes and a 30 pack-year smoking history arrives by ambulance with 50 minutes of heavy pressure across the front of her chest and worsening breathlessness. She is drenched in sweat and speaking in short sentences; HR 88, BP 152/88, oxygen saturation 91 percent on room air, with crackles at both lung bases.",
      "A 73-year-old woman admitted to the medical ward for lower leg cellulitis, with longstanding diabetes and chronic kidney disease, calls the nurse because she suddenly cannot catch her breath. She denies any chest pain but is clammy and ashen; HR 88, BP 108/70, and she looks unwell enough that a 12-lead is done at the bedside.",
      "Paramedics respond to a 46-year-old warehouse worker who developed severe crushing pressure behind his breastbone 25 minutes ago while loading boxes. He smokes a pack a day and his father had bypass surgery at 52; he is grey and sweating, HR 88, BP 124/78, and a 12-lead is obtained in the loading bay."
    ],
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
    clinicals: [
      "A 54-year-old woman comes to the emergency department with 90 minutes of burning epigastric pain, nausea and two episodes of vomiting that she blamed on dinner. She is cool and clammy, heart rate 58, blood pressure 104/62.",
      "Paramedics respond to a 68-year-old man with a 40 pack-year smoking history who developed crushing substernal chest pressure and heavy sweating while shoveling gravel in his driveway. He is alert but pale with clear lungs, heart rate 58 and blood pressure 108/66.",
      "A 63-year-old woman with type 2 diabetes is in pre-op holding for an elective hernia repair when she becomes nauseated, diaphoretic and says she feels like she might pass out; she denies any chest pain. Heart rate 57, blood pressure 96/58."
    ],
    rate: 58, rhythm: 'sinus', axis: 'normal', territory: 'RCA / inferior',
    keyLeads: { II: 'ST elevation', III: 'ST elevation', aVF: 'ST elevation', I: 'reciprocal ST depression', aVL: 'reciprocal ST depression' },
    teaching: 'ST elevation in II, III and aVF with reciprocal ST depression in I and aVL localizes to the inferior wall, usually an RCA occlusion (III elevation greater than II favors RCA). Get right-sided leads: RV involvement makes the patient preload-dependent, so avoid nitrates. Bradycardia and AV block are common.',
    spec: { rate: 58, stAxis: 100, stMag: 0.36, pr: 190 }
  });
  add({
    id: 'ecg-018', name: 'Acute lateral STEMI (LCx)', category: 'ischemia',
    clinicals: [
      "A 57-year-old woman with type 2 diabetes and hypertension arrives with 40 minutes of heavy pressure under the left breast that spreads into her left shoulder. She is diaphoretic, pulse 84 and regular, blood pressure 138/86.",
      "One day after hip hemiarthroplasty, a 66-year-old woman on the surgical ward calls the nurse for a band of chest tightness that began at rest and aches into her left armpit. She is alert and warm, pulse 84 and regular, blood pressure 132/74, and the discomfort has not eased over 30 minutes.",
      "Paramedics are called to a 43-year-old man with familial hypercholesterolemia and a coronary stent placed three years ago, who has had a gripping left-sided chest ache since waking an hour ago. He is pale and clammy, pulse 84 and regular, blood pressure 146/90, and two doses of his home nitroglycerin have not helped."
    ],
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
    clinicals: [
      "A 54-year-old woman with type 2 diabetes and a 30 pack-year smoking history comes to the emergency department with 90 minutes of chest pressure and breathlessness that started while she was sitting at her desk. She is alert with a heart rate of 80, blood pressure 142/88, clear lungs, and a first troponin still pending.",
      "A 46-year-old man with a father who had bypass surgery at 50 calls 911 from a construction site for 45 minutes of burning discomfort below the breastbone that two rounds of antacids did not relieve. He is diaphoretic but talking in full sentences, pulse 80 and regular, blood pressure 150/92, and medics record a prehospital 12-lead.",
      "A 71-year-old woman on the orthopedic ward, two days after hemiarthroplasty for a hip fracture, calls the nurse because her chest feels heavy and she is more short of breath than she was at physical therapy that morning. She is afebrile, heart rate 80, blood pressure 118/74, oxygen saturation 96 percent on room air."
    ],
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
    clinicals: [
      "A 68-year-old woman with type 2 diabetes and hypertension comes to the emergency department with two hours of epigastric burning, jaw ache and breathlessness that started while she was sitting at her desk and has not let up. She looks uncomfortable but not distressed; heart rate 92, blood pressure 152/88, lungs clear, no murmur.",
      "A 58-year-old man with obesity and obstructive sleep apnea is seen in the pre-operative clinic before an elective knee replacement and reports that a heavy ache across his chest woke him at 3 am and lasted about half an hour. He had a second, milder episode with nausea while sitting in the waiting room; heart rate 92, blood pressure 144/86.",
      "A 49-year-old man who smokes a pack a day walks into an urgent care clinic with 40 minutes of heaviness in his left arm and shoulder, sweating and mild nausea that began while he was watching television. His father died of a heart attack at 52; he is pale and clammy, heart rate 92, blood pressure 138/84."
    ],
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
    clinicals: [
      "A 78-year-old woman is seen in the preoperative clinic before elective hip replacement. She reports that two flights of stairs now leave her breathless and that she nearly fainted while gardening last month; blood pressure is 138/62, pulse 74 and regular, and there is a harsh late-peaking systolic murmur at the right upper sternal border radiating to both carotids with a slow-rising carotid upstroke.",
      "A 52-year-old man is brought to the emergency department after a nosebleed that would not stop for 40 minutes. He admits he quit refilling his three blood pressure prescriptions about a year ago; blood pressure is 198/116 in both arms, pulse 74, and he is otherwise comfortable and in no distress.",
      "A 24-year-old woman is referred to the clinic for hypertension first documented at age 14 and never controlled despite three agents. Right arm blood pressure is 172/98 with a regular pulse of 74, and the femoral pulses are weak and noticeably delayed compared with the radial."
    ],
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
    clinicals: [
      "A 41-year-old woman has had a murmur since childhood that was never investigated, and describes two years of gradually worsening breathlessness climbing the stairs at home. There is a systolic murmur at the left upper sternal border with a loud second heart sound, heart rate 86/min, blood pressure 114/72.",
      "A 58-year-old woman with a 40 pack-year smoking history and home oxygen presents to the ED with three weeks of worsening breathlessness and a cough productive of clear sputum. She is barrel chested with distant heart sounds, oxygen saturation 87 percent on room air, heart rate 86/min, blood pressure 126/78.",
      "A 34-year-old woman with limited cutaneous systemic sclerosis is admitted to telemetry for four months of progressive dyspnea and near-syncope on climbing one flight of stairs. Her fingertips ulcerate in cold weather and she has no cough or fever; heart rate 86/min, blood pressure 104/66."
    ],
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
    clinicals: [
      "A 34-year-old woman with end-stage renal disease on thrice-weekly hemodialysis comes to the emergency department after missing her last two sessions during a move out of state, reporting fatigue and numbness in her fingers. Temperature 37.0 C, heart rate 70/min, blood pressure 158/94 mm Hg, and an ECG is obtained at triage.",
      "A 41-year-old construction worker is extricated after being pinned beneath collapsed scaffolding for roughly six hours; his thighs are tense and swollen and his first voided urine is dark brown. In the field his pulse is 70/min, blood pressure 118/72 mm Hg, and the medics run a 12-lead before transport.",
      "A 68-year-old man with heart failure and stage 4 chronic kidney disease, maintained on lisinopril and spironolactone, is seen in preoperative clinic before an elective hernia repair; he just completed a course of trimethoprim-sulfamethoxazole for a urinary infection and notes his legs feel heavy climbing stairs. Heart rate 70/min, blood pressure 132/78 mm Hg, and a baseline ECG is recorded."
    ],
    rate: 70, rhythm: 'sinus', axis: 'normal', territory: null,
    keyLeads: { II: 'tall peaked (tented) T waves', V3: 'peaked T waves', V4: 'peaked T waves' },
    teaching: 'Sequence with rising K+: tall narrow peaked (tented) T waves first, then PR prolongation and P-wave flattening, then QRS widening, and finally a sine-wave pattern preceding arrest. Treat with IV calcium (membrane stabilization), then insulin plus glucose and albuterol to shift K+, then dialysis or other removal.',
    spec: { rate: 70, qrsWidth: 118, pr: 210, flags: { peakedT: true, lowP: true } }
  });
  add({
    id: 'ecg-024', name: 'Hypokalemia', category: 'metabolic',
    clinicals: [
      "A 24-year-old woman at 10 weeks gestation comes to the emergency department after five days of relentless vomiting, unable to keep down food or fluids. She reports heavy, weak legs and cramping in her calves; heart rate is 76/min, blood pressure 104/64.",
      "A 68-year-old man with chronic heart failure is seen in the pre-op clinic before elective inguinal hernia repair. His loop diuretic was doubled three weeks ago for leg swelling, and he now mentions nocturnal calf cramps and fatigue climbing stairs; heart rate 76/min, blood pressure 132/78.",
      "A 46-year-old woman is referred to the clinic for hypertension that has not responded to three agents at full dose. She describes intermittent episodes of profound muscle weakness and increased urination over the past year; heart rate is 76/min, blood pressure 168/98."
    ],
    rate: 76, rhythm: 'sinus', axis: 'normal', territory: null,
    keyLeads: { II: 'U waves, flattened T', V3: 'prominent U wave', V4: 'prominent U wave, ST depression' },
    teaching: 'Flattened T waves, ST depression and prominent U waves (a positive deflection after the T), which can fuse into an apparent long QT. Predisposes to torsades. Replace potassium and check magnesium, since hypokalemia is refractory until the magnesium is corrected.',
    spec: { rate: 76, flags: { uWave: true, flatT: true }, leadOverride: { II: { st: -0.05 }, V4: { st: -0.08 }, V5: { st: -0.06 } } }
  });

  /* ---- OTHER ---- */
  add({
    id: 'ecg-025', name: 'Acute pericarditis', category: 'other',
    clinicals: [
      "A 24-year-old man comes to student health with three days of sharp central chest pain, ten days after a flu-like illness with fever and body aches. Temperature 37.9 C, heart rate 96/min, blood pressure 124/76, oxygen saturation 97 percent on room air.",
      "A 47-year-old woman with systemic lupus erythematosus, off her hydroxychloroquine for two months, comes to the emergency department with two days of chest discomfort, joint pain and a new facial rash. Temperature 38.0 C, heart rate 96/min, blood pressure 130/78.",
      "A 38-year-old man who finished mantle field radiation for Hodgkin lymphoma seven weeks ago is seen on the oncology day unit with four days of constant central chest ache and malaise. Temperature 37.8 C, heart rate 96/min, blood pressure 114/72."
    ],
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
    clinicals: [
      "A 28-year-old man is brought in after his wife found him gasping and unresponsive in bed at 3 AM; he came around on his own within a minute and is now alert, oriented and complaining only of two days of fever and body aches. He took acetaminophen before arrival, and his temperature is now 37.4 C, heart rate 72/min, blood pressure 118/72, with a normal cardiac and neurologic exam.",
      "A 52-year-old woman with no cardiac history has a routine ECG before elective laparoscopic cholecystectomy. She is asymptomatic and walks three miles a day, but on review of systems she reports that her father and a paternal uncle each died unexpectedly in their sleep in their mid-forties; heart rate is 72/min, blood pressure 124/76, and the cardiac exam is normal.",
      "A 47-year-old man comes in for a routine physical and mentions two fainting spells in the past year, both while sitting quietly about an hour after a large dinner. Each time he dropped without warning and felt entirely normal within a minute; he takes no medications, and his heart rate is 72/min with blood pressure 128/78."
    ],
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
    clinicals: [
      "A 68-year-old man is seen in primary care three weeks after an ankle fracture was placed in a walking boot, with four days of breathlessness on minimal exertion. Heart rate 112, blood pressure 104/68, respiratory rate 24, oxygen saturation 92 percent on room air.",
      "A 23-year-old man is seen in cardiology clinic two weeks after a small ventricular septal defect was closed with a device passed through a catheter in his femoral vein. He became winded carrying laundry up one flight of stairs. Heart rate 112, blood pressure 106/68, oxygen saturation 93 percent on room air.",
      "A 31-year-old woman comes to the emergency department with one day of sharp left-sided chest pain that catches when she breathes in. She started a combined oral contraceptive four months ago. Heart rate 112, blood pressure 110/72, respiratory rate 24, oxygen saturation 93 percent on room air."
    ],
    rate: 112, rhythm: 'sinus', axis: 'right', territory: null,
    keyLeads: { I: 'S wave (S1)', III: 'Q wave and T inversion (Q3T3)', V1: 'T inversion (RV strain)', V2: 'T inversion' },
    teaching: 'The most common finding is plain sinus tachycardia. The classic (but insensitive) S1Q3T3 is an S wave in I, with a Q wave and inverted T in III, from acute right-heart strain; right precordial T-wave inversion and a new incomplete RBBB may appear. Diagnose with CT angiography, not the ECG.',
    spec: {
      rate: 112, axis: 100,
      leadOverride: {
        I: { addS: -0.35 },
        /* T3 needs an explicit amplitude. The T axis of 40 degrees is nearly
           perpendicular to lead III, so the projected T is only 0.061 mV, and
           tInv merely flipped that to -0.061 mV: a 0.6 mm deflection, invisible
           at 10 mm/mV. keyLeads advertises "Q wave and T inversion (Q3T3)" here,
           so the T inversion has to actually be on the tracing. */
        III: { addQ: -0.22, t: -0.20 },
        aVF: { tInv: true }
      },
      precordial: { V1: { t: -0.22 }, V2: { t: -0.25 }, V3: { t: -0.15 } }
    }
  });
  add({
    id: 'ecg-028', name: 'Long QT syndrome', category: 'other',
    clinicals: [
      "A 19-year-old collegiate swimmer is brought to the emergency department after he was pulled from the pool having lost consciousness mid-lap during a timed set. He woke within a minute with no confusion or injury, and now has a heart rate of 68/min, blood pressure 118/72 mm Hg, and a normal cardiac and neurologic exam.",
      "A 71-year-old man on the medical ward is recovering from aspiration pneumonia after four days of vomiting and diarrhea, during which he continued his usual high-dose loop diuretic and was started on intravenous antibiotics and an antiemetic. He reports one brief episode of feeling faint while sitting up this morning; heart rate is 68/min and blood pressure is 108/64 mm Hg.",
      "A 15-year-old girl is referred to the cardiology clinic after her 17-year-old brother collapsed and died suddenly during a soccer match last spring. She feels well, has never had chest pain or palpitations, and has a heart rate of 68/min, blood pressure 104/66 mm Hg, and a normal cardiac exam."
    ],
    rate: 68, rhythm: 'sinus', axis: 'normal', territory: null,
    keyLeads: { II: 'prolonged QT interval', V4: 'prolonged QT, broad T' },
    teaching: 'QT prolonged for rate (QTc over 470 ms in men, over 480 ms in women), from congenital channelopathy or acquired causes (drugs, hypokalemia, hypomagnesemia, hypocalcemia). The danger is torsades de pointes. Remove offending drugs, correct electrolytes, and consider beta-blockers or an ICD.',
    spec: { rate: 68, flags: { longQT: true } }
  });
  add({
    id: 'ecg-029', name: 'Torsades de pointes', category: 'other',
    clinicals: [
      "A 72-year-old man on the telemetry ward, day 4 of treatment for aspiration pneumonia, has been getting intravenous haloperidol for agitation and scheduled antiemetics for persistent nausea. He had two brief spells of lightheadedness overnight, and now he slumps over in bed, unresponsive, with no palpable pulse and a monitored rate of 240 beats per minute.",
      "A 29-year-old woman with anorexia nervosa and several months of daily laxative use and self-induced vomiting collapses in the emergency department waiting room. On the stretcher she is unresponsive with no palpable pulse and no recordable blood pressure, and the cardiac monitor counts 240 beats per minute.",
      "Paramedics respond to a 58-year-old woman on long term methadone for back pain who fainted twice at work after starting an oral antifungal for a toenail infection last week. Partway through transport she becomes unresponsive, has no palpable pulse, and the monitor reads 240 beats per minute."
    ],
    rate: 240, rhythm: 'torsades', axis: null, territory: null,
    keyLeads: { II: 'polymorphic VT twisting around baseline' },
    teaching: 'Polymorphic VT in which the QRS amplitude and axis appear to twist around the baseline, arising from a prolonged QT. Treat with IV magnesium, correct electrolytes, stop the offending drug, and increase the rate (pacing or isoproterenol); defibrillate if unstable.',
    spec: { rhythm: 'torsades', rate: 240, qrsWidth: 150 }
  });
  add({
    id: 'ecg-030', name: 'Digitalis effect', category: 'other',
    clinicals: [
      "A 71-year-old woman with chronic heart failure is seen for a routine annual visit and reports only some stiffness in her knees. She has taken digoxin at the same dose every morning for six years, her pulse is 66, and her blood pressure is 126/78.",
      "A 64-year-old man with long-standing heart failure attends cardiology clinic for a routine six-month review and reports no chest pain or breathlessness. His regimen includes a cardiac medication that inhibits the myocardial sodium-potassium ATPase pump, his pulse is 66, and his blood pressure is 132/80.",
      "A 52-year-old woman with chronic heart failure comes to the emergency department after twisting her ankle stepping off a curb and asks only for something for the pain. She takes a medication that treats heart failure and abnormal heart rhythms but does not remember its name; heart rate 66, blood pressure 122/74."
    ],
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

  /* Each diagnosis carries several interchangeable vignettes. A student who meets
     the same diagnosis twice should not recognise it by its story, so the case is
     presented with a different presentation each time. `clinical` stays as the
     first one for anything that expects a single string. */
  DX.forEach(function (d) {
    if (!d.clinicals || !d.clinicals.length) d.clinicals = [d.clinical];
    d.clinical = d.clinicals[0];
  });

  /* Deterministic pick, so re-rendering the same case does not swap the story
     out from under the reader mid-question. */
  function vignetteFor(dx, seed) {
    var list = (dx && dx.clinicals && dx.clinicals.length) ? dx.clinicals : [dx.clinical];
    if (list.length === 1) return list[0];
    return list[Math.floor(mulberry32((seed >>> 0) + 104729)() * list.length)] || list[0];
  }

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
    qrsEndMs: qrsEndMs, QRS_CAL: QRS_CAL, vignetteFor: vignetteFor,
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
