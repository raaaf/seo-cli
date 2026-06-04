import { readdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { loadConfig } from './config.js';

// Roots scanned for projects that contain a seo.config.yaml.
// Override with SEO_PROJECT_ROOTS (colon-separated absolute paths).
function roots() {
  const env = process.env.SEO_PROJECT_ROOTS;
  if (env) return env.split(':').map(s => s.trim()).filter(Boolean);
  return [join(homedir(), 'Local Sites')];
}

const IGNORE = new Set(['node_modules', 'vendor', 'dist', 'build', '.next', '.git']);

// Yield directories that hold a seo.config.yaml, up to `depth` levels deep.
// Does not descend into a project once found.
function* walk(dir, depth) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory() || IGNORE.has(e.name) || e.name.startsWith('.')) continue;
    const child = join(dir, e.name);
    if (existsSync(join(child, 'seo.config.yaml'))) {
      yield child;
      continue;
    }
    if (depth > 1) yield* walk(child, depth - 1);
  }
}

// Discover all SEO-CLI projects under the configured roots.
// Returns [{ path, dir, name, config }] sorted by display name.
export function discoverProjects() {
  const found = [];
  const seen = new Set();
  for (const root of roots()) {
    if (!existsSync(root)) continue;
    for (const path of walk(root, 3)) {
      if (seen.has(path)) continue;
      seen.add(path);
      try {
        const config = loadConfig(path);
        found.push({ path, dir: basename(path), name: config.project || basename(path), config });
      } catch {
        // Unparseable config — skip silently, it is not a usable project.
      }
    }
  }
  found.sort((a, b) => a.dir.localeCompare(b.dir));
  return found;
}
