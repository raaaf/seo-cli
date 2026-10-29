// Pages whose text someone else maintains (e.g. a shop's product pages, written by the shop owner).
// Config: `content_owners: [{ name: 'Alex', paths: ['/shop/'] }]`. Pure, no I/O.

const pathOf = (url) => {
  const m = /^https?:\/\/[^/]+(\/[^?#]*)?/i.exec(String(url ?? ''));
  return m ? (m[1] || '/') : String(url ?? '');
};

// '/shop/' covers '/shop/x' and '/shop' itself; '/shop' covers '/shop' and '/shop/x', not '/shopping'.
function matchesPrefix(path, prefix) {
  const bare = prefix.replace(/\/+$/, '');
  if (!bare) return true;
  return path === bare || path.startsWith(`${bare}/`);
}

/**
 * Name of the owner whose paths cover every given URL, else null (no URLs, no owner, or the URLs span
 * pages that are not all theirs). The first matching owner wins.
 */
export function contentOwnerFor(config, urls) {
  const owners = config?.content_owners ?? [];
  const paths = (urls ?? []).map(pathOf);
  if (!owners.length || !paths.length) return null;
  const owner = owners.find(o => paths.every(p => o.paths.some(prefix => matchesPrefix(p, prefix))));
  return owner ? owner.name : null;
}

/** Normalised `content_owners`: entries without a name or paths are dropped with a warning. */
export function normalizeContentOwners(value, warn) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    warn('content_owners must be a list, ignoring it');
    return [];
  }
  const owners = [];
  for (const o of value) {
    const name = typeof o?.name === 'string' ? o.name.trim() : '';
    const paths = Array.isArray(o?.paths) ? o.paths.filter(p => typeof p === 'string' && p.startsWith('/')) : [];
    if (!name || !paths.length) {
      warn('content_owners entries need a name and paths starting with "/", ignoring one');
      continue;
    }
    owners.push({ name, paths });
  }
  return owners;
}
