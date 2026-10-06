/* build.mjs — builds the release folder dist/ from the sources in src/.
 *
 * Run: node build.mjs
 *
 * Why a script instead of copying by hand: it checks that no personal data made
 * it into the release. The check is not cosmetic — it stops the build when it
 * finds something. An accidentally published OAuth token means a compromised
 * account, and viewer logins or redemption ids must never reach a public
 * repository.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
/* Sources live in src/extension: that way the src folder cannot be loaded into
 * Chrome as an extension by mistake — the manifest is not at its root, and the
 * ready-to-install release is built into dist/. */
const srcDir = join(root, 'src', 'extension');
const distDir = join(root, 'dist');

/* The files the extension consists of. The sources carry no README: the release
 * has its own documentation in the repository root. */
const FILES = ['manifest.json', 'content.js', 'injected.js', 'content.css'];

/* ------------------------------------------------------------------ *
 * Forbidden content.
 *
 * Every rule describes something that must never end up in a public
 * repository. The list is wider than "a token": it covers anything tied to a
 * specific person or channel.
 *
 * It is important not to overdo it: GraphQL field names such as
 * communityPointsRedemptionQueue look like long strings but are not secrets.
 * That is why "looks like a secret" is a separate function rather than one
 * regular expression on length.
 * ------------------------------------------------------------------ */
const FORBIDDEN = [
  { name: 'OAuth token', re: /OAuth\s+[a-z0-9]{20,}/i },
  // A header value is always one whole string literal. Diagnostic lines that
  // concatenate text and a length do not match this rule.
  { name: 'authorization header value', re: /["'](authorization|client-integrity|x-device-id|client-session-id)["']\s*:\s*["'][^"']{10,}["']/i },
  { name: 'channel id in a variable', re: /channelID["']?\s*[:=]\s*["']\d{6,}["']/i },
  { name: 'long random-looking string (possible secret)', custom: looksLikeSecret }
];

/* Does the string look like a secret?
 *
 * A secret is a random sequence of characters. A human-readable name — even a
 * long one — always contains recognisable syllables, so the check is not about
 * length but about "readability": a secret has few vowels and is full of digits
 * and case switches. */
function looksLikeSecret(line) {
  const candidates = line.match(/[A-Za-z0-9_-]{20,}/g) || [];
  for (const c of candidates) {
    // 64 hex characters is a GraphQL operation hash. The extension cannot work
    // without it, and it is public by nature.
    if (/^[a-f0-9]{64}$/.test(c)) continue;

    const letters = c.replace(/[^A-Za-z]/g, '');
    if (letters.length < 12) continue;

    const vowels = (letters.match(/[aeiouyAEIOUY]/g) || []).length;
    const vowelRatio = vowels / letters.length;
    const hasDigit = /\d/.test(c);
    const mixedCase = /[a-z]/.test(c) && /[A-Z]/.test(c);

    // A random string has few vowels while digits and case switches are common.
    // The 0.28 threshold was chosen so that ordinary variable names and GraphQL
    // field names do not pass it.
    if (vowelRatio < 0.28 && (hasDigit || mixedCase)) {
      return c.slice(0, 40);
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Checking one file.
 * ------------------------------------------------------------------ */
function checkFile(name, text) {
  const problems = [];
  const lines = text.split(/\r?\n/);

  lines.forEach((line, i) => {
    FORBIDDEN.forEach((rule) => {
      if (rule.custom) {
        const hit = rule.custom(line);
        if (hit) {
          problems.push({ file: name, line: i + 1, rule: rule.name, sample: hit });
        }
        return;
      }
      const m = line.match(rule.re);
      if (!m) return;
      problems.push({
        file: name,
        line: i + 1,
        rule: rule.name,
        sample: line.trim().slice(0, 120)
      });
    });
  });

  return problems;
}

/* ------------------------------------------------------------------ *
 * Build.
 * ------------------------------------------------------------------ */
function main() {
  if (!existsSync(srcDir)) {
    console.error('src/ not found — run this from the project root.');
    process.exit(1);
  }

  const missing = FILES.filter((f) => !existsSync(join(srcDir, f)));
  if (missing.length) {
    console.error('Missing files in src/: ' + missing.join(', '));
    process.exit(1);
  }

  console.log('Checking sources for personal data...');
  let problems = [];
  const contents = {};
  for (const f of FILES) {
    const text = readFileSync(join(srcDir, f), 'utf8');
    contents[f] = text;
    problems = problems.concat(checkFile(f, text));
  }

  const manifest = JSON.parse(contents['manifest.json']);
  const version = manifest.version || '(none)';
  console.log('  extension version: ' + version);
  console.log('  permissions: ' + JSON.stringify(manifest.permissions || []));

  if (problems.length) {
    console.error('\nBUILD STOPPED. Forbidden content found:\n');
    problems.forEach((p) => {
      console.error('  ' + p.file + ':' + p.line + ' — ' + p.rule);
      console.error('      ' + p.sample);
    });
    console.error('\nRemove it from src/ and run the build again.');
    process.exit(1);
  }
  console.log('  no personal data found');

  // Rebuild dist from scratch so no files are left over from previous versions.
  if (existsSync(distDir)) rmSync(distDir, { recursive: true, force: true });
  mkdirSync(join(distDir, 'icons'), { recursive: true });

  for (const f of FILES) {
    writeFileSync(join(distDir, f), contents[f], 'utf8');
  }

  const iconsDir = join(srcDir, 'icons');
  if (!existsSync(iconsDir)) {
    console.error('src/ has no icons/ folder');
    process.exit(1);
  }
  const icons = readdirSync(iconsDir).filter((f) => f.endsWith('.png'));
  for (const icon of icons) {
    copyFileSync(join(iconsDir, icon), join(distDir, 'icons', icon));
  }
  console.log('  icons copied: ' + icons.length);

  // Make sure the release was actually built and can be read.
  const built = JSON.parse(readFileSync(join(distDir, 'manifest.json'), 'utf8'));
  if (built.version !== manifest.version) {
    console.error('dist version does not match src — the build is broken.');
    process.exit(1);
  }

  console.log('\nDone. Release is in dist/, version ' + built.version + '.');
  console.log('To install: chrome://extensions -> Developer mode ->');
  console.log('Load unpacked -> select the dist folder.');
}

main();
