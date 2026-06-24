// Shared fixture: a landing-page markdown document that passes validate().
// Single source of truth for "a valid page", used by validate.test.js and check.test.js.

// Exactly 50 words.
export const TLDR_50 = 'Webdesign Berlin vereint visuelle Gestaltung technische Umsetzung und nutzerzentriertes Denken zu einer kohaerent Einheit. Klare Typografie ausreichend Kontrast und strukturierte Navigation sorgen dafuer dass Besucher ihr Ziel schnell erreichen ohne Ablenkung. Professionelle Agenturen liefern skalierbare Loesungen fuer Unternehmen die im digitalen Raum sichtbar wachsen und konvertieren wollen.';

export const FAQ_BLOCK = `faq:
  - q: Was kostet Webdesign Berlin?
    a: Die Kosten liegen zwischen 1000 und 5000 Euro je nach Umfang.
  - q: Wie lange dauert ein Webdesign Projekt?
    a: In der Regel vier bis acht Wochen je nach Feedback-Zyklen.
  - q: Welche Technologien werden genutzt?
    a: HTML CSS und JavaScript sind Standard, oft ergaenzt durch React oder Vue.
  - q: Gibt es laufende Kosten?
    a: Hosting und Wartung fallen monatlich an, typisch 20 bis 80 Euro.`;

export function makeBody(extra = '') {
  // Keyword appears once; filler is keyword-free to stay far below the 4% density cap.
  const filler = 'Moderne Webseiten brauchen klare Strukturen schnelle Ladezeiten und verstaendliche Inhalte fuer alle Besucher im digitalen Alltag. ';
  let body = 'Professionelles Webdesign Berlin umfasst visuelle Gestaltung und technische Umsetzung fuer moderne Webseiten. ';
  while (body.split(/\s+/).filter(Boolean).length < 900) body += filler;
  body += 'Konkrete Zahlen: 10 Projekte 20 Kunden 30 Seiten 40 Stunden 50 Iterationen helfen bei der Planung.';
  return extra ? body + ' ' + extra : body;
}

export function makeValidPage(overrides = {}) {
  const body = overrides.body ?? makeBody();
  const tldr = overrides.tldr ?? TLDR_50;
  return `---
slug: webdesign-berlin
meta_title: Webdesign Berlin fuer professionelle Webseiten Projekte
meta_description: Professionelles Webdesign Berlin fuer kleine und mittlere Unternehmen. Moderne Gestaltung, schnelle Umsetzung und klare Struktur fuer mehr Conversions und Sichtbarkeit.
hero:
  headline: Webdesign Berlin fuer moderne Unternehmen
tldr: "${tldr}"
${FAQ_BLOCK}
---
${body}`;
}
