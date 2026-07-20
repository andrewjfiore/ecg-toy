/* Headless file:// smoke test of the built trainer. Loads index.html directly
 * from disk (no server), so it exercises the real offline path.
 *
 * Beyond rendering, this enforces the scoring contract:
 *   a case is correct or incorrect on the DIAGNOSIS ALONE.
 * Lead marking is tracked but must never move the session score, the streak, or
 * the per-diagnosis correct count. That invariant is the whole point of the
 * easy/hard split, so it is asserted here rather than left to inspection.
 *
 * Run: node ecg-file-check.js [path-to-html]  */
const { chromium } = require('playwright');
const path = require('path');

const LEADS = ['I', 'II', 'III', 'aVR', 'aVL', 'aVF', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6'];

(async () => {
  const target = process.argv[2] || path.join(__dirname, 'index.html');
  const url = 'file://' + target.replace(/\\/g, '/');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  await page.goto(url, { waitUntil: 'networkidle' });

  const fails = [];
  let checksRun = 0;
  const check = (name, cond) => { checksRun++; if (!cond) fails.push(name); return cond; };

  /* ---- render ---- */
  const r = await page.evaluate(() => {
    let maxLen = 0;
    document.querySelectorAll('.lead-cell svg path').forEach(p => {
      const d = p.getAttribute('d') || ''; if (d.length > maxLen) maxLen = d.length;
    });
    return {
      engine: typeof ECG !== 'undefined',
      leadCells: document.querySelectorAll('.lead-cell').length,
      rhythm: !!document.querySelector('#rhythmCell svg'),
      maxPathLen: maxLen,
      options: document.querySelectorAll('#opts .opt').length,
      truthLoaded: !!(window.ECG_LEAD_TRUTH && Object.keys(window.ECG_LEAD_TRUTH).length),
    };
  });
  check('engine loads', r.engine);
  check('12 lead cells', r.leadCells === 12);
  check('rhythm strip', r.rhythm);
  check('waveforms drawn', r.maxPathLen > 2000);
  check('5 MCQ options', r.options === 5);

  /* ---- first-run guided tour ----
     This runs on a fresh browser context, so localStorage is empty and the tour
     must auto-open. Asserted here rather than by hand because the preview pane
     renders file:// as a static snapshot where location.reload() is a no-op, so
     first-run behaviour cannot be checked interactively. */
  const tour1 = await page.evaluate(() => {
    const t = document.getElementById('tour');
    return {
      open: t && !t.classList.contains('hidden'),
      step: (document.getElementById('tourStep') || {}).textContent || '',
      backDisabled: (document.getElementById('tourBack') || {}).disabled,
      ringW: document.getElementById('tourRing').getBoundingClientRect().width,
      popInView: (() => {
        const r = document.getElementById('tourPop').getBoundingClientRect();
        return r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight;
      })(),
    };
  });
  check('tour auto-opens on first visit', tour1.open === true);
  check('tour starts at step 1 of 6', /STEP 1 OF 6/.test(tour1.step));
  check('tour Back disabled on first step', tour1.backDisabled === true);
  check('tour spotlight has a size', tour1.ringW > 0);
  check('tour popover is on screen', tour1.popInView === true);

  // every step must spotlight its real target and keep the popover on screen.
  // The ring and popover ease between steps, so wait out the 180 ms transition
  // before measuring or you read the previous step's geometry.
  const steps = await page.evaluate(async () => {
    const sels = ['#vignette', '#opts', '#diffSel', '#leadGrid', '#submitBtn', '#nav-stats'];
    const settle = () => new Promise(r => setTimeout(r, 320));
    const out = [];
    window.endTour(); window.startTour(); await settle();
    for (let i = 0; i < sels.length; i++) {
      if (i) { window.tourGo(1); await settle(); }
      const ring = document.getElementById('tourRing').getBoundingClientRect();
      const pop = document.getElementById('tourPop').getBoundingClientRect();
      const el = document.querySelector(sels[i]);
      const t = el ? el.getBoundingClientRect() : null;
      out.push({
        sel: sels[i],
        targetExists: !!el,
        aligned: t ? (Math.abs(ring.top - (t.top - 6)) < 3 && Math.abs(ring.height - (t.height + 12)) < 3) : false,
        onScreen: pop.left >= 0 && pop.top >= 0 && pop.right <= window.innerWidth + 1 && pop.bottom <= window.innerHeight + 1,
        clearOfRing: pop.bottom <= ring.top + 1 || pop.top >= ring.bottom - 1 || pop.right <= ring.left + 1 || pop.left >= ring.right - 1,
      });
    }
    window.endTour();
    return out;
  });
  check('every tour step has a real target', steps.every(s => s.targetExists));
  check('spotlight aligns to its target on every step', steps.every(s => s.aligned));
  check('popover stays on screen on every step', steps.every(s => s.onScreen));
  check('popover never covers the spotlight', steps.every(s => s.clearOfRing));

  // step through it, then confirm the last step finishes
  const tourNav = await page.evaluate(() => {
    const seen = [];
    window.startTour();
    for (let i = 0; i < 5; i++) { window.tourGo(1); seen.push(document.getElementById('tourStep').textContent); }
    const lastLabel = document.getElementById('tourNext').textContent;
    window.tourGo(-1);
    const back = document.getElementById('tourStep').textContent;
    window.tourGo(1); window.tourGo(1);            // advance past the end -> closes
    return { seen, lastLabel, back, closed: document.getElementById('tour').classList.contains('hidden') };
  });
  check('tour advances through all 6 steps', /STEP 6 OF 6/.test(tourNav.seen[tourNav.seen.length - 1]));
  check('tour last step says Done', tourNav.lastLabel === 'Done');
  check('tour Back steps backwards', /STEP 5 OF 6/.test(tourNav.back));
  check('tour closes after the last step', tourNav.closed === true);

  const seenFlag = await page.evaluate(() => localStorage.getItem('ecg.tourSeen'));
  check('tour marks itself seen', seenFlag === '1');

  // repeatable from the help dialog
  const help = await page.evaluate(() => {
    document.getElementById('helpBtn').click();
    const openHelp = !document.getElementById('helpModal').classList.contains('hidden');
    const hasInstructions = /come from your diagnosis/i.test(document.getElementById('helpModal').textContent);
    document.querySelector('#helpModal .btn.primary').click();     // "Take the guided tour"
    const tourReopened = !document.getElementById('tour').classList.contains('hidden');
    const helpClosed = document.getElementById('helpModal').classList.contains('hidden');
    const backAtStart = document.getElementById('tourStep').textContent;
    window.endTour();
    return { openHelp, hasInstructions, tourReopened, helpClosed, backAtStart };
  });
  check('help dialog opens from the ? button', help.openHelp === true);
  check('help dialog explains what is scored', help.hasInstructions === true);
  check('tour is repeatable from help', help.tourReopened === true);
  check('help closes when the tour starts', help.helpClosed === true);
  check('replayed tour restarts at step 1', /STEP 1 OF 6/.test(help.backAtStart));

  /* ---- copy lint ----
     Everything a reader sees should be about reading ECGs, not about how the page
     is built. Implementation words leak in easily during development, and British
     spellings slip in from habit, so both are checked rather than eyeballed. */
  const copy = await page.evaluate(() => {
    const parts = [document.body.innerText, document.getElementById('helpModal').innerText];
    document.querySelectorAll('[aria-label],[title],option').forEach(el => {
      parts.push(el.getAttribute('aria-label') || '', el.getAttribute('title') || '', el.textContent || '');
    });
    window.endTour(); window.startTour();
    for (let i = 0; i < 6; i++) { parts.push(document.getElementById('tourBody').innerText); window.tourGo(1); }
    window.endTour();
    return parts.join('\n');
  });
  const jargon = copy.match(/localStorage|namespace|parametric|sum-of-Gaussians|Gaussian|waveform model|synthetic engine|engineSpec|innerHTML|querySelector|\bDOM\b|\bAPI\b|\bboolean\b/gi) || [];
  const british = copy.match(/licence|colour|behaviour|memoris\w*|organis\w*|recognis\w*|analyse\w*|judgement|practis\w*/gi) || [];
  const emdash = copy.match(/[–—]/g) || [];
  check('no implementation jargon in user copy' + (jargon.length ? ' (' + [...new Set(jargon)].join(', ') + ')' : ''), jargon.length === 0);
  check('US spelling throughout' + (british.length ? ' (' + [...new Set(british)].join(', ') + ')' : ''), british.length === 0);
  check('no em or en dashes in copy', emdash.length === 0);

  /* ---- easy mode: submittable with no lead marks ---- */
  await page.evaluate(() => { window.setDifficulty('easy'); window.newCase(); });
  const easy = await page.evaluate(() => {
    document.querySelectorAll('#opts .opt')[0].click();
    const btn = document.getElementById('submitBtn');
    return { enabledWithNoMarks: !btn.disabled, hintHidden: document.getElementById('markCount').classList.contains('hidden') };
  });
  check('easy: submit enabled with zero leads marked', easy.enabledWithNoMarks);
  check('easy: lead counter hidden', easy.hintHidden);

  /* ---- hard mode: gated until all 12 rated ---- */
  await page.evaluate(() => { window.setDifficulty('hard'); window.newCase(); });
  const gate = await page.evaluate((LEADS) => {
    const cells = {};
    document.querySelectorAll('.lead-cell').forEach(c => cells[c.getAttribute('data-lead')] = c);
    document.querySelectorAll('#opts .opt')[0].click();
    const afterDx = document.getElementById('submitBtn').disabled;
    LEADS.slice(0, 11).forEach(L => cells[L].click());
    const at11 = document.getElementById('submitBtn').disabled;
    const label11 = document.getElementById('submitBtn').textContent;
    cells[LEADS[11]].click();
    const at12 = document.getElementById('submitBtn').disabled;
    return { afterDx, at11, at12, label11 };
  }, LEADS);
  check('hard: blocked with dx chosen but no leads', gate.afterDx === true);
  check('hard: still blocked at 11/12 leads', gate.at11 === true);
  check('hard: explains what is missing', /Identify 1 more lead/.test(gate.label11));
  check('hard: unblocked at 12/12 leads', gate.at12 === false);

  /* ---- the invariant: lead marking never moves the score ---- */
  await page.evaluate(() => { localStorage.removeItem('ecg.progress'); });
  await page.reload({ waitUntil: 'networkidle' });

  const trials = await page.evaluate((LEADS) => {
    const out = [];
    window.setDifficulty('hard');
    for (let i = 0; i < 8; i++) {
      window.newCase();
      const cells = {};
      document.querySelectorAll('.lead-cell').forEach(c => cells[c.getAttribute('data-lead')] = c);
      // Deliberately hostile lead marking: call EVERY lead abnormal. For most
      // diagnoses that is mostly wrong. It must not cost a single point.
      LEADS.forEach(L => cells[L].click());
      const before = {
        score: +document.getElementById('sessScore').textContent,
        total: +document.getElementById('sessTotal').textContent,
        streak: +document.getElementById('streak').textContent,
      };
      document.querySelectorAll('#opts .opt')[i % 5].click();
      document.getElementById('submitBtn').click();
      const sel = document.querySelector('#opts .opt.sel');
      const dxRight = !!(sel && sel.classList.contains('correct'));
      const after = {
        score: +document.getElementById('sessScore').textContent,
        total: +document.getElementById('sessTotal').textContent,
        streak: +document.getElementById('streak').textContent,
      };
      out.push({
        dxRight,
        scoreDelta: after.score - before.score,
        totalDelta: after.total - before.total,
        streak: after.streak,
        prevStreak: before.streak,
        leadReportShown: !!document.querySelector('.lead-report'),
        gradedCells: document.querySelectorAll('.lead-cell.key-correct,.lead-cell.key-missed,.lead-cell.key-over').length,
      });
    }
    return out;
  }, LEADS);

  const scoreOnlyFromDx = trials.every(t => t.scoreDelta === (t.dxRight ? 1 : 0));
  const everyCaseCounted = trials.every(t => t.totalDelta === 1);
  const streakOnlyFromDx = trials.every(t => t.dxRight ? (t.streak === t.prevStreak + 1) : (t.streak === 0));
  check('score moves only with the diagnosis', scoreOnlyFromDx);
  check('every submitted case counts once', everyCaseCounted);
  check('streak moves only with the diagnosis', streakOnlyFromDx);

  /* ---- pre-answer state must not hint at the diagnosis ---- */
  const hints = await page.evaluate(() => {
    window.setDifficulty('easy');       // so submit is not gated on lead identification
    window.newCase();
    const catHiddenBefore = document.getElementById('caseCat').classList.contains('hidden');
    // option labels must carry no parenthetical (which would leak the finding)
    const optText = [...document.querySelectorAll('#opts .opt')].map(o => o.textContent);
    const parenInOpts = optText.some(t => /\(/.test(t));
    // answer, then category should reveal
    document.querySelector('#opts .opt').click();
    document.getElementById('submitBtn').click();
    const catShownAfter = !document.getElementById('caseCat').classList.contains('hidden');
    return { catHiddenBefore, parenInOpts, catShownAfter };
  });
  check('category hidden before answering', hints.catHiddenBefore === true);
  check('option labels drop the parenthetical hint', hints.parenInOpts === false);
  check('category revealed after answering', hints.catShownAfter === true);

  /* ---- leads spell out abnormal / normal, not ABN / NL ---- */
  const badges = await page.evaluate(() => {
    window.newCase();
    const cell = document.querySelector('.lead-cell');
    cell.click();                         // -> abnormal
    const one = (cell.querySelector('.badge') || {}).textContent || '';
    cell.click();                         // -> normal
    const two = (cell.querySelector('.badge') || {}).textContent || '';
    return { one, two };
  });
  check('abnormal badge is spelled out', /Abnormal/i.test(badges.one) && !/^ABN$/.test(badges.one));
  check('normal badge is spelled out', /Normal/i.test(badges.two));

  /* ---- scoreboard at the bottom reflects the session ---- */
  const board = await page.evaluate(() => {
    const sb = document.getElementById('scoreboard');
    const onPractice = sb && sb.offsetParent !== null;
    const total = +document.getElementById('sbTotal').textContent;
    const acc = document.getElementById('sbAcc').textContent;
    const ranked = document.querySelectorAll('#sbWeak li, #sbStrong li').length;
    return { onPractice, total, acc, ranked };
  });
  check('scoreboard visible on the practice page', board.onPractice === true);
  check('scoreboard counts the session', board.total >= 1);
  check('scoreboard shows a ranking once cases are seen', board.ranked >= 1);

  /* ---- info popovers open and close ---- */
  const info = await page.evaluate(() => {
    window.showInfo('order');
    const openOrder = !document.getElementById('infoModal').classList.contains('hidden') &&
      /Dynamic/.test(document.getElementById('infoBody').textContent);
    window.closeInfo();
    const closed = document.getElementById('infoModal').classList.contains('hidden');
    window.showInfo('ranking');
    const openRank = /Needs work|ranking/i.test(document.getElementById('infoBody').textContent);
    window.closeInfo();
    return { openOrder, closed, openRank };
  });
  check('info popover explains the case order', info.openOrder === true);
  check('info popover closes', info.closed === true);
  check('info popover explains the ranking', info.openRank === true);

  const persisted = await page.evaluate(() => {
    const p = JSON.parse(localStorage.getItem('ecg.progress') || '{}');
    const ids = Object.keys(p);
    return {
      n: ids.length,
      // correct must never exceed seen, and lead counters live in their own fields
      sane: ids.every(id => p[id].correct <= p[id].seen),
      hasLeadCounters: ids.some(id => p[id].markN > 0),
      leadNeverInflatesCorrect: ids.every(id => p[id].correct <= p[id].seen),
    };
  });
  check('progress persisted', persisted.n >= 1);
  check('correct never exceeds seen', persisted.sane);
  if (r.truthLoaded) {
    check('lead counters recorded separately', persisted.hasLeadCounters);
    check('lead grading renders', trials.some(t => t.leadReportShown && t.gradedCells > 0));
  }

  /* ---- import hardening: hostile progress file must not inject markup ---- */
  const inj = await page.evaluate(() => {
    const bad = { 'ecg-001': { seen: '<img src=x onerror="window.__pwned=1">', correct: 999, markN: 'x' }, 'evil-id': { seen: 5 } };
    // exercise the sanitizer through the same path the file import uses
    localStorage.setItem('ecg.progress', JSON.stringify(bad));
    return true;
  });
  await page.reload({ waitUntil: 'networkidle' });
  const injResult = await page.evaluate(() => {
    window.setView('stats');
    return { pwned: !!window.__pwned, html: document.getElementById('dxTable').innerHTML.indexOf('onerror') >= 0 };
  });
  check('no script injection via progress data', !injResult.pwned && !injResult.html);

  await browser.close();

  check('no console errors', errors.length === 0);

  const ok = fails.length === 0;
  console.log(JSON.stringify({
    url, ...r,
    trials: trials.map(t => ({ dxRight: t.dxRight, scoreDelta: t.scoreDelta, streak: t.streak })),
    persisted, consoleErrors: errors, failures: fails,
  }, null, 2));
  console.log(ok ? 'FILE:// CHECK PASS (' + checksRun + ' assertions)'
                 : 'FILE:// CHECK FAIL (' + fails.length + '/' + checksRun + '): ' + fails.join('; '));
  process.exit(ok ? 0 : 1);
})();
