// Assemble the static site (GitHub Pages) into dist/.
// Needs the Convex URL: from $CONVEX_URL (set by `npx convex deploy --cmd ...`) or .env.local (`npx convex dev`).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

function envLocal() {
  const file = path.join(root, '.env.local');
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/))
      .filter(Boolean)
      .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]),
  );
}
const local = envLocal();
const convexUrl = process.env.CONVEX_URL || local.CONVEX_URL;
if (!convexUrl) {
  console.error('No CONVEX_URL. Run `npx convex dev` first (writes .env.local) or set CONVEX_URL.');
  process.exit(1);
}
const siteUrl =
  process.env.CONVEX_SITE_URL ||
  (process.env.CONVEX_URL ? null : local.CONVEX_SITE_URL) ||
  convexUrl.replace('.convex.cloud', '.convex.site').replace(/:3210\b/, ':3211');

fs.rmSync(dist, { recursive: true, force: true });
fs.cpSync(path.join(root, 'public'), dist, { recursive: true });
fs.mkdirSync(path.join(dist, 'shared'), { recursive: true });
for (const f of ['markdown.js', 'database.js']) fs.copyFileSync(path.join(root, 'src', 'shared', f), path.join(dist, 'shared', f));
fs.mkdirSync(path.join(dist, 'vendor'), { recursive: true });
fs.copyFileSync(path.join(root, 'node_modules', 'convex', 'dist', 'browser.bundle.js'), path.join(dist, 'vendor', 'convex.js'));
fs.writeFileSync(path.join(dist, 'config.js'), `window.NOTION_CONFIG = ${JSON.stringify({ convexUrl, siteUrl })};\n`);
fs.writeFileSync(path.join(dist, '.nojekyll'), '');
console.log(`Built dist/ → Convex ${convexUrl} (HTTP ${siteUrl})`);
