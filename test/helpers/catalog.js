// Shared fixture: a catalog of the shape served by https://punktundpause.de/seo/catalog.json.
export function makeCatalog(overrides = {}) {
  return {
    version: 1,
    generated_at: '2026-10-07T08:00:00+00:00',
    shipping: { cents: 599, delivery: '5 bis 10 werktage' },
    categories: [{ key: 'shirts', label: 'shirts', url: 'https://shop.test/shop?category=shirts' }],
    products: ['tanz-mit-mir', 'nachteule', 'kaffee-first', 'regenbogen', 'sonntag'].map(slug => ({
      slug,
      title: slug.replace('-', ' '),
      category: 'shirts',
      url: `https://shop.test/shop/${slug}`,
      description: `ein shirt namens ${slug}`,
      material: slug === 'nachteule' ? '100 % baumwolle' : '',
      sizes: ['s', 'm', 'l'],
    })),
    ...overrides,
  };
}
