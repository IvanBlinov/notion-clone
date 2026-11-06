// Import workspaces from the old local server's data/ folder into Convex.
// Usage: node scripts/import-data.js [--prod]
// Imported workspaces have no owner; the first account that signs up becomes their owner.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = path.join(root, 'data');
const prod = process.argv.includes('--prod');
const sets = [];
const appFile = path.join(data, 'app.json');
if (fs.existsSync(appFile)) {
  const app = JSON.parse(fs.readFileSync(appFile, 'utf8'));
  for (const w of Object.values(app.workspaces)) {
    const f = path.join(data, 'workspaces', `${w.id}.json`);
    if (fs.existsSync(f)) sets.push({ name: w.name, pages: JSON.parse(fs.readFileSync(f, 'utf8')).pages });
  }
} else if (fs.existsSync(path.join(data, 'workspace.json'))) {
  sets.push({ name: 'Workspace', pages: JSON.parse(fs.readFileSync(path.join(data, 'workspace.json'), 'utf8')).pages });
}
if (!sets.length) {
  console.log('Nothing to import (no data/ folder).');
  process.exit(0);
}
for (const s of sets) {
  const args = JSON.stringify({ name: s.name, pages: s.pages });
  // call the Convex CLI directly (no shell) so the JSON argument is passed intact
  const cli = path.join(root, 'node_modules', 'convex', 'bin', 'main.js');
  const out = execFileSync(process.execPath, [cli, 'run', ...(prod ? ['--prod'] : []), 'workspaces:importWorkspace', args], { cwd: root, encoding: 'utf8' });
  console.log(`Imported "${s.name}" (${Object.keys(s.pages).length} pages) → ${out.trim()}`);
}
