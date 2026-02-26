/**
 * @module makers
 * localStorage-backed saved market makers list.
 *
 * Storage format:
 * {
 *   makers: {
 *     '<address>': { addedAt: timestamp, label: string|null }
 *   }
 * }
 */

const STORAGE_KEY = 'pelfmont_makers';

function _load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { makers: {} };
    const data = JSON.parse(raw);
    if (!data.makers) data.makers = {};
    return data;
  } catch {
    return { makers: {} };
  }
}

function _save(data) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }
  catch (err) { console.warn('Makers save failed:', err); }
}

// ── Maker operations ─────────────────────────────────────────────

/** Get all saved maker addresses */
export function getAll() {
  return Object.keys(_load().makers);
}

/** Get all makers with metadata */
export function getAllWithMeta() {
  return _load().makers;
}

/** Check if a maker is saved */
export function has(address) {
  return address in _load().makers;
}

/** Add a maker */
export function add(address, label = null) {
  const data = _load();
  if (!(address in data.makers)) {
    data.makers[address] = { addedAt: Date.now(), label };
    _save(data);
  }
}

/** Remove a maker */
export function remove(address) {
  const data = _load();
  if (address in data.makers) {
    delete data.makers[address];
    _save(data);
  }
}

/** Toggle a maker (add/remove) — returns new state */
export function toggle(address) {
  if (has(address)) { remove(address); return false; }
  add(address); return true;
}

/** Update a maker's label */
export function setLabel(address, label) {
  const data = _load();
  if (address in data.makers) {
    data.makers[address].label = label;
    _save(data);
  }
}

/** Get count */
export function count() {
  return Object.keys(_load().makers).length;
}

// ── Export / Import ──────────────────────────────────────────────

export function exportData() {
  const data = _load();
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    makers: data.makers,
  };
}

/**
 * Import makers from a JSON object. Merges into existing data.
 * - New makers are added; existing are skipped (no duplicates).
 * @returns {{ added: number, skipped: number }}
 */
export function importData(imported) {
  if (!imported || typeof imported !== 'object') throw new Error('Invalid makers file');
  const importedMakers = imported.makers || {};
  const data = _load();
  let added = 0;
  let skipped = 0;

  for (const [addr, meta] of Object.entries(importedMakers)) {
    if (addr in data.makers) {
      skipped++;
    } else {
      data.makers[addr] = {
        addedAt: meta.addedAt || Date.now(),
        label: meta.label || null,
      };
      added++;
    }
  }

  _save(data);
  return { added, skipped };
}