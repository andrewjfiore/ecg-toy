/* build.js  -  inline ecg-engine.js into the templates to produce the
 * self-contained, offline (file://) artifacts, generate the case bank JSON,
 * and (with --deploy) copy the built trainer + image library into the
 * cvs-review platform.
 *
 *   node build.js            # build repo artifacts
 *   node build.js --deploy   # build + copy into ../../cvs-review
 */
var fs = require('fs');
var path = require('path');
var ROOT = __dirname;

function read(f) { return fs.readFileSync(path.join(ROOT, f), 'utf8'); }
function write(f, s) { fs.writeFileSync(path.join(ROOT, f), s); console.log('wrote ' + f + ' (' + s.length + ' bytes)'); }

var engine = read('ecg-engine.js');
var engineTag = '<script>\n' + engine + '\n</script>';

var libIndex = read('ecg-library/index.json');
var libTag = '<script>window.ECG_LIBRARY=' + libIndex + ';</script>';

function inline(tpl, out) {
  var html = read(tpl).replace('<!--ECG_ENGINE_TAG-->', engineTag);
  if (html.indexOf(engineTag) < 0) throw new Error('engine tag not inlined in ' + tpl);
  html = html.replace('<!--ECG_LIBRARY_TAG-->', libTag);
  // remove the dev-only sibling scripts if present
  html = html.replace(/<script src="ecg-engine\.js"><\/script>\s*/g, '');
  html = html.replace(/<script src="ecg-library-dev\.js"><\/script>\s*/g, '');
  write(out, html);
}

inline('ecg-qa.template.html', 'ecg-qa.html');
inline('ecg-trainer.template.html', 'ecg-trainer.html');

/* ---- case bank JSON (derived from the engine's diagnosis catalog) ---- */
var ECG = require('./ecg-engine.js');
var cases = ECG.DX.map(function (d) {
  return {
    id: d.id,
    diagnosis: d.name,
    category: d.category,
    clinical: d.clinical,
    rate: d.rate,
    rhythm: d.rhythm,
    axis: d.axis,
    keyLeads: d.keyLeads || {},
    territory: d.territory || null,
    answer: d.name,
    teaching: d.teaching
  };
});
write('ecg_cases.json', JSON.stringify(cases, null, 2));

/* ---- optional deploy into the platform ---- */
if (process.argv.indexOf('--deploy') >= 0) {
  var CVS = path.resolve(ROOT, '..', '..', 'cvs-review');
  var ecgDir = path.join(CVS, 'ecg');
  var libSrc = path.join(ROOT, 'ecg-library');
  var libDst = path.join(ecgDir, 'ecg-library');
  var dataDir = path.join(CVS, 'data');
  fs.mkdirSync(ecgDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  // trainer -> ecg/ecg.html
  fs.copyFileSync(path.join(ROOT, 'ecg-trainer.html'), path.join(ecgDir, 'ecg.html'));
  console.log('deployed ecg/ecg.html');
  // image library (reference, personal study)
  fs.mkdirSync(libDst, { recursive: true });
  fs.readdirSync(libSrc).forEach(function (f) {
    fs.copyFileSync(path.join(libSrc, f), path.join(libDst, f));
  });
  console.log('deployed ecg/ecg-library/ (' + fs.readdirSync(libSrc).length + ' files)');
  // case bank -> data/ecg_cases.json
  fs.writeFileSync(path.join(dataDir, 'ecg_cases.json'), JSON.stringify(cases, null, 2));
  console.log('deployed data/ecg_cases.json');
}
console.log('build complete: ' + cases.length + ' cases.');
