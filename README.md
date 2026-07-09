# ECG Reading Trainer (ecg-toy)

A single-page, in-browser ECG training tool that renders synthetic 12-lead ECGs with a rhythm strip. It supports interactive lead marking, scoring, an axis interpretation exercise, coronary territory overlays, and an ECG designer.

## New: parametric synthesis engine + offline trainer (`ecg-trainer.html`)

The original synthetic waveforms were drawn as piecewise straight-line SVG segments, which never looked realistic. That is replaced by a clean **sum-of-Gaussians** synthesis engine (`ecg-engine.js`):

- Each cardiac wave (P, Q, R, S, ST, T, U) is a Gaussian; the beat is their sum, sampled densely and drawn as a smooth SVG polyline calibrated to standard ECG paper (25 mm/s, 10 mm/mV, pink grid, calibration pulse).
- Atrial and ventricular activity are **separate event trains**, so AV blocks, AFib, flutter, VT and complete dissociation fall out naturally.
- Limb leads are produced by projecting the P / QRS / T / **ST vectors** onto the hexaxial reference, so axis deviation and reciprocal ST changes are automatic and physiologic. Precordial leads use explicit R-wave-progression templates with per-territory ST patterns.
- 30 diagnoses are encoded (see below), each with correct lead distribution, a clinical vignette, key-lead answer key, coronary territory, and board-level teaching.

`ecg-trainer.html` is a fully self-contained, offline (double-click `file://`) trainer: pick a diagnosis from a 5-option MCQ, mark leads normal/abnormal, score it, read the teaching, and drill by category (rhythm, conduction, ischemia, chamber, metabolic, other). Progress persists in `localStorage` under the `ecg.*` namespace with export/import/reset.

### Build / test / files
- `ecg-engine.js` - synthesis engine + diagnosis catalog (single source of truth; Node-exportable).
- `ecg-trainer.template.html` / `ecg-qa.template.html` - templates (load the engine via a sibling `<script>` for dev).
- `build.js` - inlines the engine + image-library index into the templates to produce the self-contained `ecg-trainer.html` and `ecg-qa.html`, emits `ecg_cases.json`, and (`--deploy`) copies the trainer + `ecg-library/` into the `cvs-review` platform. Run: `node build.js` or `node build.js --deploy`.
- `ecg-tests.js` - Node assertions on medical correctness (ST vectors, reciprocals, axis, morphology). Run: `node ecg-tests.js`.
- `ecg-file-check.js` - headless `file://` smoke test of the built trainer. Run: `node ecg-file-check.js`.
- `ecg-qa.html` - visual QA harness that renders every synthetic diagnosis in a grid for eyeballing realism.

### Diagnoses covered (30)
Normal sinus, sinus brady/tachy, AFib, atrial flutter, SVT, VT, VFib; first-degree AV block, Mobitz I/II, complete heart block, RBBB, LBBB, WPW; anterior/inferior/lateral STEMI, posterior MI, NSTEMI/ischemia; LVH, RVH; hyperkalemia, hypokalemia; pericarditis, Brugada, PE/right-heart strain (S1Q3T3), long QT, torsades, digitalis effect.

The original tool (`index.html`) and the `ecg-library/` reference images are unchanged.

---


## Features
- **ECG library + randomizer:** Choose from predefined cases or load a random ECG by category.
- **12‑lead grid + rhythm strip:** SVG-based waveform rendering with configurable morphologies.
- **Marking + scoring:** Mark each lead as normal/abnormal/uncertain and check answers.
- **Axis interpretation practice:** Validate lead I/aVF polarity with axis classification.
- **Import/export:** Bring your own ECG JSON or export the current ECG.
- **Designer mode:** Create custom ECGs and preview them before saving.

## Usage
Open `ecg-toy.html` in any modern browser. No build step is required.

## Import format (JSON)
At minimum, provide a `title` and a `leads` object containing the 12 standard leads (missing leads are filled with defaults):

```json
{
  "title": "My ECG",
  "clinical": "Optional scenario",
  "diagnosis": "Optional diagnosis",
  "rate": 75,
  "leads": {
    "I": { "status": "normal", "st": 0, "qrs": "narrow", "p": true, "t": "normal" },
    "II": { "status": "normal", "st": 0, "qrs": "narrow", "p": true, "t": "normal" },
    "III": { "status": "normal", "st": 0, "qrs": "narrow", "p": true, "t": "normal" },
    "aVR": { "status": "normal", "st": 0, "qrs": "inverted", "p": "inverted", "t": "inverted" },
    "aVL": { "status": "normal", "st": 0, "qrs": "narrow", "p": true, "t": "normal" },
    "aVF": { "status": "normal", "st": 0, "qrs": "narrow", "p": true, "t": "normal" },
    "V1": { "status": "normal", "st": 0, "qrs": "progression", "p": true, "t": "normal" },
    "V2": { "status": "normal", "st": 0, "qrs": "progression", "p": true, "t": "normal" },
    "V3": { "status": "normal", "st": 0, "qrs": "progression", "p": true, "t": "normal" },
    "V4": { "status": "normal", "st": 0, "qrs": "progression", "p": true, "t": "normal" },
    "V5": { "status": "normal", "st": 0, "qrs": "progression", "p": true, "t": "normal" },
    "V6": { "status": "normal", "st": 0, "qrs": "progression", "p": true, "t": "normal" },
    "rhythm": { "status": "normal" }
  }
}
```

## Notes
- This app is self-contained; all logic lives in `ecg-toy.html`.
- The waveform generator uses calibrated timing and amplitude to simulate standard ECG paper.
