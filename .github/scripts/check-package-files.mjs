// CI guard: ensure the published npm tarball includes ALL emitted build output (dist/).
//
// Why this exists: 1.6.1 was published WITHOUT dist/. package.json points main at
// dist/index.js but there was no "files" field and no .npmignore, so npm fell back
// to .gitignore (which lists dist/) and dropped the compiled output from the tarball
// — every consumer got "Module not found: @uoa-css-lab/duckscatter".
//
// Checking only the entrypoint is NOT enough: dist/index.js re-exports other emitted
// modules (scatter-plot.js, renderer/*, data/*, ...), so a files/.npmignore change
// that kept only dist/index.* would pass an entrypoint-only check yet still break
// consumers resolving the entrypoint's imports. So assert EVERY file emitted under
// dist/ on disk is present in the tarball `npm pack` would produce.
//
// Run after `npm run build` (ci job) or after restoring the dist cache (publish job).
import { execSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

// Recursively list every file under a directory, as posix-style relative paths.
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

let emitted;
try {
  emitted = walk('dist').map((p) => p.split('\\').join('/'));
} catch {
  console.error('::error::dist/ not found — run `npm run build`, or the dist cache restore failed.');
  process.exit(1);
}
if (emitted.length === 0) {
  console.error('::error::dist/ is empty — there is no build output to publish.');
  process.exit(1);
}

const out = JSON.parse(execSync('npm pack --dry-run --json').toString());
const packed = new Set(out[0].files.map((f) => f.path.split('\\').join('/')));

const missing = emitted.filter((f) => !packed.has(f));
if (missing.length > 0) {
  const shown = missing.slice(0, 10).join(', ');
  console.error(
    `::error::npm package would omit ${missing.length} emitted dist file(s): ` +
      `${shown}${missing.length > 10 ? ', …' : ''}. ` +
      `Check the package.json "files" field / .npmignore.`
  );
  process.exit(1);
}

console.log(`OK: all ${emitted.length} emitted dist/ files are present in the package tarball.`);
