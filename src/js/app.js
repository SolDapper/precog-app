/**
 * @module app
 * Main application controller.
 */
import { Buffer } from 'buffer';
window.Buffer = Buffer;

import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { PROGRAM_ID, MARKET_POLL_MS, RPC_URL, PRICE_CACHE_MS, SOL_MINT } from './config.js';
import * as wallet from './wallet.js';
import * as sdk from './sdk.js';
import * as ui from './ui.js';
import * as watchlist from './watchlist.js';

// ═══════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════
let allMarkets = [];
let currentFilter = 'open';
let currentSort = 'deadline';
let currentCreatorFilter = 'all';
let currentCategoryFilter = 'all';
let currentMarketPubkey = null;
let currentMarketData = null;
let selectedOutcome = null;

// Pagination
const PAGE_SIZE = 20;
let currentPage = 0;
let filteredMarkets = [];   // current filtered+sorted list
let _loadMoreObserver = null;
let currentTokenFilter = 'all';
let pollInterval = null;

// User positions cache — Map<marketAddress, Array<{outcomeIndex, amount}>>
let userPositionsMap = new Map();
let _positionsLoading = false;

/** Fetch all positions for the connected wallet and index by market address */
async function refreshUserPositions() {
  const w = wallet.getWallet();
  if (!w) { userPositionsMap = new Map(); return; }
  if (_positionsLoading) return;
  _positionsLoading = true;
  try {
    const positions = await sdk.fetchPositionsByOwner(w.publicKey);
    const map = new Map();
    for (const { account: pos } of positions) {
      const mktAddr = pos.market.toBase58();
      if (!map.has(mktAddr)) map.set(mktAddr, []);
      map.get(mktAddr).push({ outcomeIndex: pos.outcomeIndex, amount: pos.amount, claimed: pos.claimed });
    }
    userPositionsMap = map;
  } catch (err) {
    console.warn('Failed to refresh user positions:', err);
  } finally {
    _positionsLoading = false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// View Router
// ═══════════════════════════════════════════════════════════════════
const viewNames = ['explore', 'market', 'positions', 'create', 'admin', 'watchlist', 'info'];

/** Update the URL hash without triggering hashchange handler re-entrantly */
let _suppressHashChange = false;
function setHash(hash) {
  _suppressHashChange = true;
  window.location.hash = hash;
  // Reset on next tick
  setTimeout(() => { _suppressHashChange = false; }, 0);
}

function switchView(name, { updateHash = true } = {}) {
  viewNames.forEach(v => {
    const el = document.getElementById(`view-${v}`);
    if (el) el.classList.toggle('hidden', v !== name);
  });
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === name);
  });
  if (updateHash && name !== 'market') setHash(`#/${name}`);
  if (name === 'explore') loadMarkets();
  if (name === 'positions') loadPositions();
  if (name === 'admin') loadAdmin();
  if (name === 'create') updateCreateForm();
  if (name === 'watchlist') loadWatchlist();
}

// ═══════════════════════════════════════════════════════════════════
// Watchlist Star Picker
// ═══════════════════════════════════════════════════════════════════

/**
 * Handle clicking a watchlist star. If already watched, removes it.
 * If not watched, shows a category picker popup, then adds with the chosen category.
 * @param {string} addr - market address
 * @param {function} onUpdate - called with (nowWatched: boolean) after change
 */
function handleWatchlistStarClick(addr, onUpdate) {
  if (watchlist.has(addr)) {
    // Already watched — remove
    watchlist.remove(addr);
    onUpdate(false);
    return;
  }

  // Show category picker
  const categories = watchlist.getCategories();

  const overlay = document.createElement('div');
  overlay.className = 'watchlist-picker-overlay';
  overlay.innerHTML = `
    <div class="watchlist-picker">
      <div class="watchlist-picker-title">Add to Watchlist</div>
      <div class="watchlist-picker-options">
        <button class="watchlist-picker-option" data-cat="">No Category</button>
        ${categories.map(c => `<button class="watchlist-picker-option" data-cat="${c}">${c}</button>`).join('')}
      </div>
      <button class="watchlist-picker-cancel">Cancel</button>
    </div>
  `;

  overlay.querySelector('.watchlist-picker-cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  overlay.querySelectorAll('.watchlist-picker-option').forEach(btn => {
    btn.addEventListener('click', () => {
      const cat = btn.dataset.cat || null;
      watchlist.add(addr, cat);
      overlay.remove();
      onUpdate(true);
    });
  });

  document.body.appendChild(overlay);
}

// ═══════════════════════════════════════════════════════════════════
// Explore View
// ═══════════════════════════════════════════════════════════════════
async function loadMarkets() {
  const listEl = document.getElementById('markets-list');
  try {
    if (allMarkets.length === 0) {
      listEl.innerHTML = '<div class="loading-state"><div class="spinner"></div><span>Loading markets…</span></div>';
    }
    const [markets] = await Promise.all([sdk.fetchAllMarkets(), refreshUserPositions()]);
    allMarkets = markets;

    // Pre-resolve token metadata for all unique non-SOL mints
    const mints = new Set();
    for (const { account } of allMarkets) {
      if (account.denomination !== 0) {
        mints.add(account.tokenMint.toBase58());
      }
    }
    await Promise.all([...mints].map(m => fetchTokenIcon(m)));

    // Augment each market with resolved token info
    for (const { account } of allMarkets) {
      if (account.denomination === 0) {
        account._tokenSymbol = 'SOL';
        account._tokenName = 'Solana';
        account._tokenIcon = SOL_ICON;
      } else {
        const mint = account.tokenMint.toBase58();
        const meta = _tokenIconCache.get(mint) || { icon: '', name: '', symbol: '' };
        account._tokenSymbol = meta.symbol || 'Token';
        account._tokenName = meta.name || mint.slice(0, 6) + '…';
        account._tokenIcon = meta.icon || '';
      }
    }

    // Fetch USD prices for all unique mints (SOL + tokens) — non-blocking for chart
    const allMints = new Set();
    allMints.add(SOL_MINT); // wrapped SOL for price lookup
    for (const { account } of allMarkets) {
      if (account.denomination !== 0) allMints.add(account.tokenMint.toBase58());
    }
    fetchTokenPrices([...allMints]).then(prices => {
      const solPrice = prices.get(SOL_MINT) || 0;
      for (const { account } of allMarkets) {
        if (account.denomination === 0) {
          const solAmount = Number(account.totalPool) / 1e9;
          account._usdVolume = solAmount * solPrice;
        } else {
          const mint = account.tokenMint.toBase58();
          const tokenPrice = prices.get(mint) || 0;
          const decimals = account.tokenDecimals || 9;
          const tokenAmount = Number(account.totalPool) / (10 ** decimals);
          account._usdVolume = tokenAmount * (tokenPrice || 1);
        }
      }
      // Re-render chart and list cards with USD values
      const chartWrap = document.getElementById('explore-chart-wrap');
      if (chartWrap && !chartWrap.classList.contains('hidden') && allMarkets.length > 0) {
        requestAnimationFrame(() => ui.renderVolumeChart(allMarkets, openMarketDetail));
      }
      renderMarketsList(false);
    }).catch(() => {});

    // On poll refresh, don't reset the page — show same amount user has scrolled to
    const isInitialLoad = listEl.querySelector('.loading-state') !== null;
    renderMarketsList(isInitialLoad);
  } catch (err) {
    console.error('Failed to load markets:', err);
    listEl.innerHTML = '<div class="empty-state">Failed to load markets. Check RPC connection.</div>';
  }
}

function renderMarketsList(resetPage = true) {
  const listEl = document.getElementById('markets-list');

  // Populate filter dropdowns from all markets
  populateCreatorFilter();
  populateCategoryFilter();
  populateTokenFilter();

  // Reset page when filters/sort change
  if (resetPage) currentPage = 0;

  let filtered = allMarkets;

  // Creator filter
  if (currentCreatorFilter !== 'all') {
    filtered = filtered.filter(m => m.account.authority.toBase58() === currentCreatorFilter);
  }

  // On-chain category filter
  if (currentCategoryFilter !== 'all') {
    filtered = filtered.filter(m => {
      const { category } = ui.parseDescription(m.account.description);
      if (currentCategoryFilter === '__none') return !category;
      return category === currentCategoryFilter;
    });
  }

  // Token filter
  if (currentTokenFilter !== 'all') {
    if (currentTokenFilter === NATIVE_SOL_MINT) {
      filtered = filtered.filter(m => m.account.denomination === 0);
    } else {
      filtered = filtered.filter(m => m.account.tokenMint.toBase58() === currentTokenFilter);
    }
  }

  // Status / mine filter
  if (currentFilter === 'mine') {
    const w = wallet.getWallet();
    if (!w) {
      listEl.innerHTML = '<div class="empty-state">Connect your wallet to see your markets.</div>';
      return;
    }
    const myAddr = w.publicKey.toBase58();
    filtered = filtered.filter(m => m.account.authority.toBase58() === myAddr);
  } else if (currentFilter !== 'all') {
    const map = { open: 0, resolved: 1, finalized: 2, voided: 3 };
    const val = map[currentFilter];
    if (val !== undefined) filtered = filtered.filter(m => m.account.status === val);
  }
  switch (currentSort) {
    case 'value-desc': filtered.sort((a, b) => (b.account._usdVolume || 0) - (a.account._usdVolume || 0)); break;
    case 'value-asc': filtered.sort((a, b) => (a.account._usdVolume || 0) - (b.account._usdVolume || 0)); break;
    case 'deadline': filtered.sort((a, b) => Number(a.account.resolutionDeadline - b.account.resolutionDeadline)); break;
    case 'positions': filtered.sort((a, b) => Number(b.account.totalPositions - a.account.totalPositions)); break;
  }

  // Store for pagination
  filteredMarkets = filtered;

  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="empty-state">No ${currentFilter === 'all' ? '' : currentFilter} markets found.</div>`;
    cleanupLoadMoreObserver();
    return;
  }

  // Render first page (or up to current scroll position on refresh)
  listEl.innerHTML = '';
  const itemsToShow = resetPage ? PAGE_SIZE : currentPage * PAGE_SIZE;
  const end = Math.min(itemsToShow, filtered.length);
  appendMarketCards(listEl, filtered, 0, end);
  if (resetPage) currentPage = 1;
  else currentPage = Math.max(1, Math.ceil(end / PAGE_SIZE));

  // Add footer (count + load more)
  appendListFooter(listEl, end, filtered.length);

  // Refresh chart if the panel is already open
  const chartWrap = document.getElementById('explore-chart-wrap');
  if (chartWrap && !chartWrap.classList.contains('hidden') && allMarkets.length > 0) {
    requestAnimationFrame(() => ui.renderVolumeChart(allMarkets, openMarketDetail));
  }
}

/** Append market cards for a range of filteredMarkets */
function appendMarketCards(listEl, markets, start, end) {
  for (let i = start; i < end; i++) {
    const { pubkey, account } = markets[i];
    const positions = userPositionsMap.get(pubkey.toBase58()) || null;
    const card = ui.renderMarketCard(pubkey, account, positions);
    card.addEventListener('click', (e) => {
      if (e.target.closest('.watchlist-star')) return;
      openMarketDetail(pubkey);
    });
    listEl.appendChild(card);
  }

  // Attach watchlist star handlers for newly added cards
  listEl.querySelectorAll('.watchlist-star:not([data-bound])').forEach(btn => {
    btn.dataset.bound = '1';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const addr = btn.dataset.addr;
      handleWatchlistStarClick(addr, (nowWatched) => {
        btn.textContent = nowWatched ? '★' : '☆';
        btn.classList.toggle('active', nowWatched);
      });
    });
  });
}

/** Add or update the list footer with count and load more button */
function appendListFooter(listEl, shown, total) {
  // Remove existing footer
  listEl.querySelector('.markets-list-footer')?.remove();
  cleanupLoadMoreObserver();

  const hasMore = shown < total;

  const footer = document.createElement('div');
  footer.className = 'markets-list-footer';
  footer.innerHTML = `
    <span class="markets-count">Showing ${Math.min(shown, total)} of ${total} market${total !== 1 ? 's' : ''}</span>
    ${hasMore ? `<button class="load-more-btn">Load More</button>` : ''}
    ${hasMore ? `<div class="load-more-sentinel"></div>` : ''}
  `;
  listEl.appendChild(footer);

  if (hasMore) {
    // Load more button
    footer.querySelector('.load-more-btn').addEventListener('click', loadMoreMarkets);

    // IntersectionObserver for auto-loading
    const sentinel = footer.querySelector('.load-more-sentinel');
    _loadMoreObserver = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) loadMoreMarkets();
    }, { rootMargin: '200px' });
    _loadMoreObserver.observe(sentinel);
  }
}

function loadMoreMarkets() {
  const listEl = document.getElementById('markets-list');
  const start = currentPage * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, filteredMarkets.length);
  if (start >= filteredMarkets.length) return;

  // Insert cards before footer
  const footer = listEl.querySelector('.markets-list-footer');
  const fragment = document.createDocumentFragment();
  for (let i = start; i < end; i++) {
    const { pubkey, account } = filteredMarkets[i];
    const positions = userPositionsMap.get(pubkey.toBase58()) || null;
    const card = ui.renderMarketCard(pubkey, account, positions);
    card.addEventListener('click', (e) => {
      if (e.target.closest('.watchlist-star')) return;
      openMarketDetail(pubkey);
    });
    fragment.appendChild(card);
  }
  listEl.insertBefore(fragment, footer);

  // Bind stars for new cards
  listEl.querySelectorAll('.watchlist-star:not([data-bound])').forEach(btn => {
    btn.dataset.bound = '1';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const addr = btn.dataset.addr;
      handleWatchlistStarClick(addr, (nowWatched) => {
        btn.textContent = nowWatched ? '★' : '☆';
        btn.classList.toggle('active', nowWatched);
      });
    });
  });

  currentPage++;
  appendListFooter(listEl, end, filteredMarkets.length);
}

function cleanupLoadMoreObserver() {
  if (_loadMoreObserver) {
    _loadMoreObserver.disconnect();
    _loadMoreObserver = null;
  }
}

// Explore chart toggle
document.getElementById('explore-chart-toggle')?.addEventListener('click', () => {
  const wrap = document.getElementById('explore-chart-wrap');
  const btn = document.getElementById('explore-chart-toggle');
  const isHidden = wrap.classList.toggle('hidden');
  btn.textContent = isHidden ? '▸ Show Hot Markets' : '▾ Hide Hot Markets';
  btn.classList.toggle('open', !isHidden);
  if (!isHidden && allMarkets.length > 0) {
    // Defer render so the container has dimensions after unhiding
    requestAnimationFrame(() => ui.renderVolumeChart(allMarkets, openMarketDetail));
  }
});

// Filters
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    renderMarketsList();
  });
});
document.getElementById('explore-sort-select')?.addEventListener('change', (e) => {
  currentSort = e.target.value;
  renderMarketsList();
});

// Creator filter
let _lastCreatorSet = '';
function populateCreatorFilter() {
  const sel = document.getElementById('explore-creator-filter');
  if (!sel) return;

  // Build unique creator list with short addresses
  const creators = new Map();
  for (const { account } of allMarkets) {
    const addr = account.authority.toBase58();
    if (!creators.has(addr)) {
      const short = addr.slice(0, 4) + '…' + addr.slice(-4);
      creators.set(addr, short);
    }
  }

  // Only rebuild if the set of creators changed
  const key = [...creators.keys()].sort().join(',');
  if (key === _lastCreatorSet) return;
  _lastCreatorSet = key;

  const prev = sel.value;
  sel.innerHTML = '<option value="all">All Creators</option>';
  for (const [addr, short] of creators) {
    const opt = document.createElement('option');
    opt.value = addr;
    opt.textContent = short;
    sel.appendChild(opt);
  }

  // Restore previous selection if still valid
  if (creators.has(prev)) sel.value = prev;
  else { sel.value = 'all'; currentCreatorFilter = 'all'; }

  // Resolve SNS names in background
  import('./sns.js').then(sns => {
    for (const [addr] of creators) {
      sns.resolveDisplayName(addr).then(name => {
        const opt = sel.querySelector(`option[value="${addr}"]`);
        if (opt) opt.textContent = name;
      });
    }
  });
}

document.getElementById('explore-creator-filter')?.addEventListener('change', (e) => {
  currentCreatorFilter = e.target.value;
  renderMarketsList();
});

// Category filter
let _lastCategorySet = '';
function populateCategoryFilter() {
  const sel = document.getElementById('explore-category-filter');
  if (!sel) return;

  const categories = new Map(); // category name → count
  let uncategorized = 0;
  for (const { account } of allMarkets) {
    const { category } = ui.parseDescription(account.description);
    if (category) {
      categories.set(category, (categories.get(category) || 0) + 1);
    } else {
      uncategorized++;
    }
  }

  const key = [...categories.keys()].sort().join(',') + '|' + uncategorized;
  if (key === _lastCategorySet) return;
  _lastCategorySet = key;

  const prev = sel.value;
  sel.innerHTML = '<option value="all">All Categories</option>';
  if (uncategorized > 0) {
    const opt = document.createElement('option');
    opt.value = '__none';
    opt.textContent = `Uncategorized (${uncategorized})`;
    sel.appendChild(opt);
  }
  const sorted = [...categories.entries()].sort((a, b) => b[1] - a[1]);
  for (const [cat, count] of sorted) {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = `${cat} (${count})`;
    sel.appendChild(opt);
  }

  if (prev === '__none' || categories.has(prev)) sel.value = prev;
  else { sel.value = 'all'; currentCategoryFilter = 'all'; }
}

document.getElementById('explore-category-filter')?.addEventListener('change', (e) => {
  currentCategoryFilter = e.target.value;
  renderMarketsList();
});

// Token chooser (custom HTML dropdown with icons)
const NATIVE_SOL_MINT = '11111111111111111111111111111111';
const SOL_ICON = 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png';
let _lastTokenSet = '';
let _tokenIconCache = new Map(); // mint → icon URL

/** Fetch token metadata via Helius DAS getAsset */
async function fetchTokenIcon(mint) {
  if (_tokenIconCache.has(mint)) return _tokenIconCache.get(mint);
  try {
    const resp = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getAsset',
        params: { id: mint },
      }),
    });
    if (resp.ok) {
      const { result } = await resp.json();
      if (result) {
        const content = result.content || {};
        const meta = content.metadata || {};
        const links = content.links || {};
        const icon = links.image || content.json_uri || '';
        const name = meta.name || '';
        const symbol = meta.symbol || '';
        _tokenIconCache.set(mint, { icon, name, symbol });
        return { icon, name, symbol };
      }
    }
  } catch {}
  _tokenIconCache.set(mint, { icon: '', name: '', symbol: '' });
  return { icon: '', name: '', symbol: '' };
}

// ── Token USD price cache (Jupiter Price API v3) ──────────────────
let _priceCache = new Map(); // mint → { price, ts }

/** Fetch USD prices for a list of mints via Jupiter lite API. Returns Map<mint, price>. */
async function fetchTokenPrices(mints) {
  if (mints.length === 0) return new Map();
  const now = Date.now();
  const stale = mints.filter(m => {
    const c = _priceCache.get(m);
    return !c || (now - c.ts > PRICE_CACHE_MS);
  });
  if (stale.length > 0) {
    try {
      const ids = stale.join(',');
      const resp = await fetch(`https://lite-api.jup.ag/price/v3?ids=${ids}`);
      if (resp.ok) {
        const data = await resp.json();
        for (const mint of stale) {
          const entry = data[mint];
          const price = entry?.usdPrice ? parseFloat(entry.usdPrice) : 0;
          _priceCache.set(mint, { price, ts: now });
        }
      }
    } catch (e) {
      console.warn('Jupiter price fetch failed:', e);
    }
  }
  const result = new Map();
  for (const m of mints) {
    result.set(m, _priceCache.get(m)?.price || 0);
  }
  return result;
}

/** Get cached USD price for a single mint. Returns 0 if not yet fetched. */
function getTokenPrice(mint) {
  return _priceCache.get(mint)?.price || 0;
}

function populateTokenFilter() {
  const dropdown = document.getElementById('token-chooser-dropdown');
  if (!dropdown) return;

  // Gather unique token mints from markets
  const tokens = new Map(); // mint address → { count, denomination, denominationName }
  for (const { account } of allMarkets) {
    const mint = account.denomination === 0 ? NATIVE_SOL_MINT : account.tokenMint.toBase58();
    if (!tokens.has(mint)) {
      tokens.set(mint, { count: 0, denomination: account.denomination, denominationName: account.denominationName, tokenDecimals: account.tokenDecimals });
    }
    tokens.get(mint).count++;
  }

  const key = [...tokens.keys()].sort().join(',');
  if (key === _lastTokenSet) return;
  _lastTokenSet = key;

  // Build dropdown items
  dropdown.innerHTML = '';

  // "All Tokens" option
  const allItem = document.createElement('div');
  allItem.className = `token-chooser-item${currentTokenFilter === 'all' ? ' active' : ''}`;
  allItem.dataset.mint = 'all';
  allItem.innerHTML = `<span class="token-chooser-label">All Tokens</span>`;
  dropdown.appendChild(allItem);

  // Native SOL
  if (tokens.has(NATIVE_SOL_MINT)) {
    const info = tokens.get(NATIVE_SOL_MINT);
    const item = document.createElement('div');
    item.className = `token-chooser-item${currentTokenFilter === NATIVE_SOL_MINT ? ' active' : ''}`;
    item.dataset.mint = NATIVE_SOL_MINT;
    item.innerHTML = `
      <img class="token-icon" src="${SOL_ICON}" alt="SOL" onerror="this.style.display='none'">
      <span class="token-chooser-label">SOL <span class="token-chooser-sub">Native</span></span>
      <span class="token-chooser-count">${info.count}</span>
    `;
    dropdown.appendChild(item);
    tokens.delete(NATIVE_SOL_MINT);
  }

  // SPL / Token-2022 tokens — fetch icons async
  const sorted = [...tokens.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [mint, info] of sorted) {
    const shortMint = mint.slice(0, 4) + '…' + mint.slice(-4);
    const typeLabel = info.denominationName === 'Token2022' ? 'Token-2022' : 'SPL';
    const item = document.createElement('div');
    item.className = `token-chooser-item${currentTokenFilter === mint ? ' active' : ''}`;
    item.dataset.mint = mint;
    item.innerHTML = `
      <img class="token-icon" src="" alt="" style="display:none">
      <span class="token-chooser-label">
        <span class="token-symbol-name">Loading…</span>
        <a class="token-mint-link" href="https://solscan.io/token/${mint}" target="_blank" rel="noopener" title="${mint}">${shortMint}</a>
        <span class="token-chooser-sub">${typeLabel}</span>
      </span>
      <span class="token-chooser-count">${info.count}</span>
    `;
    dropdown.appendChild(item);

    // Fetch icon async
    fetchTokenIcon(mint).then(({ icon, name, symbol }) => {
      const img = item.querySelector('.token-icon');
      const label = item.querySelector('.token-symbol-name');
      if (icon) { img.src = icon; img.style.display = ''; }
      label.textContent = symbol ? `${symbol}${name ? ' — ' + name : ''}` : shortMint;
    });
  }

  // Click handlers
  dropdown.querySelectorAll('.token-chooser-item').forEach(item => {
    item.addEventListener('click', (e) => {
      // Don't close dropdown if clicking the Solscan link
      if (e.target.closest('.token-mint-link')) return;
      e.stopPropagation();
      currentTokenFilter = item.dataset.mint;
      updateTokenChooserButton();
      dropdown.classList.add('hidden');
      document.querySelector('.token-chooser-backdrop')?.remove();
      _lastTokenSet = ''; // force re-render of active state
      populateTokenFilter();
      renderMarketsList();
    });
  });
}

function updateTokenChooserButton() {
  const btn = document.getElementById('token-chooser-btn');
  if (!btn) return;
  if (currentTokenFilter === 'all') {
    btn.textContent = 'All Tokens ▾';
    btn.classList.remove('token-active');
  } else if (currentTokenFilter === NATIVE_SOL_MINT) {
    btn.innerHTML = `<img class="token-icon-sm" src="${SOL_ICON}" alt="SOL"> SOL ▾`;
    btn.classList.add('token-active');
  } else {
    const cached = _tokenIconCache.get(currentTokenFilter);
    const short = currentTokenFilter.slice(0, 4) + '…' + currentTokenFilter.slice(-4);
    const label = cached?.symbol || short;
    if (cached?.icon) {
      btn.innerHTML = `<img class="token-icon-sm" src="${cached.icon}" alt="${label}"> ${label} ▾`;
    } else {
      btn.textContent = `${label} ▾`;
    }
    btn.classList.add('token-active');
  }
}

// Toggle dropdown with backdrop
document.getElementById('token-chooser-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const dd = document.getElementById('token-chooser-dropdown');
  const isHidden = dd.classList.toggle('hidden');
  // Manage backdrop
  let backdrop = document.querySelector('.token-chooser-backdrop');
  if (!isHidden) {
    // Move dropdown to body so it renders above everything
    if (dd.parentElement !== document.body) document.body.appendChild(dd);
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.className = 'token-chooser-backdrop';
      backdrop.addEventListener('click', () => {
        dd.classList.add('hidden');
        backdrop.remove();
      });
    }
    // Insert backdrop before dropdown so dropdown is on top
    document.body.insertBefore(backdrop, dd);
  } else if (backdrop) {
    backdrop.remove();
  }
});

// Close dropdown on outside click
document.addEventListener('click', () => {
  document.getElementById('token-chooser-dropdown')?.classList.add('hidden');
  document.querySelector('.token-chooser-backdrop')?.remove();
});

// Stop propagation inside dropdown
document.getElementById('token-chooser-dropdown')?.addEventListener('click', (e) => {
  e.stopPropagation();
});

// Positions category filter
function reRenderPositions() {
  const listEl = document.getElementById('positions-list');
  if (_positionEntries.length > 0) renderPositionsList(_positionEntries, listEl);
}
document.getElementById('positions-category-filter')?.addEventListener('change', (e) => {
  currentPositionsCategoryFilter = e.target.value;
  reRenderPositions();
});
document.getElementById('positions-status-filter')?.addEventListener('change', (e) => {
  currentPositionsStatusFilter = e.target.value;
  reRenderPositions();
});
document.getElementById('positions-result-filter')?.addEventListener('change', (e) => {
  currentPositionsResultFilter = e.target.value;
  reRenderPositions();
});
document.getElementById('positions-sort')?.addEventListener('change', (e) => {
  currentPositionsSort = e.target.value;
  reRenderPositions();
});

// ═══════════════════════════════════════════════════════════════════
// Market Detail
// ═══════════════════════════════════════════════════════════════════
async function openMarketDetail(pubkey) {
  currentMarketPubkey = pubkey;
  selectedOutcome = null;
  setHash(`#/market/${pubkey.toBase58()}`);
  switchView('market', { updateHash: false });
  const el = document.getElementById('market-detail');
  el.innerHTML = '<div class="loading-state"><div class="spinner"></div><span>Loading…</span></div>';
  try {
    const market = await sdk.fetchMarket(pubkey);
    if (!market) { el.innerHTML = '<div class="empty-state">Market not found.</div>'; return; }

    // Resolve token metadata
    if (market.denomination === 0) {
      market._tokenSymbol = 'SOL';
      market._tokenName = 'Solana';
      market._tokenIcon = SOL_ICON;
    } else {
      const mint = market.tokenMint.toBase58();
      const meta = await fetchTokenIcon(mint);
      market._tokenSymbol = meta.symbol || 'Token';
      market._tokenName = meta.name || mint.slice(0, 6) + '…';
      market._tokenIcon = meta.icon || '';
    }

    // Fetch USD price for chart display
    const priceMint = market.denomination === 0 ? SOL_MINT : market.tokenMint.toBase58();
    await fetchTokenPrices([priceMint]);
    // If Jupiter has no price for this token (e.g. devnet), assume $1 for SPL tokens
    const rawPrice = getTokenPrice(priceMint);
    const tokenUsdPrice = rawPrice || (market.denomination !== 0 ? 1 : 0);

    currentMarketData = market;
    const w = wallet.getWallet();
    const positions = userPositionsMap.get(pubkey.toBase58()) || null;
    el.innerHTML = ui.renderMarketDetail(pubkey, market, w?.publicKey, positions);
    // Charts render on demand via toggle
    attachDetailListeners(pubkey, market, tokenUsdPrice);
  } catch (err) {
    console.error(err);
    el.innerHTML = '<div class="empty-state">Failed to load market.</div>';
  }
}

function attachDetailListeners(pubkey, market, tokenUsdPrice = 0) {
  // Share
  document.getElementById('detail-share-btn')?.addEventListener('click', () => {
    const url = window.location.origin + window.location.pathname + '#/market/' + pubkey.toBase58();
    shareContent(market.title, market.title + ' — Pelfmont Markets', url);
  });
  // Copy
  document.querySelectorAll('.copy-btn[data-copy]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        btn.textContent = 'Copied!'; btn.classList.add('copied');
        setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
      } catch {}
    });
  });
  // Outcome selection
  document.querySelectorAll('.bet-outcome-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.bet-outcome-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedOutcome = parseInt(btn.dataset.outcome);
      updateBetUI();
    });
  });
  document.getElementById('bet-amount-input')?.addEventListener('input', updateBetUI);
  document.getElementById('place-bet-btn')?.addEventListener('click', handlePlaceBet);
  // Authority
  const w = wallet.getWallet();
  const isAuth = w && market.authority.toBase58() === w.publicKey.toBase58();
  const resolveBtn = document.getElementById('resolve-market-btn');
  const voidBtn = document.getElementById('void-market-btn');
  if (resolveBtn) { resolveBtn.disabled = !isAuth; voidBtn.disabled = !isAuth; }
  resolveBtn?.addEventListener('click', () => document.getElementById('resolve-outcome-select')?.classList.toggle('hidden'));
  document.getElementById('confirm-resolve-btn')?.addEventListener('click', handleResolve);
  voidBtn?.addEventListener('click', handleVoid);
  document.getElementById('finalize-market-btn')?.addEventListener('click', handleFinalize);

  // Watchlist detail button
  const wlBtn = document.getElementById('detail-watchlist-btn');
  wlBtn?.addEventListener('click', () => {
    const addr = wlBtn.dataset.addr;
    handleWatchlistStarClick(addr, (nowWatched) => {
      wlBtn.classList.toggle('active', nowWatched);
      wlBtn.innerHTML = `<span>${nowWatched ? '★' : '☆'}</span><span>${nowWatched ? 'Watching' : 'Add to Watchlist'}</span>`;
    });
  });

  // Detail charts — render immediately (visible by default)
  requestAnimationFrame(() => ui.renderDetailCharts(market, tokenUsdPrice));
  document.getElementById('detail-chart-toggle')?.addEventListener('click', () => {
    const wrap = document.getElementById('detail-charts-wrap');
    const btn = document.getElementById('detail-chart-toggle');
    const isHidden = wrap.classList.toggle('hidden');
    btn.textContent = isHidden ? '▸ Show Charts' : '▾ Hide Charts';
    btn.classList.toggle('open', !isHidden);
    if (!isHidden) {
      requestAnimationFrame(() => ui.renderDetailCharts(market, tokenUsdPrice));
    }
  });
}

function updateBetUI() {
  const btn = document.getElementById('place-bet-btn');
  if (!btn) return;
  const amount = parseFloat(document.getElementById('bet-amount-input')?.value);
  const w = wallet.getWallet();
  if (!w) { btn.textContent = 'Connect Wallet'; btn.disabled = true; }
  else if (selectedOutcome === null) { btn.textContent = 'Select an Outcome'; btn.disabled = true; }
  else if (!amount || amount <= 0) { btn.textContent = 'Enter Amount'; btn.disabled = true; }
  else { btn.textContent = 'Confirm Position'; btn.disabled = false; }
  // Payout estimate
  const est = document.getElementById('bet-payout-estimate');
  if (!est || !currentMarketData || selectedOutcome === null || !amount || amount <= 0) { est?.classList.add('hidden'); return; }
  const isSol = currentMarketData.denominationName === 'NativeSol';
  const decimals = isSol ? 9 : currentMarketData.tokenDecimals;
  const lam = BigInt(Math.round(amount * (10 ** decimals)));
  const newPool = currentMarketData.outcomePools[selectedOutcome] + lam;
  const newTotal = currentMarketData.totalPool + lam;
  const pay = sdk.calculatePayout(lam, newPool, newTotal, currentMarketData.feeBps);
  est.classList.remove('hidden');
  const v = est.querySelector('.bet-payout-value');
  const sym = currentMarketData._tokenSymbol || (isSol ? 'SOL' : 'tokens');
  let payStr = isSol ? ui.formatSol(pay) : ui.formatTokenAmount(pay, decimals) + ' ' + sym;
  // Append USD value
  const priceMint = isSol ? SOL_MINT : currentMarketData.tokenMint.toBase58();
  const tokenPrice = getTokenPrice(priceMint) || (!isSol ? 1 : 0);
  if (tokenPrice > 0) {
    const payTokens = Number(pay) / (10 ** decimals);
    const usd = payTokens * tokenPrice;
    payStr += ` ($${usd >= 1 ? usd.toFixed(2) : usd.toFixed(4)})`;
  }
  if (v) v.textContent = payStr;
}

async function handlePlaceBet() {
  const w = wallet.getWallet(); const p = wallet.getProvider();
  if (!w || !p || selectedOutcome === null || !currentMarketPubkey || !currentMarketData) return;
  const amount = parseFloat(document.getElementById('bet-amount-input').value);
  if (!amount || amount <= 0) return;
  try {
    ui.showTxOverlay('Building transaction…');
    const isSol = currentMarketData.denominationName === 'NativeSol';
    const decimals = isSol ? 9 : currentMarketData.tokenDecimals;
    const lam = BigInt(Math.round(amount * (10 ** decimals)));
    const [vault] = await sdk.findVault(currentMarketPubkey);
    const [position] = await sdk.findPosition(currentMarketPubkey, w.publicKey, selectedOutcome);
    const [protocolConfig] = await sdk.findProtocolConfig();

    const accounts = { market: currentMarketPubkey, vault, position, bettor: w.publicKey, protocolConfig };

    // For SPL/Token-2022 markets, add token accounts
    if (!isSol) {
      const tokenMint = currentMarketData.tokenMint;
      const tokenProgramId = currentMarketData.denomination === 1 ? sdk.TOKEN_PROGRAM_ID : sdk.TOKEN_2022_PROGRAM_ID;
      // Bettor's ATA for this token
      const [bettorAta] = sdk.getAssociatedTokenAddress(tokenMint, w.publicKey, tokenProgramId);

      accounts.bettorTokenAccount = bettorAta;
      accounts.tokenVault = vault; // Same PDA as SOL vault
      accounts.tokenMint = tokenMint;
      accounts.tokenProgram = tokenProgramId;
    }

    const ix = sdk.buildPlaceBet(accounts, { outcomeIndex: selectedOutcome, amount: lam });
    ui.updateTxOverlay('Please approve…');
    const sig = await sdk.signAndSend(ix, w.publicKey, p);
    ui.hideTxOverlay();
    ui.showStatus(`Position confirmed! ${sig.slice(0, 8)}…`, 'success');
    openMarketDetail(currentMarketPubkey);
  } catch (err) {
    ui.hideTxOverlay();
    ui.showStatus(err.message || 'Position failed', 'error');
  }
}

async function handleResolve() {
  const w = wallet.getWallet(); const p = wallet.getProvider();
  if (!w || !p || !currentMarketPubkey) return;
  const outcome = parseInt(document.getElementById('resolve-outcome-dropdown')?.value);
  try {
    ui.showTxOverlay('Resolving…');
    const ix = sdk.buildResolveMarket({ market: currentMarketPubkey, authority: w.publicKey }, { winningOutcome: outcome });
    ui.updateTxOverlay('Please approve…');
    await sdk.signAndSend(ix, w.publicKey, p, { skipEstimation: true, skipSimulation: true });
    ui.hideTxOverlay(); ui.showStatus('Market resolved!', 'success');
    openMarketDetail(currentMarketPubkey);
  } catch (err) { ui.hideTxOverlay(); ui.showStatus(err.message || 'Resolve failed', 'error'); }
}

async function handleVoid() {
  const w = wallet.getWallet(); const p = wallet.getProvider();
  if (!w || !p || !currentMarketPubkey) return;
  if (!confirm('Void this market? All positions refunded.')) return;
  try {
    ui.showTxOverlay('Voiding…');
    const ix = sdk.buildVoidMarket({ market: currentMarketPubkey, authority: w.publicKey });
    ui.updateTxOverlay('Please approve…');
    await sdk.signAndSend(ix, w.publicKey, p, { skipEstimation: true, skipSimulation: true });
    ui.hideTxOverlay(); ui.showStatus('Market voided.', 'success');
    openMarketDetail(currentMarketPubkey);
  } catch (err) { ui.hideTxOverlay(); ui.showStatus(err.message || 'Void failed', 'error'); }
}

async function handleFinalize() {
  const w = wallet.getWallet(); const p = wallet.getProvider();
  if (!w || !p || !currentMarketPubkey) return;
  try {
    ui.showTxOverlay('Finalizing…');
    const ix = sdk.buildFinalizeMarket(currentMarketPubkey);
    ui.updateTxOverlay('Please approve…');
    await sdk.signAndSend(ix, w.publicKey, p, { skipEstimation: true, skipSimulation: true });
    ui.hideTxOverlay(); ui.showStatus('Market finalized!', 'success');
    openMarketDetail(currentMarketPubkey);
  } catch (err) { ui.hideTxOverlay(); ui.showStatus(err.message || 'Finalize failed', 'error'); }
}

document.getElementById('back-to-explore')?.addEventListener('click', () => {
  currentMarketPubkey = null; currentMarketData = null;
  switchView('explore');
});

// ═══════════════════════════════════════════════════════════════════
// My Positions View
// ═══════════════════════════════════════════════════════════════════
let currentPositionsCategoryFilter = 'all';
let currentPositionsStatusFilter = 'all';
let currentPositionsResultFilter = 'all';
let currentPositionsSort = 'deadline-desc';

async function loadPositions() {
  const listEl = document.getElementById('positions-list');
  const w = wallet.getWallet();
  if (!w) {
    listEl.innerHTML = '<div class="empty-state">Connect your wallet to view positions.</div>';
    return;
  }
  listEl.innerHTML = '<div class="loading-state"><div class="spinner"></div><span>Loading…</span></div>';
  try {
    const positions = await sdk.fetchPositionsByOwner(w.publicKey);
    if (positions.length === 0) {
      listEl.innerHTML = '<div class="empty-state">No positions found. Choose a position to get started!</div>';
      return;
    }
    const marketAddrs = [...new Set(positions.map(p => p.account.market.toBase58()))];
    const marketMap = {};
    for (const addr of marketAddrs) {
      try { const mk = await sdk.fetchMarket(new PublicKey(addr)); if (mk) marketMap[addr] = mk; } catch {}
    }

    // Resolve token metadata for position markets
    const posMintSet = new Set();
    posMintSet.add(SOL_MINT);
    for (const mk of Object.values(marketMap)) {
      if (mk.denomination === 0) {
        mk._tokenSymbol = 'SOL';
        mk._tokenName = 'Solana';
        mk._tokenIcon = SOL_ICON;
      } else {
        const mint = mk.tokenMint.toBase58();
        posMintSet.add(mint);
        const meta = await fetchTokenIcon(mint);
        mk._tokenSymbol = meta.symbol || 'Token';
        mk._tokenName = meta.name || mint.slice(0, 6) + '…';
        mk._tokenIcon = meta.icon || '';
      }
    }
    // Fetch USD prices for position market tokens
    const posPrices = await fetchTokenPrices([...posMintSet]);
    const posSolPrice = posPrices.get(SOL_MINT) || 0;
    for (const mk of Object.values(marketMap)) {
      if (mk.denomination === 0) {
        mk._usdVolume = (Number(mk.totalPool) / 1e9) * posSolPrice;
      } else {
        const mint = mk.tokenMint.toBase58();
        const tokenPrice = posPrices.get(mint) || 0;
        const decimals = mk.tokenDecimals || 9;
        mk._usdVolume = (Number(mk.totalPool) / (10 ** decimals)) * (tokenPrice || 1);
      }
    }

    // Build position entries with market data attached
    const entries = positions.map(({ pubkey: posPk, account: pos }) => {
      const mk = marketMap[pos.market.toBase58()] || null;
      const { category } = mk ? ui.parseDescription(mk.description) : { category: null };
      const deadline = mk ? mk.resolutionDeadline : 0n;
      const status = mk ? mk.status : -1;
      const claimed = pos.claimed;

      // Compute payout estimate for sorting
      let payout = 0n;
      let isWinning = false;
      let isLosing = false;
      if (mk && !claimed) {
        const pool = mk.outcomePools[pos.outcomeIndex];
        if (mk.status < 2 && pool > 0n && mk.totalPool > 0n) {
          const gross = (BigInt(pos.amount) * mk.totalPool) / pool;
          const fee = (gross * BigInt(mk.feeBps)) / 10000n;
          payout = gross - fee;
        } else if (mk.status === 2 && mk.winningOutcome === pos.outcomeIndex) {
          isWinning = true;
          const winPool = mk.outcomePools[mk.winningOutcome];
          if (winPool > 0n) {
            const gross = (BigInt(pos.amount) * mk.totalPool) / winPool;
            const fee = (gross * BigInt(mk.feeBps)) / 10000n;
            payout = gross - fee;
          }
        } else if (mk.status === 2 && mk.winningOutcome !== pos.outcomeIndex) {
          isLosing = true;
        }
      }

      return { posPk, pos, mk, market: pos.market, category, deadline, status, claimed, payout, isWinning, isLosing, amount: pos.amount };
    });

    // Populate category filter dropdown
    const categories = [...new Set(entries.map(e => e.category).filter(Boolean))].sort();
    const filterEl = document.getElementById('positions-category-filter');
    if (filterEl) {
      const prev = filterEl.value;
      filterEl.innerHTML = '<option value="all">All Categories</option>'
        + categories.map(c => `<option value="${c}">${c}</option>`).join('');
      if (prev && [...filterEl.options].some(o => o.value === prev)) filterEl.value = prev;
      else { filterEl.value = 'all'; currentPositionsCategoryFilter = 'all'; }
    }

    renderPositionsList(entries, listEl);
    _positionEntries = entries;
  } catch (err) {
    console.error(err);
    listEl.innerHTML = '<div class="empty-state">Failed to load positions.</div>';
  }
}

function renderPositionsList(entries, listEl) {
  let filtered = entries;

  // Category filter
  if (currentPositionsCategoryFilter !== 'all') {
    filtered = filtered.filter(e =>
      currentPositionsCategoryFilter === '__none' ? !e.category : e.category === currentPositionsCategoryFilter
    );
  }

  // Status filter
  if (currentPositionsStatusFilter !== 'all') {
    const statusVal = parseInt(currentPositionsStatusFilter);
    filtered = filtered.filter(e => e.status === statusVal);
  }

  // Result filter
  if (currentPositionsResultFilter === 'unclaimed') {
    filtered = filtered.filter(e => !e.claimed);
  } else if (currentPositionsResultFilter === 'claimed') {
    filtered = filtered.filter(e => e.claimed);
  } else if (currentPositionsResultFilter === 'winning') {
    filtered = filtered.filter(e => e.isWinning);
  } else if (currentPositionsResultFilter === 'losing') {
    filtered = filtered.filter(e => e.isLosing);
  }

  // Sort
  switch (currentPositionsSort) {
    case 'deadline-desc':
      filtered.sort((a, b) => Number(b.deadline - a.deadline));
      break;
    case 'deadline-asc':
      filtered.sort((a, b) => Number(a.deadline - b.deadline));
      break;
    case 'amount-desc':
      filtered.sort((a, b) => Number(b.amount - a.amount));
      break;
    case 'amount-asc':
      filtered.sort((a, b) => Number(a.amount - b.amount));
      break;
    case 'payout-desc':
      filtered.sort((a, b) => Number(b.payout - a.payout));
      break;
    case 'payout-asc':
      filtered.sort((a, b) => Number(a.payout - b.payout));
      break;
    case 'status':
      filtered.sort((a, b) => a.status - b.status || Number(b.deadline - a.deadline));
      break;
  }

  if (filtered.length === 0) {
    listEl.innerHTML = '<div class="empty-state">No positions match the selected filters.</div>';
    return;
  }

  listEl.innerHTML = '';
  for (const { posPk, pos, mk, market } of filtered) {
    const card = ui.renderPositionCard(posPk, pos, mk, market);
    listEl.appendChild(card);
  }

  // Claim listeners
  document.querySelectorAll('.claim-winnings-btn').forEach(btn => {
    btn.addEventListener('click', () => claimWinnings(btn.dataset.position, btn.dataset.market));
  });
  document.querySelectorAll('.claim-refund-btn').forEach(btn => {
    btn.addEventListener('click', () => claimRefund(btn.dataset.position, btn.dataset.market));
  });
  document.querySelectorAll('.position-market-title[data-market-pubkey]').forEach(el => {
    el.addEventListener('click', () => openMarketDetail(new PublicKey(el.dataset.marketPubkey)));
  });
}

// Positions category filter — store entries globally for re-render
let _positionEntries = [];

// We handle re-render in the filter handler instead

async function claimWinnings(posAddr, mktAddr) {
  const w = wallet.getWallet(); const p = wallet.getProvider();
  if (!w || !p) return;
  try {
    ui.showTxOverlay('Claiming winnings…');
    const mk = new PublicKey(mktAddr);
    const [vault] = await sdk.findVault(mk);
    const [pc] = await sdk.findProtocolConfig();
    const config = await sdk.fetchProtocolConfig();
    if (!config) throw new Error('Protocol config not found');
    const market = await sdk.fetchMarket(mk);
    if (!market) throw new Error('Market not found');

    const accounts = {
      market: mk, vault, position: new PublicKey(posAddr),
      claimant: w.publicKey, protocolConfig: pc, treasury: config.treasury,
      creator: market.creator,
    };

    // For SPL/Token-2022 markets, add token accounts
    if (market.denomination !== 0) {
      const tokenMint = market.tokenMint;
      const tokenProgramId = market.denomination === 1 ? sdk.TOKEN_PROGRAM_ID : sdk.TOKEN_2022_PROGRAM_ID;
      const [vaultAuthority] = await sdk.findVaultAuthority(mk);
      const [claimantAta] = sdk.getAssociatedTokenAddress(tokenMint, w.publicKey, tokenProgramId);
      const [treasuryAta] = sdk.getAssociatedTokenAddress(tokenMint, config.treasury, tokenProgramId);
      const [creatorAta] = sdk.getAssociatedTokenAddress(tokenMint, market.creator, tokenProgramId);

      accounts.claimantTokenAccount = claimantAta;
      accounts.treasuryTokenAccount = treasuryAta;
      accounts.creatorTokenAccount = creatorAta;
      accounts.tokenVault = vault;
      accounts.vaultAuthority = vaultAuthority;
      accounts.tokenMint = tokenMint;
      accounts.tokenProgram = tokenProgramId;
    }

    const ix = sdk.buildClaimWinnings(accounts);
    ui.updateTxOverlay('Please approve…');
    await sdk.signAndSend(ix, w.publicKey, p);
    ui.hideTxOverlay(); ui.showStatus('Winnings claimed!', 'success');
    loadPositions();
  } catch (err) { ui.hideTxOverlay(); ui.showStatus(err.message || 'Claim failed', 'error'); }
}

async function claimRefund(posAddr, mktAddr) {
  const w = wallet.getWallet(); const p = wallet.getProvider();
  if (!w || !p) return;
  try {
    ui.showTxOverlay('Claiming refund…');
    const mk = new PublicKey(mktAddr);
    const [vault] = await sdk.findVault(mk);
    const market = await sdk.fetchMarket(mk);
    if (!market) throw new Error('Market not found');

    const accounts = { market: mk, vault, position: new PublicKey(posAddr), claimant: w.publicKey };

    // For SPL/Token-2022 markets, add token accounts
    if (market.denomination !== 0) {
      const tokenMint = market.tokenMint;
      const tokenProgramId = market.denomination === 1 ? sdk.TOKEN_PROGRAM_ID : sdk.TOKEN_2022_PROGRAM_ID;
      const [vaultAuthority] = await sdk.findVaultAuthority(mk);
      const [claimantAta] = sdk.getAssociatedTokenAddress(tokenMint, w.publicKey, tokenProgramId);

      accounts.claimantTokenAccount = claimantAta;
      accounts.tokenVault = vault;
      accounts.vaultAuthority = vaultAuthority;
      accounts.tokenMint = tokenMint;
      accounts.tokenProgram = tokenProgramId;
    }

    const ix = sdk.buildClaimRefund(accounts);
    ui.updateTxOverlay('Please approve…');
    await sdk.signAndSend(ix, w.publicKey, p);
    ui.hideTxOverlay(); ui.showStatus('Refund claimed!', 'success');
    loadPositions();
  } catch (err) { ui.hideTxOverlay(); ui.showStatus(err.message || 'Refund failed', 'error'); }
}

// ═══════════════════════════════════════════════════════════════════
// Create Market View
// ═══════════════════════════════════════════════════════════════════
function updateCreateForm() {
  const btn = document.getElementById('create-market-btn');
  const w = wallet.getWallet();
  btn.textContent = w ? 'Create Market' : 'Connect Wallet to Create';
  btn.disabled = !w;
}

function showCreateError(msg) {
  const el = document.getElementById('create-status');
  el.innerHTML = `<span class="status-msg">${msg}</span><button class="status-dismiss" aria-label="Dismiss">&times;</button>`;
  el.className = 'form-status error'; el.classList.remove('hidden');
  el.querySelector('.status-dismiss').addEventListener('click', () => el.classList.add('hidden'));
}

document.getElementById('add-outcome-btn')?.addEventListener('click', addOutcomeRow);

function addOutcomeRow() {
  const c = document.getElementById('outcomes-container');
  const n = c.querySelectorAll('.outcome-row').length;
  if (n >= 10) return;
  const row = document.createElement('div');
  row.className = 'outcome-row';
  row.innerHTML = `
    <input type="text" class="form-input outcome-input" placeholder="Outcome ${n + 1}" maxlength="64" data-index="${n}">
    <button type="button" class="outcome-remove-btn" title="Remove outcome">×</button>
  `;
  row.querySelector('.outcome-remove-btn').addEventListener('click', () => removeOutcomeRow(row));
  c.appendChild(row);
  if (n + 1 >= 10) document.getElementById('add-outcome-btn').style.display = 'none';
  else document.getElementById('add-outcome-btn').style.display = '';
}

function removeOutcomeRow(row) {
  const c = document.getElementById('outcomes-container');
  const count = c.querySelectorAll('.outcome-row').length;
  if (count <= 2) return; // minimum 2 outcomes
  row.remove();
  // Re-index placeholders
  c.querySelectorAll('.outcome-row').forEach((r, i) => {
    const inp = r.querySelector('.outcome-input');
    inp.dataset.index = i;
    inp.placeholder = `Outcome ${i + 1}`;
  });
  document.getElementById('add-outcome-btn').style.display = '';
}

// Attach remove buttons on the initial two rows (they don't have remove buttons by default)
// We'll add them dynamically only when there are more than 2 rows, handled by addOutcomeRow

document.getElementById('create-denomination')?.addEventListener('change', (e) => {
  document.getElementById('token-fields')?.classList.toggle('hidden', e.target.value === '0');
  if (e.target.value === '0') {
    showSolPreview();
  } else {
    // If there's already a mint entered, preview it; otherwise show placeholder
    const mint = document.getElementById('create-token-mint')?.value.trim();
    if (mint && mint.length >= 32) {
      previewTokenMint(mint);
    } else {
      showTokenPreviewPlaceholder();
    }
  }
});

// Token preview helpers
const SOL_WRAPPED_MINT = 'So11111111111111111111111111111111111111112';

function showSolPreview() {
  const icon = document.getElementById('token-preview-icon');
  const symbol = document.getElementById('token-preview-symbol');
  const fullname = document.getElementById('token-preview-fullname');
  const link = document.getElementById('token-preview-link');
  const loader = document.getElementById('token-preview-loader');
  clearIconFallback();
  icon.onerror = null;
  icon.src = SOL_ICON;
  icon.alt = 'SOL';
  icon.style.display = '';
  symbol.textContent = 'SOL';
  fullname.textContent = 'Solana';
  link.href = `https://solscan.io/token/${SOL_WRAPPED_MINT}`;
  link.textContent = SOL_WRAPPED_MINT.slice(0, 5) + '…' + SOL_WRAPPED_MINT.slice(-4);
  loader.classList.add('hidden');
}

function showTokenPreviewPlaceholder() {
  const icon = document.getElementById('token-preview-icon');
  const symbol = document.getElementById('token-preview-symbol');
  const fullname = document.getElementById('token-preview-fullname');
  const link = document.getElementById('token-preview-link');
  const loader = document.getElementById('token-preview-loader');
  clearIconFallback();
  icon.onerror = null;
  icon.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  icon.alt = '';
  icon.style.display = 'none';
  symbol.textContent = 'Enter mint address';
  fullname.textContent = '';
  link.href = '#';
  link.textContent = '';
  loader.classList.add('hidden');
}

let _previewDebounce = null;

function showIconFallback(letter) {
  const icon = document.getElementById('token-preview-icon');
  icon.style.display = 'none';
  // Remove any existing fallback
  icon.parentElement.querySelector('.token-preview-fallback')?.remove();
  const fb = document.createElement('div');
  fb.className = 'token-preview-fallback';
  fb.textContent = letter;
  icon.parentElement.insertBefore(fb, icon);
}

function clearIconFallback() {
  const icon = document.getElementById('token-preview-icon');
  icon.parentElement.querySelector('.token-preview-fallback')?.remove();
}

function previewTokenMint(mint) {
  const icon = document.getElementById('token-preview-icon');
  const symbol = document.getElementById('token-preview-symbol');
  const fullname = document.getElementById('token-preview-fullname');
  const link = document.getElementById('token-preview-link');
  const loader = document.getElementById('token-preview-loader');

  // Show loader
  loader.classList.remove('hidden');
  symbol.textContent = 'Loading…';
  fullname.textContent = '';
  icon.style.display = 'none';
  clearIconFallback();

  const shortMint = mint.slice(0, 5) + '…' + mint.slice(-4);
  link.href = `https://solscan.io/token/${mint}`;
  link.textContent = shortMint;

  fetchTokenIcon(mint).then(({ icon: iconUrl, name, symbol: sym }) => {
    loader.classList.add('hidden');
    symbol.textContent = sym || shortMint;
    fullname.textContent = name || '';

    const letter = (sym || mint)[0].toUpperCase();

    if (iconUrl) {
      icon.onerror = () => {
        icon.onerror = null;
        icon.style.display = 'none';
        showIconFallback(letter);
      };
      icon.src = iconUrl;
      icon.alt = sym || mint;
      icon.style.display = '';
    } else {
      showIconFallback(letter);
    }
  }).catch(() => {
    loader.classList.add('hidden');
    symbol.textContent = shortMint;
    fullname.textContent = '';
    showIconFallback(mint[0].toUpperCase());
  });
}

document.getElementById('create-token-mint')?.addEventListener('input', (e) => {
  clearTimeout(_previewDebounce);
  const val = e.target.value.trim();
  if (!val || val.length < 32) {
    showTokenPreviewPlaceholder();
    return;
  }
  // Show loading immediately
  document.getElementById('token-preview-loader')?.classList.remove('hidden');
  document.getElementById('token-preview-symbol').textContent = 'Loading…';
  _previewDebounce = setTimeout(() => previewTokenMint(val), 500);
});

// Initialize with SOL preview on page load
showSolPreview?.();

document.getElementById('create-title')?.addEventListener('input', (e) => {
  document.getElementById('create-title-count').textContent = new TextEncoder().encode(e.target.value).length;
});
document.getElementById('create-description')?.addEventListener('input', (e) => {
  document.getElementById('create-desc-count').textContent = new TextEncoder().encode(e.target.value).length;
});

document.getElementById('create-market-btn')?.addEventListener('click', handleCreateMarket);

async function handleCreateMarket() {
  const w = wallet.getWallet(); const p = wallet.getProvider();
  if (!w || !p) return;
  const title = document.getElementById('create-title').value.trim();
  const category = document.getElementById('create-category').value.trim();
  const rawDescription = document.getElementById('create-description').value.trim();
  const description = ui.encodeDescription(category, rawDescription);
  const deadlineInput = document.getElementById('create-deadline').value;
  const feeInput = document.getElementById('create-fee').value;
  const denomination = parseInt(document.getElementById('create-denomination').value);
  const outcomeLabels = [];
  document.querySelectorAll('.outcome-input').forEach(inp => {
    const v = inp.value.trim(); if (v) outcomeLabels.push(v);
  });
  if (!title) return showCreateError('Title is required');
  if (outcomeLabels.length < 2) return showCreateError('At least 2 outcomes required');
  if (!deadlineInput) return showCreateError('Deadline is required');
  const deadline = BigInt(Math.floor(new Date(deadlineInput).getTime() / 1000));
  if (deadline <= BigInt(Math.floor(Date.now() / 1000))) return showCreateError('Deadline must be in the future');
  const creatorFee = feeInput ? parseInt(feeInput) : 0;
  if (creatorFee < 0 || creatorFee > 500) return showCreateError('Creator fee must be 0–500 bps');

  try {
    ui.showTxOverlay('Creating market…');
    const config = await sdk.fetchProtocolConfig();
    const marketId = config ? config.totalMarketsCreated + 1n : 1n;
    // Total fee = protocol default + creator's additional fee
    const feeBpsOverride = creatorFee > 0 && config
      ? config.defaultFeeBps + creatorFee
      : null;
    const [market] = await sdk.findMarket(w.publicKey, marketId);
    const [vault] = await sdk.findVault(market);
    const [protocolConfig] = await sdk.findProtocolConfig();

    const accounts = { market, vault, authority: w.publicKey, payer: w.publicKey, protocolConfig };
    const ixList = [];

    // For SPL/Token-2022 markets, pass token accounts
    // The program creates and initializes the token vault itself via CPI
    // tokenVault uses the SAME PDA as vault: [VAULT_SEED, market]
    if (denomination === 1 || denomination === 2) {
      const mintAddr = document.getElementById('create-token-mint')?.value.trim();
      if (!mintAddr || mintAddr.length < 32) return showCreateError('Token mint address is required');
      const tokenMint = new PublicKey(mintAddr);
      const tokenProgramId = denomination === 1 ? sdk.TOKEN_PROGRAM_ID : sdk.TOKEN_2022_PROGRAM_ID;
      const [vaultAuthority] = await sdk.findVaultAuthority(market);

      accounts.tokenMint = tokenMint;
      accounts.vaultAuthority = vaultAuthority;
      accounts.tokenVault = vault; // Same PDA as vault — program creates it as a token account
      accounts.tokenProgram = tokenProgramId;
    }

    const createIx = sdk.buildCreateMarket(
      accounts,
      { marketId, title, description, outcomeLabels, resolutionDeadline: deadline, feeBpsOverride, denomination, authorityIsMultisig: false }
    );
    ixList.push(createIx);

    ui.updateTxOverlay('Please approve…');
    const sig = await sdk.signAndSend(ixList, w.publicKey, p);
    ui.hideTxOverlay();
    ui.showStatus(`Market created! ${sig.slice(0, 8)}…`, 'success');
    // Reset form
    document.getElementById('create-title').value = '';
    document.getElementById('create-category').value = '';
    document.getElementById('create-description').value = '';
    document.getElementById('create-deadline').value = '';
    document.getElementById('create-fee').value = '';
    document.getElementById('create-title-count').textContent = '0';
    document.getElementById('create-desc-count').textContent = '0';
    const el = document.getElementById('create-status');
    el.innerHTML = `<span class="status-msg">Market created: ${market.toBase58()}</span><button class="status-dismiss" aria-label="Dismiss">&times;</button>`;
    el.className = 'form-status success'; el.classList.remove('hidden');
    el.querySelector('.status-dismiss').addEventListener('click', () => el.classList.add('hidden'));
  } catch (err) {
    ui.hideTxOverlay();
    showCreateError(err.message || 'Failed to create market');
  }
}

// ═══════════════════════════════════════════════════════════════════
// Admin View
// ═══════════════════════════════════════════════════════════════════
async function loadAdmin() {
  const initPanel = document.getElementById('admin-init-panel');
  const statsPanel = document.getElementById('admin-panel');
  const updatePanel = document.getElementById('admin-update-panel');
  const initBtn = document.getElementById('init-protocol-btn');
  const w = wallet.getWallet();

  try {
    const config = await sdk.fetchProtocolConfig();
    if (!config) {
      // Not initialized — show init form
      initPanel.classList.remove('hidden');
      updatePanel.classList.add('hidden');
      statsPanel.innerHTML = '<div class="empty-state">Protocol not initialized yet.</div>';
      if (w) {
        initBtn.textContent = 'Initialize Protocol';
        initBtn.disabled = false;
        // Default treasury to connected wallet
        const treasuryInput = document.getElementById('init-treasury');
        if (!treasuryInput.value) treasuryInput.placeholder = w.publicKey.toBase58() + ' (your wallet)';
      } else {
        initBtn.textContent = 'Connect Wallet to Initialize';
        initBtn.disabled = true;
      }
      return;
    }

    // Initialized — hide init form, show stats
    initPanel.classList.add('hidden');
    document.getElementById('admin-total-markets').textContent = Number(config.totalMarketsCreated);
    document.getElementById('admin-total-volume').textContent = ui.formatSol(config.totalVolume);
    document.getElementById('admin-default-fee').textContent = `${config.defaultFeeBps / 100}%`;
    document.getElementById('admin-paused').textContent = config.paused ? 'Yes' : 'No';
    document.getElementById('admin-treasury').textContent = config.treasury.toBase58();

    // Show update panel only if connected wallet is the admin
    const isAdmin = w && config.admin.toBase58() === w.publicKey.toBase58();
    if (isAdmin) {
      updatePanel.classList.remove('hidden');
      // Set toggle pause button state
      const pauseBtn = document.getElementById('admin-toggle-pause-btn');
      pauseBtn.textContent = config.paused ? 'Unpause Protocol' : 'Pause Protocol';
      pauseBtn.className = config.paused
        ? 'action-btn primary-btn'
        : 'action-btn danger-btn';
      // Pre-fill fee input with current value
      const feeInput = document.getElementById('admin-update-fee');
      feeInput.placeholder = String(config.defaultFeeBps);
      // Pre-fill treasury input with current address
      const treasuryInput = document.getElementById('admin-update-treasury');
      treasuryInput.placeholder = config.treasury.toBase58();
    } else {
      updatePanel.classList.add('hidden');
    }
  } catch (err) {
    console.error('Admin load error:', err);
  }
}

// Initialize protocol handler
document.getElementById('init-protocol-btn')?.addEventListener('click', handleInitProtocol);

// Toggle pause handler
document.getElementById('admin-toggle-pause-btn')?.addEventListener('click', async () => {
  const w = wallet.getWallet();
  const p = wallet.getProvider();
  if (!w || !p) return;

  try {
    const config = await sdk.fetchProtocolConfig();
    if (!config) return;
    const newPaused = !config.paused;
    ui.showTxOverlay(newPaused ? 'Pausing protocol…' : 'Unpausing protocol…');
    const [protocolConfig] = await sdk.findProtocolConfig();

    // Diagnostic: log raw account data
    const conn = sdk.getConnection();
    const acctInfo = await conn.getAccountInfo(protocolConfig);
    if (acctInfo) {
      console.log('ProtocolConfig account size:', acctInfo.data.length, 'bytes');
      console.log('ProtocolConfig owner:', acctInfo.owner.toBase58());
      console.log('ProtocolConfig first 32 bytes:', Buffer.from(acctInfo.data.slice(0, 32)).toString('hex'));
    }

    const ix = sdk.buildUpdateProtocolConfig(
      { protocolConfig, admin: w.publicKey },
      { paused: newPaused }
    );
    console.log('UpdateProtocolConfig IX data:', Buffer.from(ix.data).toString('hex'));
    console.log('UpdateProtocolConfig IX keys:');
    ix.keys.forEach((k, i) => console.log(`  [${i}] ${k.pubkey.toBase58()} signer=${k.isSigner} writable=${k.isWritable}`));

    ui.updateTxOverlay('Please approve…');
    await sdk.signAndSend(ix, w.publicKey, p, { skipEstimation: true, skipSimulation: true });
    ui.hideTxOverlay();
    ui.showStatus(newPaused ? 'Protocol paused' : 'Protocol unpaused', 'success');
    loadAdmin();
  } catch (err) {
    ui.hideTxOverlay();
    ui.showStatus(err.message || 'Failed to update', 'error');
  }
});

// Update fee handler
document.getElementById('admin-update-fee-btn')?.addEventListener('click', async () => {
  const w = wallet.getWallet();
  const p = wallet.getProvider();
  if (!w || !p) return;

  const feeInput = document.getElementById('admin-update-fee');
  const feeBps = parseInt(feeInput.value);
  if (isNaN(feeBps) || feeBps < 0 || feeBps > 10000) {
    ui.showStatus('Fee must be 0–10000 bps', 'error');
    return;
  }

  try {
    ui.showTxOverlay('Updating default fee…');
    const [protocolConfig] = await sdk.findProtocolConfig();
    const ix = sdk.buildUpdateProtocolConfig(
      { protocolConfig, admin: w.publicKey },
      { newDefaultFeeBps: feeBps }
    );
    ui.updateTxOverlay('Please approve…');
    await sdk.signAndSend(ix, w.publicKey, p, { skipEstimation: true, skipSimulation: true });
    ui.hideTxOverlay();
    ui.showStatus(`Default fee updated to ${feeBps / 100}%`, 'success');
    feeInput.value = '';
    loadAdmin();
  } catch (err) {
    ui.hideTxOverlay();
    ui.showStatus(err.message || 'Failed to update fee', 'error');
  }
});

// Update treasury handler
document.getElementById('admin-update-treasury-btn')?.addEventListener('click', async () => {
  const w = wallet.getWallet();
  const p = wallet.getProvider();
  if (!w || !p) return;

  const input = document.getElementById('admin-update-treasury').value.trim();
  if (!input) {
    ui.showStatus('Enter a treasury address', 'error');
    return;
  }

  let newTreasury;
  try { newTreasury = new PublicKey(input); }
  catch {
    ui.showStatus('Invalid treasury address', 'error');
    return;
  }

  try {
    ui.showTxOverlay('Updating treasury…');
    const [protocolConfig] = await sdk.findProtocolConfig();
    const ix = sdk.buildUpdateProtocolConfig(
      { protocolConfig, admin: w.publicKey },
      { newTreasury }
    );
    ui.updateTxOverlay('Please approve…');
    await sdk.signAndSend(ix, w.publicKey, p, { skipEstimation: true, skipSimulation: true });
    ui.hideTxOverlay();
    ui.showStatus('Treasury updated', 'success');
    document.getElementById('admin-update-treasury').value = '';
    loadAdmin();
  } catch (err) {
    ui.hideTxOverlay();
    ui.showStatus(err.message || 'Failed to update treasury', 'error');
  }
});

async function handleInitProtocol() {
  const w = wallet.getWallet();
  const p = wallet.getProvider();
  if (!w || !p) return;

  const treasuryInput = document.getElementById('init-treasury').value.trim();
  const feeBpsInput = document.getElementById('init-fee-bps').value;
  const statusEl = document.getElementById('init-status');

  let treasury;
  if (treasuryInput) {
    try { treasury = new PublicKey(treasuryInput); }
    catch {
      statusEl.textContent = 'Invalid treasury address'; statusEl.className = 'form-status error'; statusEl.classList.remove('hidden');
      return;
    }
  } else {
    treasury = w.publicKey;
  }

  const feeBps = feeBpsInput ? parseInt(feeBpsInput) : 200;
  if (isNaN(feeBps) || feeBps < 0 || feeBps > 10000) {
    statusEl.textContent = 'Fee must be 0–10000 bps'; statusEl.className = 'form-status error'; statusEl.classList.remove('hidden');
    return;
  }

  try {
    ui.showTxOverlay('Initializing protocol…');
    const [protocolConfig] = await sdk.findProtocolConfig();
    const ix = sdk.buildInitializeProtocol(
      { protocolConfig, admin: w.publicKey, treasury },
      { defaultFeeBps: feeBps }
    );
    ui.updateTxOverlay('Please approve…');
    const sig = await sdk.signAndSend(ix, w.publicKey, p);
    ui.hideTxOverlay();
    ui.showStatus(`Protocol initialized! ${sig.slice(0, 8)}…`, 'success');
    statusEl.textContent = 'Protocol initialized successfully!';
    statusEl.className = 'form-status success';
    statusEl.classList.remove('hidden');
    // Reload admin view to show stats
    loadAdmin();
  } catch (err) {
    ui.hideTxOverlay();
    statusEl.textContent = err.message || 'Initialization failed';
    statusEl.className = 'form-status error';
    statusEl.classList.remove('hidden');
  }
}

// Footer admin link
document.querySelector('.footer-admin-link')?.addEventListener('click', () => switchView('admin'));

// ═══════════════════════════════════════════════════════════════════
// Share
// ═══════════════════════════════════════════════════════════════════

async function shareContent(title, text, url) {
  if (navigator.share) {
    try {
      await navigator.share({ title, text, url });
    } catch (err) {
      if (err.name !== 'AbortError') {
        fallbackCopy(url);
      }
    }
  } else {
    fallbackCopy(url);
  }
}

function fallbackCopy(text) {
  navigator.clipboard?.writeText(text).then(() => {
    ui.showStatus('Link copied to clipboard', 'success');
  }).catch(() => {
    ui.showStatus('Could not copy link', 'error');
  });
}

// Nav bar share — shares current page URL
document.getElementById('nav-share-btn')?.addEventListener('click', () => {
  const url = window.location.href;
  const hash = window.location.hash;
  let title = 'Pelfmont Markets';
  let text = 'Check out Pelfmont Markets';
  if (hash.startsWith('#/market/') && currentMarketData) {
    title = currentMarketData.title;
    text = currentMarketData.title + ' — Pelfmont Markets';
  }
  shareContent(title, text, url);
});

// Detail share — wired up in attachDetailListeners

// ═══════════════════════════════════════════════════════════════════
// Watchlist View
// ═══════════════════════════════════════════════════════════════════
let watchlistCategoryFilter = 'all';

function renderCategoryTabs() {
  const container = document.getElementById('watchlist-category-tabs');
  if (!container) return;
  const categories = watchlist.getCategories();
  const meta = watchlist.getAllWithMeta();

  // Count per category
  const counts = { all: Object.keys(meta).length, __uncategorized: 0 };
  for (const cat of categories) counts[cat] = 0;
  for (const [, m] of Object.entries(meta)) {
    if (!m.category) counts.__uncategorized++;
    else if (counts[m.category] !== undefined) counts[m.category]++;
  }

  container.innerHTML = `
    <button class="category-tab ${watchlistCategoryFilter === 'all' ? 'active' : ''}" data-category="all">All (${counts.all})</button>
    <button class="category-tab ${watchlistCategoryFilter === '__uncategorized' ? 'active' : ''}" data-category="__uncategorized">Uncategorized (${counts.__uncategorized})</button>
    ${categories.map(cat => `
      <button class="category-tab ${watchlistCategoryFilter === cat ? 'active' : ''}" data-category="${cat}">${cat} (${counts[cat] || 0})</button>
    `).join('')}
  `;

  container.querySelectorAll('.category-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      watchlistCategoryFilter = tab.dataset.category;
      renderCategoryTabs();
      loadWatchlist();
    });
  });
}

function renderCategoryManager() {
  const list = document.getElementById('category-list');
  if (!list) return;
  const categories = watchlist.getCategories();
  const meta = watchlist.getAllWithMeta();

  list.innerHTML = categories.map(cat => {
    const count = Object.values(meta).filter(m => m.category === cat).length;
    return `
      <div class="category-item" data-cat="${cat}">
        <span class="category-item-name">${cat}</span>
        <span class="category-item-count">${count} market${count !== 1 ? 's' : ''}</span>
        <button class="category-item-btn rename-cat-btn" title="Rename">✎</button>
        <button class="category-item-btn danger remove-cat-btn" title="Delete">×</button>
      </div>
    `;
  }).join('');

  if (categories.length === 0) {
    list.innerHTML = '<div style="font-size:0.82rem;color:var(--text-muted);padding:8px 0">No categories yet.</div>';
  }

  // Rename handlers
  list.querySelectorAll('.rename-cat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.category-item');
      const oldName = item.dataset.cat;
      const newName = prompt(`Rename "${oldName}" to:`, oldName);
      if (newName && newName.trim() && newName.trim() !== oldName) {
        watchlist.renameCategory(oldName, newName.trim());
        renderCategoryManager();
        renderCategoryTabs();
        loadWatchlist();
      }
    });
  });

  // Remove handlers
  list.querySelectorAll('.remove-cat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.category-item');
      const name = item.dataset.cat;
      if (confirm(`Delete category "${name}"? Markets in it will become uncategorized.`)) {
        watchlist.removeCategory(name);
        if (watchlistCategoryFilter === name) watchlistCategoryFilter = 'all';
        renderCategoryManager();
        renderCategoryTabs();
        loadWatchlist();
      }
    });
  });
}

// Toggle category manager panel
document.getElementById('manage-categories-btn')?.addEventListener('click', () => {
  const panel = document.getElementById('category-manager');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) renderCategoryManager();
});

// Add category
document.getElementById('add-category-btn')?.addEventListener('click', () => {
  const input = document.getElementById('new-category-input');
  const name = input.value.trim();
  if (!name) return;
  if (watchlist.addCategory(name)) {
    input.value = '';
    renderCategoryManager();
    renderCategoryTabs();
  } else {
    ui.showStatus('Category already exists', 'error');
  }
});
document.getElementById('new-category-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('add-category-btn')?.click();
});

async function loadWatchlist() {
  const listEl = document.getElementById('watchlist-list');
  renderCategoryTabs();

  let addresses;
  if (watchlistCategoryFilter === 'all') {
    addresses = watchlist.getAll();
  } else if (watchlistCategoryFilter === '__uncategorized') {
    addresses = watchlist.getByCategory(null);
  } else {
    addresses = watchlist.getByCategory(watchlistCategoryFilter);
  }

  if (addresses.length === 0) {
    const msg = watchlistCategoryFilter === 'all'
      ? 'No markets in your watchlist yet. Browse markets and tap ☆ to add them.'
      : `No markets in "${watchlistCategoryFilter === '__uncategorized' ? 'Uncategorized' : watchlistCategoryFilter}".`;
    listEl.innerHTML = `<div class="empty-state">${msg}</div>`;
    return;
  }

  listEl.innerHTML = '<div class="loading-state"><div class="spinner"></div><span>Loading watchlist…</span></div>';

  try {
    const cards = [];
    for (const addr of addresses) {
      try {
        const pk = new PublicKey(addr);
        const market = await sdk.fetchMarket(pk);
        if (market) cards.push({ pubkey: pk, account: market, address: addr });
      } catch {}
    }

    if (cards.length === 0) {
      listEl.innerHTML = '<div class="empty-state">Watchlisted markets could not be loaded.</div>';
      return;
    }

    // Resolve token metadata + USD prices for watchlist markets
    const mintSet = new Set();
    mintSet.add(SOL_MINT);
    for (const { account } of cards) {
      if (account.denomination === 0) {
        account._tokenSymbol = 'SOL';
        account._tokenName = 'Solana';
        account._tokenIcon = SOL_ICON;
      } else {
        const mint = account.tokenMint.toBase58();
        mintSet.add(mint);
        const meta = await fetchTokenIcon(mint);
        account._tokenSymbol = meta.symbol || 'Token';
        account._tokenName = meta.name || mint.slice(0, 6) + '…';
        account._tokenIcon = meta.icon || '';
      }
    }
    const prices = await fetchTokenPrices([...mintSet]);
    const solPrice = prices.get(SOL_MINT) || 0;
    for (const { account } of cards) {
      if (account.denomination === 0) {
        account._usdVolume = (Number(account.totalPool) / 1e9) * solPrice;
      } else {
        const mint = account.tokenMint.toBase58();
        const tokenPrice = prices.get(mint) || 0;
        const decimals = account.tokenDecimals || 9;
        account._usdVolume = (Number(account.totalPool) / (10 ** decimals)) * (tokenPrice || 1);
      }
    }

    const categories = watchlist.getCategories();
    listEl.innerHTML = '';
    for (const { pubkey, account, address: addr } of cards) {
      const positions = userPositionsMap.get(addr) || null;
      const card = ui.renderMarketCard(pubkey, account, positions);

      // Add category selector row
      const currentCat = watchlist.getCategory(addr) || '';
      const catRow = document.createElement('div');
      catRow.className = 'market-card-category-row';
      catRow.innerHTML = `
        <span class="category-select-label">Category:</span>
        <select class="category-select" data-addr="${addr}">
          <option value="" ${!currentCat ? 'selected' : ''}>Uncategorized</option>
          ${categories.map(c => `<option value="${c}" ${currentCat === c ? 'selected' : ''}>${c}</option>`).join('')}
        </select>
      `;
      card.appendChild(catRow);

      card.addEventListener('click', (e) => {
        if (e.target.closest('.watchlist-star') || e.target.closest('.category-select')) return;
        openMarketDetail(pubkey);
      });
      listEl.appendChild(card);
    }

    // Category select handlers
    listEl.querySelectorAll('.category-select').forEach(sel => {
      sel.addEventListener('change', (e) => {
        e.stopPropagation();
        watchlist.setCategory(sel.dataset.addr, sel.value || null);
        renderCategoryTabs();
      });
    });

    // Watchlist star handlers (remove)
    listEl.querySelectorAll('.watchlist-star').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        watchlist.remove(btn.dataset.addr);
        const card = btn.closest('.market-card');
        if (card) card.remove();
        renderCategoryTabs();
        if (listEl.querySelectorAll('.market-card').length === 0) {
          listEl.innerHTML = '<div class="empty-state">No markets in this view.</div>';
        }
      });
    });
  } catch (err) {
    console.error('Watchlist load error:', err);
    listEl.innerHTML = '<div class="empty-state">Failed to load watchlist.</div>';
  }
}

// Clear watchlist button
document.getElementById('clear-watchlist-btn')?.addEventListener('click', () => {
  if (!confirm('Clear your entire watchlist?')) return;
  watchlist.clearMarkets();
  renderCategoryTabs();
  document.getElementById('watchlist-list').innerHTML = '<div class="empty-state">No markets in your watchlist.</div>';
});

// ═══════════════════════════════════════════════════════════════════
// Wallet Integration
// ═══════════════════════════════════════════════════════════════════
function setupWallet() {
  wallet.onWalletChange((ctx) => {
    if (ctx) {
      const disconnectBtn = ui.renderWalletConnected(ctx.publicKey);
      disconnectBtn.addEventListener('click', wallet.disconnect);
      document.getElementById('network-indicator')?.classList.add('connected');
    } else {
      const isMob = wallet.isMobile() && !wallet.isWalletBrowser();
      ui.renderWalletDisconnected(wallet.getAvailableWallets(), isMob);
      attachConnectListeners();
      document.getElementById('network-indicator')?.classList.remove('connected');
    }
    // Refresh current view
    refreshUserPositions().then(() => {
      const activeNav = document.querySelector('.nav-btn.active');
      if (activeNav) {
        const view = activeNav.dataset.view;
        if (view === 'explore') renderMarketsList(false);
        if (view === 'positions') loadPositions();
        if (view === 'create') updateCreateForm();
        if (view === 'watchlist') loadWatchlist();
      }
    });
    // Update detail view bet button
    updateBetUI();
  });
}

function attachConnectListeners() {
  const isMob = wallet.isMobile() && !wallet.isWalletBrowser();

  if (wallet.isTelegramBrowser()) {
    ui.showStatus('Open in your browser for wallet access.', 'info');
    return;
  }

  const connectBtn = document.getElementById('connect-wallet-btn');
  if (!connectBtn) return;

  if (isMob) {
    connectBtn.addEventListener('click', async () => {
      try { await wallet.connectMobile(); } catch (err) {
        ui.showStatus('Failed to connect wallet', 'error');
        console.error(err);
      }
    });
    return;
  }

  const wallets = wallet.getAvailableWallets();
  if (wallets.length === 1) {
    connectBtn.addEventListener('click', () => wallet.connectDesktop(wallets[0].provider).catch(err => {
      ui.showStatus('Failed to connect', 'error');
    }));
  } else if (wallets.length > 1) {
    connectBtn.addEventListener('click', () => {
      document.getElementById('wallet-options')?.classList.toggle('hidden');
    });
    document.querySelectorAll('.wallet-option').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        wallet.connectDesktop(wallets[parseInt(btn.dataset.index)].provider).catch(() => {});
        document.getElementById('wallet-options')?.classList.add('hidden');
      });
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.wallet-dropdown')) {
        document.getElementById('wallet-options')?.classList.add('hidden');
      }
    });
  }
}

// ═══════════════════════════════════════════════════════════════════
// Navigation
// ═══════════════════════════════════════════════════════════════════
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});
document.querySelector('.logo-btn')?.addEventListener('click', () => switchView('explore'));

// ═══════════════════════════════════════════════════════════════════
// Hash Router
// ═══════════════════════════════════════════════════════════════════

/**
 * Parse the current hash and route to the appropriate view.
 * Supported routes:
 *   #/explore          → Explore view
 *   #/market/<address> → Market detail for the given address
 *   #/positions        → My Positions view
 *   #/watchlist        → Watchlist view
 *   #/info             → Info / Manual view
 *   #/create           → Create Market view
 *   #/admin            → Admin view
 *   (empty / unknown)  → Explore view
 */
function handleRoute() {
  if (_suppressHashChange) return;

  const hash = window.location.hash || '';
  const parts = hash.replace(/^#\/?/, '').split('/');
  const route = parts[0] || 'explore';

  if (route === 'market' && parts[1]) {
    // Direct link to a market
    try {
      const pubkey = new PublicKey(parts[1]);
      openMarketDetail(pubkey);
      return;
    } catch {
      // Invalid pubkey, fall through to explore
      console.warn('Invalid market address in URL:', parts[1]);
    }
  }

  if (viewNames.includes(route) && route !== 'market') {
    switchView(route, { updateHash: false });
  } else {
    switchView('explore', { updateHash: false });
  }
}

window.addEventListener('hashchange', handleRoute);

// ═══════════════════════════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════════════════════════
async function init() {
  setupWallet();

  // Initial wallet render
  const isMob = wallet.isMobile() && !wallet.isWalletBrowser();
  ui.renderWalletDisconnected(wallet.getAvailableWallets(), isMob);
  attachConnectListeners();

  // Try silent reconnect
  await wallet.trySilentConnect();

  // Route based on initial URL hash (handles direct links like #/market/<addr>)
  const hash = window.location.hash || '';
  if (hash.startsWith('#/market/')) {
    // Let handleRoute open the market directly — skip loadMarkets first
    handleRoute();
  } else {
    // Default: load explore view
    handleRoute();
    await loadMarkets();
  }

  // Start polling
  pollInterval = setInterval(() => {
    const activeNav = document.querySelector('.nav-btn.active');
    if (activeNav?.dataset.view === 'explore') loadMarkets();
  }, MARKET_POLL_MS);
}

init().catch(err => console.error('Init error:', err));