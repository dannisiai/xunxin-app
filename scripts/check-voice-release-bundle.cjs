const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const output = path.resolve(process.argv[2] || '.next');
const manifest = JSON.parse(fs.readFileSync(path.join(output, 'server/app-paths-manifest.json'), 'utf8'));
const route = manifest['/api/voice/compatible-speech/route'];
if (!route || !fs.existsSync(path.join(output, 'server', route))) {
  throw new Error('The production bundle is missing the compatible-speech relay.');
}
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? files(full) : entry.name.endsWith('.js') ? [full] : [];
  });
}
const chunks = files(path.join(output, 'static')).map(file => ({ file, source: fs.readFileSync(file, 'utf8') }));
const requirements = {
  aacUpload: '.wav,.mp3,.flac,.m4a,.aac',
  aacMime: 'audio/aac',
  baseRequiresReference: 'Qwen3-TTS Base 需要参考音频',
  playbackErrors: 'reportPlaybackErrors',
  compatibleRelayClient: '/api/voice/compatible-speech',
};
const proof = {};
for (const [feature, marker] of Object.entries(requirements)) {
  const matches = chunks.filter(chunk => chunk.source.includes(marker));
  if (!matches.length) throw new Error('The production client bundle is missing voice feature: ' + feature);
  proof[feature] = matches.map(chunk => ({
    file: path.relative(output, chunk.file).replaceAll(path.sep, '/'),
    sha256: crypto.createHash('sha256').update(chunk.source).digest('hex'),
  }));
}
const audit = {
  sourceCommit: process.env.GITHUB_SHA || null,
  route,
  routeSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(output, 'server', route))).digest('hex'),
  clientJavaScriptFiles: chunks.length,
  features: proof,
};
fs.writeFileSync(path.join(output, 'voice-release-audit.json'), JSON.stringify(audit, null, 2) + '\n');
console.log('Production voice bundle includes AAC upload, required Base references, playback errors, and the compatible relay.');
