/** URL settings for the isolated World study; no engine/editor dependency. */
export const WORLD_STUDY_NUMBERS = Object.freeze([
  { key: 'seed', query: 'seed', input: 'world-seed', fallback: 894, min: 0, max: 0xffffffff, integer: true },
  { key: 'forestDensity', query: 'forest', input: 'forest-density', fallback: 1, min: 0, max: 2 },
  { key: 'groundDensity', query: 'ground', input: 'ground-density', fallback: 1, min: 0, max: 2 },
  { key: 'treeScale', query: 'treeScale', input: 'tree-scale', fallback: 1, min: .65, max: 1.5, group: 'vegetation' },
  { key: 'grassHeight', query: 'grassHeight', input: 'grass-height', fallback: 1, min: .5, max: 1.75, group: 'vegetation' },
  { key: 'patchiness', query: 'patchiness', input: 'vegetation-patchiness', fallback: .65, min: 0, max: 1, group: 'vegetation' },
  { key: 'relief', query: 'relief', input: 'terrain-relief', fallback: 1, min: 0, max: 2.5, group: 'geography' },
  { key: 'riverWidth', query: 'riverWidth', input: 'river-width', fallback: 5, min: 2, max: 8, group: 'geography' },
  { key: 'shoreWidth', query: 'shoreWidth', input: 'shore-width', fallback: 1, min: .65, max: 1.8, group: 'geography' },
  { key: 'rockiness', query: 'rockiness', input: 'rockiness', fallback: 1, min: 0, max: 2, group: 'geography' },
  { key: 'forestCover', query: 'forestCover', input: 'forest-cover', fallback: .72, min: 0, max: 1, group: 'geography' },
  { key: 'surfaceScale', query: 'surfaceScale', input: 'surface-scale', fallback: 1, min: .5, max: 2 },
  { key: 'surfaceBump', query: 'surfaceBump', input: 'surface-bump', fallback: 1, min: 0, max: 2 },
].map(Object.freeze));

const bounded = (value, field) => {
  const parsed = value === null || value === undefined || String(value).trim() === '' ? NaN : Number(value);
  const number = Number.isFinite(parsed) ? Math.max(field.min, Math.min(field.max, parsed)) : field.fallback;
  return field.integer ? Math.floor(number) : number;
};

export function readWorldStudySettings(search = '') {
  const query = new URLSearchParams(search);
  const style = query.get('style') === 'stylized' ? 'stylized' : 'natural';
  const surface = query.get('surface');
  const settings = { style, baseline: query.has('baseline'), geography: {}, vegetation: {},
    surfaceMode: surface === 'materials' || surface === 'procedural' ? surface : style === 'stylized' ? 'procedural' : 'materials',
    surfaceExplicit: surface === 'materials' || surface === 'procedural',
    cottageVariation: bounded(query.get('cottage'), { fallback: 8, min: 0, max: 0xffffffff, integer: true }),
    roofColor: /^#[0-9a-f]{6}$/i.test(query.get('roof') ?? '') ? query.get('roof') : null };
  for (const field of WORLD_STUDY_NUMBERS) {
    (field.group ? settings[field.group] : settings)[field.key] = bounded(query.get(field.query), field);
  }
  return settings;
}

/** Explicit surface choices survive a style change; an implicit choice follows
 * the new style's default. Unrelated diagnostic query flags stay intact. */
export function worldStudySearch(search, settings, { style = settings.baseline ? 'baseline' : settings.style, cottageState } = {}) {
  const query = new URLSearchParams(search);
  query.delete('style'); query.delete('baseline');
  if (style === 'baseline') query.set('baseline', '1');
  else if (style === 'stylized') query.set('style', 'stylized');
  for (const field of WORLD_STUDY_NUMBERS) {
    query.set(field.query, String(bounded((field.group ? settings[field.group] : settings)?.[field.key], field)));
  }
  if (settings.surfaceExplicit) query.set('surface', settings.surfaceMode === 'procedural' ? 'procedural' : 'materials');
  else query.delete('surface');
  query.set('cottage', String(cottageState?.seed ?? settings.cottageVariation));
  const roof = cottageState ? (cottageState.edits.length ? cottageState.roofColor : null) : settings.roofColor;
  if (roof) query.set('roof', roof); else query.delete('roof');
  return query;
}
