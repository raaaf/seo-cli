import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkCommand } from '../src/commands/check.js';

const TLDR_50 = 'Webdesign Berlin vereint visuelle Gestaltung technische Umsetzung und nutzerzentriertes Denken zu einer kohaerent Einheit. Klare Typografie ausreichend Kontrast und strukturierte Navigation sorgen dafuer dass Besucher ihr Ziel schnell erreichen ohne Ablenkung. Professionelle Agenturen liefern skalierbare Loesungen fuer Unternehmen die im digitalen Raum sichtbar wachsen und konvertieren wollen.';
const FAQ_BLOCK = `faq:
  - q: Was kostet Webdesign Berlin?
    a: Die Kosten liegen zwischen 1000 und 5000 Euro je nach Umfang.
  - q: Wie lange dauert ein Webdesign Projekt?
    a: In der Regel vier bis acht Wochen je nach Feedback-Zyklen.
  - q: Welche Technologien werden genutzt?
    a: HTML CSS und JavaScript sind Standard, oft ergaenzt durch React oder Vue.`;

function validDoc() {
  const filler = 'Moderne Webseiten brauchen klare Strukturen schnelle Ladezeiten und verstaendliche Inhalte fuer alle Besucher im digitalen Alltag. ';
  let body = 'Professionelles Webdesign Berlin umfasst visuelle Gestaltung und technische Umsetzung fuer moderne Webseiten. ';
  while (body.split(/\s+/).filter(Boolean).length < 900) body += filler;
  body += 'Konkrete Zahlen: 10 Projekte 20 Kunden 30 Seiten 40 Stunden 50 Iterationen helfen bei der Planung.';
  return `---
slug: webdesign-berlin
meta_title: Webdesign Berlin fuer professionelle Webseiten Projekte
meta_description: Professionelles Webdesign Berlin fuer kleine und mittlere Unternehmen. Moderne Gestaltung, schnelle Umsetzung und klare Struktur fuer mehr Conversions und Sichtbarkeit.
hero:
  headline: Webdesign Berlin fuer moderne Unternehmen
tldr: "${TLDR_50}"
${FAQ_BLOCK}
---
${body}`;
}

let dir, cwd, logs, exitSpy;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seo-check-'));
  cwd = process.cwd();
  process.chdir(dir);
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.join(' ')));
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit:${code}`); });
});
afterEach(() => {
  process.chdir(cwd);
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function checkJson() {
  const line = logs.find(l => l.includes('SEO_CHECK_JSON='));
  return JSON.parse(line.slice(line.indexOf('SEO_CHECK_JSON=') + 'SEO_CHECK_JSON='.length));
}

describe('check-cmd', () => {
  it('exits 2 when no files are given', async () => {
    await expect(checkCommand([])).rejects.toThrow('exit:2');
  });

  it('passes a clean page and emits SEO_CHECK_JSON ok:true', async () => {
    writeFileSync(join(dir, 'webdesign-berlin.md'), validDoc(), 'utf8');
    await checkCommand(['webdesign-berlin.md']);
    const report = checkJson();
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('reports a missing file and exits 1', async () => {
    await expect(checkCommand(['nope.md'])).rejects.toThrow('exit:1');
    const report = checkJson();
    expect(report.ok).toBe(false);
    expect(report.pages[0].errors[0]).toMatch(/File not found/);
  });
});
