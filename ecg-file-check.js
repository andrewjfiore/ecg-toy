/* Headless file:// smoke test of the built trainer. Loads ecg-trainer.html
 * directly from disk (no server), so it exercises the real offline path.
 * Run: node ecg-file-check.js [path-to-html]  */
const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const target = process.argv[2] || path.join(__dirname, 'ecg-trainer.html');
  const url = 'file://' + target.replace(/\\/g, '/');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  await page.goto(url, { waitUntil: 'networkidle' });

  const r = await page.evaluate(() => {
    const out = {};
    out.engine = typeof ECG !== 'undefined';
    out.leadCells = document.querySelectorAll('.lead-cell').length;
    out.rhythm = !!document.querySelector('#rhythmCell svg');
    let maxLen = 0;
    document.querySelectorAll('.lead-cell svg path').forEach(p => { const d = p.getAttribute('d') || ''; if (d.length > maxLen) maxLen = d.length; });
    out.maxPathLen = maxLen;
    out.options = document.querySelectorAll('#opts .opt').length;
    // mark II abnormal, answer, submit
    const cells = {}; document.querySelectorAll('.lead-cell').forEach(c => cells[c.getAttribute('data-lead')] = c);
    cells['II'].click();
    document.querySelectorAll('#opts .opt')[0].click();
    document.getElementById('submitBtn').click();
    out.resultShown = !document.getElementById('result').classList.contains('hidden');
    out.oneCorrect = document.querySelectorAll('#opts .opt.correct').length === 1;
    out.markScored = document.querySelectorAll('.lead-cell.key-correct,.lead-cell.key-missed,.lead-cell.key-over').length > 0;
    out.progressSaved = !!localStorage.getItem('ecg.progress');
    return out;
  });

  // reload -> persistence
  await page.reload({ waitUntil: 'networkidle' });
  const persisted = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('ecg.progress') || '{}')).length);

  await browser.close();

  const ok = r.engine && r.leadCells === 12 && r.rhythm && r.maxPathLen > 2000 &&
    r.options === 5 && r.resultShown && r.oneCorrect && r.markScored && r.progressSaved &&
    persisted >= 1 && errors.length === 0;
  console.log(JSON.stringify({ url, ...r, persisted, consoleErrors: errors }, null, 2));
  console.log(ok ? 'FILE:// CHECK PASS' : 'FILE:// CHECK FAIL');
  process.exit(ok ? 0 : 1);
})();
