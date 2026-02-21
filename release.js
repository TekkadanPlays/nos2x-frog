#!/usr/bin/env node

/**
 * Cross-platform release builder for Ribbit Signer.
 *
 * Usage:
 *   node release.js firefox        Build Firefox .xpi
 *   node release.js chrome          Build Chrome .zip
 *   node release.js all             Build both
 *
 * Output goes to ./releases/
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createWriteStream } = require('fs');
const archiver = require('archiver');

const DIST = path.join(__dirname, 'dist');
const RELEASES = path.join(__dirname, 'releases');
const SRC = path.join(__dirname, 'src');

const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
const VERSION = manifest.version;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function cleanDist() {
  if (fs.existsSync(DIST)) {
    fs.rmSync(DIST, { recursive: true, force: true });
  }
}

function zipDirectory(sourceDir, outPath) {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
      console.log(`  → ${path.basename(outPath)} (${(archive.pointer() / 1024).toFixed(0)} KB)`);
      resolve();
    });

    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

async function buildFirefox() {
  console.log('\n🦊 Building Firefox extension...');
  cleanDist();

  // Standard build uses src/manifest.json (MV2, Firefox)
  execSync('node build.js prod', { cwd: __dirname, stdio: 'inherit' });

  ensureDir(RELEASES);
  const outFile = path.join(RELEASES, `ribbit-signer-${VERSION}-firefox.xpi`);
  await zipDirectory(DIST, outFile);
}

async function buildChrome() {
  console.log('\n🌐 Building Chrome extension...');
  cleanDist();

  // Build with Chrome manifest (MV3)
  execSync('node build.js prod chrome', { cwd: __dirname, stdio: 'inherit' });

  ensureDir(RELEASES);
  const outFile = path.join(RELEASES, `ribbit-signer-${VERSION}-chrome.zip`);
  await zipDirectory(DIST, outFile);
}

async function main() {
  const target = process.argv[2] || 'all';

  console.log(`Ribbit Signer v${VERSION} — Release Builder`);
  console.log('='.repeat(40));

  ensureDir(RELEASES);

  if (target === 'firefox' || target === 'all') {
    await buildFirefox();
  }

  if (target === 'chrome' || target === 'all') {
    await buildChrome();
  }

  console.log('\n✅ Done! Release files in ./releases/');
}

main().catch(err => {
  console.error('Release build failed:', err);
  process.exit(1);
});
