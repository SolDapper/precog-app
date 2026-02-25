/**
 * @module watchlist
 * localStorage-backed market watchlist with category support.
 *
 * Storage format:
 * {
 *   categories: ['Crypto', 'Politics', 'Sports'],
 *   markets: {
 *     '<address>': { addedAt: timestamp, category: 'Crypto' | null }
 *   }
 * }
 */

const STORAGE_KEY = 'precog_watchlist';
const DEFAULT_CATEGORIES = ['Crypto', 'Politics', 'Sports', 'Culture', 'Other', 'Trash'];
const PROTECTED_CATEGORIES = ['Trash'];

function _load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { categories: [...DEFAULT_CATEGORIES], markets: {} };
    const data = JSON.parse(raw);
    // Migration: if old array format, convert
    if (Array.isArray(data)) {
      const markets = {};
      for (const addr of data) markets[addr] = { addedAt: Date.now(), category: null };
      return { categories: [...DEFAULT_CATEGORIES], markets };
    }
    if (!data.categories) data.categories = [...DEFAULT_CATEGORIES];
    if (!data.markets) data.markets = {};
    // Ensure protected categories always exist
    for (const pc of PROTECTED_CATEGORIES) {
      if (!data.categories.includes(pc)) data.categories.push(pc);
    }
    return data;
  } catch {
    return { categories: [...DEFAULT_CATEGORIES], markets: {} };
  }
}

function _save(data) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }
  catch (err) { console.warn('Watchlist save failed:', err); }
}

// ── Market operations ────────────────────────────────────────────

/** Get all watchlisted market addresses */
export function getAll() {
  return Object.keys(_load().markets);
}

/** Get all markets with their metadata */
export function getAllWithMeta() {
  return _load().markets;
}

/** Check if a market is watchlisted */
export function has(address) {
  return address in _load().markets;
}

/** Add a market to the watchlist */
export function add(address, category = null) {
  const data = _load();
  if (address in data.markets) return false;
  data.markets[address] = { addedAt: Date.now(), category };
  _save(data);
  return true;
}

/** Remove a market */
export function remove(address) {
  const data = _load();
  if (!(address in data.markets)) return false;
  delete data.markets[address];
  _save(data);
  return true;
}

/** Toggle watchlist status. Returns new state (true = added). */
export function toggle(address) {
  if (has(address)) { remove(address); return false; }
  add(address);
  return true;
}

/** Set the category for a market */
export function setCategory(address, category) {
  const data = _load();
  if (!(address in data.markets)) return false;
  data.markets[address].category = category || null;
  _save(data);
  return true;
}

/** Get category for a market */
export function getCategory(address) {
  const data = _load();
  return data.markets[address]?.category || null;
}

/** Get addresses filtered by category (null = uncategorized) */
export function getByCategory(category) {
  const data = _load();
  return Object.entries(data.markets)
    .filter(([, meta]) => category === null ? !meta.category : meta.category === category)
    .map(([addr]) => addr);
}

/** Clear all markets */
export function clearMarkets() {
  const data = _load();
  data.markets = {};
  _save(data);
}

// ── Category operations ──────────────────────────────────────────

/** Get all categories */
export function getCategories() {
  return _load().categories;
}

/** Add a new category */
export function addCategory(name) {
  const data = _load();
  const trimmed = name.trim();
  if (!trimmed || data.categories.includes(trimmed)) return false;
  data.categories.push(trimmed);
  _save(data);
  return true;
}

/** Remove a category (markets in it become uncategorized) */
export function removeCategory(name) {
  if (PROTECTED_CATEGORIES.includes(name)) return false;
  const data = _load();
  const idx = data.categories.indexOf(name);
  if (idx === -1) return false;
  data.categories.splice(idx, 1);
  // Uncategorize any markets in this category
  for (const addr of Object.keys(data.markets)) {
    if (data.markets[addr].category === name) {
      data.markets[addr].category = null;
    }
  }
  _save(data);
  return true;
}

/** Rename a category */
export function renameCategory(oldName, newName) {
  if (PROTECTED_CATEGORIES.includes(oldName)) return false;
  const data = _load();
  const trimmed = newName.trim();
  const idx = data.categories.indexOf(oldName);
  if (idx === -1 || !trimmed || data.categories.includes(trimmed)) return false;
  data.categories[idx] = trimmed;
  // Update markets
  for (const addr of Object.keys(data.markets)) {
    if (data.markets[addr].category === oldName) {
      data.markets[addr].category = trimmed;
    }
  }
  _save(data);
  return true;
}

/** Count markets total */
export function count() {
  return Object.keys(_load().markets).length;
}

/** Check if a category is protected (cannot be removed or renamed) */
export function isProtected(name) {
  return PROTECTED_CATEGORIES.includes(name);
}

/** Sort categories: alphabetical, with protected categories (Trash) always last */
export function sortedCategories(cats) {
  return [...cats].sort((a, b) => {
    const aP = PROTECTED_CATEGORIES.includes(a) ? 1 : 0;
    const bP = PROTECTED_CATEGORIES.includes(b) ? 1 : 0;
    if (aP !== bP) return aP - bP;
    return a.localeCompare(b);
  });
}

/** Clear all markets in the Trash category */
export function clearTrash() {
  const data = _load();
  for (const addr of Object.keys(data.markets)) {
    if (data.markets[addr].category === 'Trash') {
      delete data.markets[addr];
    }
  }
  _save(data);
}

/** Export watchlist as a JSON object */
export function exportData() {
  const data = _load();
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    categories: data.categories,
    markets: data.markets,
  };
}

/**
 * Import watchlist from a JSON object. Merges into existing data.
 * - New markets are added; existing markets are skipped (no duplicates).
 * - New categories from the import are added.
 * - For markets that exist in both, the imported category wins.
 * @returns {{ marketsAdded: number, marketsUpdated: number, categoriesAdded: number }}
 */
export function importData(imported) {
  if (!imported || typeof imported !== 'object') throw new Error('Invalid watchlist file');
  const importedMarkets = imported.markets || {};
  const importedCategories = imported.categories || [];

  const data = _load();
  let marketsAdded = 0;
  let marketsUpdated = 0;
  let categoriesAdded = 0;

  // Merge categories
  for (const cat of importedCategories) {
    const trimmed = (typeof cat === 'string') ? cat.trim() : '';
    if (trimmed && !data.categories.includes(trimmed)) {
      data.categories.push(trimmed);
      categoriesAdded++;
    }
  }

  // Ensure protected categories
  for (const pc of PROTECTED_CATEGORIES) {
    if (!data.categories.includes(pc)) data.categories.push(pc);
  }

  // Merge markets
  for (const [addr, meta] of Object.entries(importedMarkets)) {
    if (addr in data.markets) {
      // Existing market — imported category wins if present
      if (meta.category && meta.category !== data.markets[addr].category) {
        data.markets[addr].category = meta.category;
        marketsUpdated++;
      }
    } else {
      // New market
      data.markets[addr] = {
        addedAt: meta.addedAt || Date.now(),
        category: meta.category || null,
      };
      marketsAdded++;
    }
  }

  _save(data);
  return { marketsAdded, marketsUpdated, categoriesAdded };
}