# ECG Reading Trainer (ecg-toy)

A single-page, in-browser ECG training tool that renders synthetic 12‑lead ECGs with a rhythm strip. It supports interactive lead marking, scoring, an axis interpretation exercise, coronary territory overlays, and an ECG designer.

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
