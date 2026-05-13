import { execSync } from 'child_process';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';

export function detectProject(cwd) {
  const hints = {};

  // GitHub repo from git remote
  try {
    const remote = execSync('git remote get-url origin', { cwd, encoding: 'utf8' }).trim();
    const match = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
    if (match) hints.repo = match[1];
  } catch {}

  // Landing path
  const landingCandidates = [
    'resources/landing/de',
    'resources/landing',
    'content/landing/de',
    'content/landing',
  ];
  for (const p of landingCandidates) {
    if (existsSync(join(cwd, p))) {
      hints.landing_path = p + '/';
      break;
    }
  }

  // Style doc
  for (const p of ['docs/writing-style.md', 'content/writing-style-rafael.md', 'WRITING_STYLE.md']) {
    if (existsSync(join(cwd, p))) {
      hints.style_doc = p;
      break;
    }
  }

  // Locale from lang files or CLAUDE.md
  if (existsSync(join(cwd, 'lang/de'))) hints.locale = 'de';
  if (existsSync(join(cwd, 'lang/en')) && !existsSync(join(cwd, 'lang/de'))) hints.locale = 'en';

  // Scan existing landing markdowns for clusters + CTA
  if (hints.landing_path) {
    const dir = join(cwd, hints.landing_path);
    const clusterSet = new Set();
    const ctaCounts = {};

    try {
      const files = readdirSync(dir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const content = readFileSync(join(dir, file), 'utf8');
        const fm = parseFrontmatter(content);
        if (fm?.cluster) clusterSet.add(fm.cluster);
        if (fm?.primary_cta) ctaCounts[fm.primary_cta] = (ctaCounts[fm.primary_cta] || 0) + 1;
      }
    } catch {}

    if (clusterSet.size > 0) hints.clusters = [...clusterSet];
    if (Object.keys(ctaCounts).length > 0) {
      hints.primary_cta = Object.entries(ctaCounts).sort((a, b) => b[1] - a[1])[0][0];
    }
  }

  // Domain / GSC property from CLAUDE.md or package.json or config
  hints.gsc_property = detectDomain(cwd);

  return hints;
}

function detectDomain(cwd) {
  // package.json homepage
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    if (pkg.homepage) return pkg.homepage.replace(/\/$/, '');
  } catch {}

  // CLAUDE.md — look for URLs
  for (const f of ['CLAUDE.md', '.claude/CLAUDE.md']) {
    try {
      const content = readFileSync(join(cwd, f), 'utf8');
      const match = content.match(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/i);
      if (match) return match[0];
    } catch {}
  }

  // .env / config files — look for APP_URL
  for (const f of ['.env.example', 'config/app.php']) {
    try {
      const content = readFileSync(join(cwd, f), 'utf8');
      const match = content.match(/APP_URL=["']?(https?:\/\/[^\s"']+)/);
      if (match) return match[1];
    } catch {}
  }

  return null;
}

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]+?)\n---/);
  if (!match) return null;
  try {
    return yaml.load(match[1]);
  } catch {
    return null;
  }
}
