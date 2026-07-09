/**
 * @module app
 * Main application controller.
 */
import { Buffer } from 'buffer';
window.Buffer = Buffer;

import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { PROGRAM_ID, MARKET_POLL_MS, RPC_URL, PRICE_CACHE_MS, SOL_MINT, TOKEN_GATE, JUP_API_KEY, STREET_BET_SECONDS } from './config.js';
import * as wallet from './wallet.js';
import * as sdk from './sdk.js';
import * as ui from './ui.js';
import * as watchlist from './watchlist.js';
import { gateEnabled, checkGate, getGateTokenInfo, clearGateCache } from './gate.js';
import * as makers from './makers.js';
import * as notifications from './notifications.js';

const GATE_SWAP_URL = TOKEN_GATE
  ? `https://jup.ag/swap?sell=So11111111111111111111111111111111111111112&buy=${TOKEN_GATE.split(',')[0].trim()}`
  : '';

// ═══════════════════════════════════════════════════════════════════
// Filter Persistence
// ═══════════════════════════════════════════════════════════════════
const FILTER_STORAGE_KEY = 'precog_filters';

function saveFilters() {
  try {
    localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify({
      explore: {
        status: currentFilter,
        sort: currentSort,
        mine: currentMineOnly,
        street: currentStreetBetsOnly,
        category: currentCategoryFilter,
        creator: currentCreatorFilter,
        token: currentTokenFilter,
        filtersOpen: exploreFiltersOpen,
      },
      positions: {
        category: currentPositionsCategoryFilter,
        status: currentPositionsStatusFilter,
        result: currentPositionsResultFilter,
        sort: currentPositionsSort,
        token: currentPositionsTokenFilter,
        maker: currentPositionsMakerFilter,
        mine: posShowMineOnly,
        street: posShowStreetBetsOnly,
        filtersOpen: posFiltersOpen,
      },
      watchlist: {
        catsOpen: watchlistCatsOpen,
      },
    }));
  } catch { /* storage unavailable */ }
}

let exploreFiltersOpen = false;
let posFiltersOpen = false;
let watchlistCatsOpen = false;

function loadFilters() {
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved.explore) {
      currentFilter = saved.explore.status || 'open';
      currentSort = saved.explore.sort || 'created-desc';
      currentMineOnly = saved.explore.mine || false;
      currentStreetBetsOnly = saved.explore.street || false;
      currentCategoryFilter = saved.explore.category || 'all';
      currentCreatorFilter = saved.explore.creator || 'all';
      currentTokenFilter = saved.explore.token || 'all';
      exploreFiltersOpen = saved.explore.filtersOpen || false;
    }
    if (saved.positions) {
      currentPositionsCategoryFilter = saved.positions.category || 'all';
      currentPositionsStatusFilter = saved.positions.status || 'all';
      currentPositionsResultFilter = saved.positions.result || 'all';
      currentPositionsSort = saved.positions.sort || 'created-desc';
      currentPositionsTokenFilter = saved.positions.token || 'all';
      currentPositionsMakerFilter = saved.positions.maker || 'all';
      posShowMineOnly = saved.positions.mine || false;
      posShowStreetBetsOnly = saved.positions.street || false;
      posFiltersOpen = saved.positions.filtersOpen || false;
    }
    if (saved.watchlist) {
      watchlistCatsOpen = saved.watchlist.catsOpen || false;
    }
  } catch { /* storage unavailable or corrupt */ }
}

function applyFiltersToDOM() {
  // Explore dropdowns
  const statusEl = document.getElementById('explore-status-filter');
  if (statusEl) statusEl.value = currentFilter;
  const sortEl = document.getElementById('explore-sort-select');
  if (sortEl) sortEl.value = currentSort;
  // Explore toggles
  const mineBtn = document.getElementById('explore-mine-toggle');
  if (mineBtn) mineBtn.classList.toggle('active', currentMineOnly);
  const streetBtn = document.getElementById('explore-street-toggle');
  if (streetBtn) streetBtn.classList.toggle('active', currentStreetBetsOnly);
  // Explore filters panel
  const explorePanel = document.getElementById('explore-filters-panel');
  const exploreToggleBtn = document.getElementById('explore-filter-toggle');
  if (explorePanel) explorePanel.classList.toggle('hidden', !exploreFiltersOpen);
  if (exploreToggleBtn) {
    exploreToggleBtn.textContent = exploreFiltersOpen ? 'Filters ▾' : 'Filters ▸';
    exploreToggleBtn.classList.toggle('active', exploreFiltersOpen);
  }
  // Positions dropdowns
  const posStatusEl = document.getElementById('positions-status-filter');
  if (posStatusEl) posStatusEl.value = currentPositionsStatusFilter;
  const posResultEl = document.getElementById('positions-result-filter');
  if (posResultEl) posResultEl.value = currentPositionsResultFilter;
  const posSortEl = document.getElementById('positions-sort');
  if (posSortEl) posSortEl.value = currentPositionsSort;
  const posMakerEl = document.getElementById('positions-maker-filter');
  if (posMakerEl) posMakerEl.value = currentPositionsMakerFilter;
  // Positions toggles
  const posMineBtn = document.getElementById('pos-mine-toggle');
  if (posMineBtn) posMineBtn.classList.toggle('active', posShowMineOnly);
  const posStreetBtn = document.getElementById('pos-street-toggle');
  if (posStreetBtn) posStreetBtn.classList.toggle('active', posShowStreetBetsOnly);
  // Positions filters panel
  const posPanel = document.getElementById('pos-filters-panel');
  const posToggleBtn = document.getElementById('pos-filter-toggle');
  if (posPanel) posPanel.classList.toggle('hidden', !posFiltersOpen);
  if (posToggleBtn) {
    posToggleBtn.textContent = posFiltersOpen ? 'Filters ▾' : 'Filters ▸';
    posToggleBtn.classList.toggle('active', posFiltersOpen);
  }
  // Watchlist categories panel
  const wlPanel = document.getElementById('watchlist-cats-panel');
  const wlToggleBtn = document.getElementById('watchlist-cats-toggle');
  if (wlPanel) wlPanel.classList.toggle('hidden', !watchlistCatsOpen);
  if (wlToggleBtn) {
    wlToggleBtn.textContent = watchlistCatsOpen ? 'Categories ▾' : 'Categories ▸';
    wlToggleBtn.classList.toggle('active', watchlistCatsOpen);
  }
  // Note: category, creator, and token filters are populated dynamically
  // and will be set when their populate functions run.
}

// ═══════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════
let allMarkets = [];
let currentFilter = 'open';
let currentSort = 'created-desc';
let currentMineOnly = false;
let currentStreetBetsOnly = false;
let currentCreatorFilter = 'all';
let currentCategoryFilter = 'all';
let currentMarketPubkey = null;
let currentMarketData = null;
let selectedOutcome = null;

// Pagination
const PAGE_SIZE = 20;

// ═══════════════════════════════════════════════════════════════════
// Program Error Code Mapping (driven by SDK - never hardcode numbers)
// ═══════════════════════════════════════════════════════════════════

// Friendly overrides for error names where the PascalCase isn't clear enough
const ERROR_FRIENDLY = {
  InvalidInstructionData: 'Invalid instruction data',
  MarketTitleTooLong: 'Market title is too long',
  MarketDescriptionTooLong: 'Market description is too long',
  InvalidOutcomeCount: 'Invalid outcome count (must be 2-10)',
  OutcomeLabelTooLong: 'Outcome label is too long',
  DeadlineInPast: 'Deadline must be in the future',
  MarketNotOpen: 'Market is not open',
  MarketAlreadyResolved: 'Market is already resolved',
  ZeroBetAmount: 'Position amount must be greater than zero',
  BetBelowMinimum: 'Position amount is below minimum',
  AlreadyClaimedWinnings: 'Winnings already claimed',
  RefundNotAvailable: 'Refund not available',
  UnauthorizedAuthority: 'Unauthorized - not the market authority',
  UnauthorizedAdmin: 'Unauthorized - not the protocol admin',
  UnauthorizedPositionOwner: 'Unauthorized - not the position owner',
  InvalidPDA: 'Invalid PDA derivation',
  FeeTooHigh: 'Fee exceeds maximum allowed',
  TransferHookNotAllowed: 'Tokens with transfer hooks cannot be used for markets',
  NonTransferableNotAllowed: 'Non-transferable tokens cannot be used for markets',
  PermanentDelegateNotAllowed: 'Tokens with permanent delegates cannot be used for markets',
  ConfidentialTransferNotAllowed: 'Tokens with confidential transfers cannot be used for markets',
  UnsupportedTokenExtension: 'This token has an unsupported Token-2022 extension and cannot be used for markets',
  NewDeadlineInPast: 'New deadline must be in the future',
  FeeBelowProtocolMinimum: 'Fee is below the protocol minimum',
  OutcomeUnchanged: 'Resolution outcome must differ from current',
};

// Convert PascalCase to readable: "MarketNotOpen" → "Market not open"
function pascalToReadable(name) {
  return name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
}

// Import ErrorCode from SDK (code → name map)
const _sdkErrorCode = sdk.ErrorCode;

function parseProgramError(err) {
  const msg = err?.message || String(err);
  // Match "custom program error: 0x2d" or "Custom": 45
  const hexMatch = msg.match(/custom program error:\s*0x([0-9a-fA-F]+)/i);
  const jsonMatch = msg.match(/"Custom":\s*(\d+)/);
  if (hexMatch || jsonMatch) {
    const code = hexMatch ? parseInt(hexMatch[1], 16) : parseInt(jsonMatch[1], 10);
    const name = _sdkErrorCode[code];
    if (name) return ERROR_FRIENDLY[name] || pascalToReadable(name);
    return `Program error ${code}`;
  }
  return msg;
}
let currentPage = 0;
let filteredMarkets = [];   // current filtered+sorted list
let _loadMoreObserver = null;
let currentTokenFilter = 'all';
let pollInterval = null;

// User positions cache - Map<marketAddress, Array<{outcomeIndex, amount}>>
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
const viewNames = ['explore', 'market', 'positions', 'make', 'admin', 'watchlist', 'info', 'settings', 'privacy', 'terms'];

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
  if (name === 'make') updateCreateForm();
  if (name === 'watchlist') loadWatchlist();
  if (name === 'settings') renderSettingsPage();
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
    // Already watched - remove
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
        ${watchlist.sortedCategories(categories).map(c => `<button class="watchlist-picker-option" data-cat="${c}">${c}</button>`).join('')}
      </div>
      <div class="watchlist-picker-new">
        <input type="text" class="watchlist-picker-new-input" placeholder="New category…" maxlength="32">
        <button class="watchlist-picker-new-btn">+</button>
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

  // New category inline creation
  const newInput = overlay.querySelector('.watchlist-picker-new-input');
  const newBtn = overlay.querySelector('.watchlist-picker-new-btn');
  const createAndAdd = () => {
    const name = newInput.value.trim();
    if (!name) return;
    if (watchlist.addCategory(name)) {
      watchlist.add(addr, name);
      overlay.remove();
      onUpdate(true);
      renderCategoryTabs();
    } else {
      // Category already exists - just use it
      watchlist.add(addr, name);
      overlay.remove();
      onUpdate(true);
    }
  };
  newBtn.addEventListener('click', createAndAdd);
  newInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') createAndAdd(); });

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

    // Augment each market with resolved token info + deadline check
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
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
      // Mark open markets past their deadline
      account._expired = account.status === 0 && account.resolutionDeadline <= nowSec;
    }

    // Fetch creation times for Street Bet detection - non-blocking
    Promise.all(allMarkets.map(async ({ pubkey, account }) => {
      const addr = pubkey.toBase58();
      const creationTime = await fetchCreationTime(addr);
      if (creationTime) {
        const runtime = Number(account.resolutionDeadline) - creationTime;
        account._isStreetBet = runtime > 0 && runtime <= STREET_BET_SECONDS;
        account._creationTime = creationTime;
      } else {
        account._isStreetBet = false;
      }
    })).then(() => renderMarketsList(false)).catch(() => {});

    // Fetch USD prices for all unique mints (SOL + tokens) - non-blocking for chart
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

    // On poll refresh, don't reset the page - show same amount user has scrolled to
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
  updateTokenChooserButton();

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

  // Status filter
  if (currentFilter === 'open') {
    filtered = filtered.filter(m => m.account.status === 0 && !m.account._expired);
  } else if (currentFilter === 'closed') {
    filtered = filtered.filter(m => m.account._expired);
  } else if (currentFilter === 'ready') {
    const nowSec = Math.floor(Date.now() / 1000);
    filtered = filtered.filter(m => m.account.status === 1 && nowSec >= Number(m.account.resolvedAt) + 86400);
  } else if (currentFilter === 'resolved') {
    const nowSec = Math.floor(Date.now() / 1000);
    filtered = filtered.filter(m => m.account.status === 1 && nowSec < Number(m.account.resolvedAt) + 86400);
  } else if (currentFilter !== 'all') {
    const map = { finalized: 2, voided: 3 };
    const val = map[currentFilter];
    if (val !== undefined) filtered = filtered.filter(m => m.account.status === val);
  }

  // My Markets toggle
  if (currentMineOnly) {
    const w = wallet.getWallet();
    if (!w) {
      listEl.innerHTML = '<div class="empty-state">Connect your wallet to see your markets.</div>';
      return;
    }
    const myAddr = w.publicKey.toBase58();
    filtered = filtered.filter(m => m.account.authority.toBase58() === myAddr || m.account.creator.toBase58() === myAddr);
  }

  // Street Bets filter
  if (currentStreetBetsOnly) {
    filtered = filtered.filter(m => m.account._isStreetBet);
  }

  switch (currentSort) {
    case 'value-desc': filtered.sort((a, b) => (b.account._usdVolume || 0) - (a.account._usdVolume || 0)); break;
    case 'value-asc': filtered.sort((a, b) => (a.account._usdVolume || 0) - (b.account._usdVolume || 0)); break;
    case 'deadline-asc':
      filtered.sort((a, b) => Number(a.account.resolutionDeadline - b.account.resolutionDeadline));
      break;
    case 'deadline-desc': filtered.sort((a, b) => Number(b.account.resolutionDeadline - a.account.resolutionDeadline)); break;
    case 'created-desc': filtered.sort((a, b) => (b.account._creationTime || Number(b.account.marketId)) - (a.account._creationTime || Number(a.account.marketId))); break;
    case 'created-asc': filtered.sort((a, b) => (a.account._creationTime || Number(a.account.marketId)) - (b.account._creationTime || Number(b.account.marketId))); break;
    case 'positions-desc': filtered.sort((a, b) => Number(b.account.totalPositions - a.account.totalPositions)); break;
    case 'positions-asc': filtered.sort((a, b) => Number(a.account.totalPositions - b.account.totalPositions)); break;
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

  // Resolve SNS names for creator addresses
  ui.resolveSnsElements(listEl);

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
// Status dropdown filter
document.getElementById('explore-status-filter')?.addEventListener('change', (e) => {
  currentFilter = e.target.value;
  saveFilters();
  renderMarketsList();
});
// Filter panel toggles
document.getElementById('explore-filter-toggle')?.addEventListener('click', () => {
  exploreFiltersOpen = !exploreFiltersOpen;
  const panel = document.getElementById('explore-filters-panel');
  const btn = document.getElementById('explore-filter-toggle');
  panel?.classList.toggle('hidden', !exploreFiltersOpen);
  if (btn) {
    btn.textContent = exploreFiltersOpen ? 'Filters ▾' : 'Filters ▸';
    btn.classList.toggle('active', exploreFiltersOpen);
  }
  saveFilters();
});
document.getElementById('pos-filter-toggle')?.addEventListener('click', () => {
  posFiltersOpen = !posFiltersOpen;
  const panel = document.getElementById('pos-filters-panel');
  const btn = document.getElementById('pos-filter-toggle');
  panel?.classList.toggle('hidden', !posFiltersOpen);
  if (btn) {
    btn.textContent = posFiltersOpen ? 'Filters ▾' : 'Filters ▸';
    btn.classList.toggle('active', posFiltersOpen);
  }
  saveFilters();
});
document.getElementById('watchlist-cats-toggle')?.addEventListener('click', () => {
  watchlistCatsOpen = !watchlistCatsOpen;
  const panel = document.getElementById('watchlist-cats-panel');
  const btn = document.getElementById('watchlist-cats-toggle');
  panel?.classList.toggle('hidden', !watchlistCatsOpen);
  if (btn) {
    btn.textContent = watchlistCatsOpen ? 'Categories ▾' : 'Categories ▸';
    btn.classList.toggle('active', watchlistCatsOpen);
  }
  saveFilters();
});
// My Markets toggle button
document.getElementById('explore-mine-toggle')?.addEventListener('click', (e) => {
  currentMineOnly = !currentMineOnly;
  e.target.classList.toggle('active', currentMineOnly);
  saveFilters();
  renderMarketsList();
});
document.getElementById('explore-street-toggle')?.addEventListener('click', (e) => {
  currentStreetBetsOnly = !currentStreetBetsOnly;
  e.target.classList.toggle('active', currentStreetBetsOnly);
  saveFilters();
  renderMarketsList();
});
document.getElementById('explore-sort-select')?.addEventListener('change', (e) => {
  currentSort = e.target.value;
  saveFilters();
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

  const prev = currentCreatorFilter || sel.value;
  sel.innerHTML = '<option value="all">All Makers</option>';

  // Show all saved makers, sorted alphabetically
  const savedAddrList = makers.getAll();
  const savedCreators = savedAddrList.map(addr => [addr, addr.slice(0, 4) + '…' + addr.slice(-4)]);
  savedCreators.sort((a, b) => a[1].localeCompare(b[1]));

  for (const [addr, short] of savedCreators) {
    const opt = document.createElement('option');
    opt.value = addr;
    opt.textContent = short;
    sel.appendChild(opt);
  }

  // Restore previous selection if still valid
  if (savedAddrList.includes(prev)) sel.value = prev;
  else { sel.value = 'all'; currentCreatorFilter = 'all'; }

  // Resolve SNS names in background
  import('./sns.js').then(sns => {
    for (const [addr] of savedCreators) {
      sns.resolveDisplayName(addr).then(name => {
        const opt = sel.querySelector(`option[value="${addr}"]`);
        if (opt) opt.textContent = name;
      });
    }
  });
}

document.getElementById('explore-creator-filter')?.addEventListener('change', (e) => {
  currentCreatorFilter = e.target.value;
  saveFilters();
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

  const prev = currentCategoryFilter || sel.value;
  sel.innerHTML = '<option value="all">All Categories</option>';
  if (uncategorized > 0) {
    const opt = document.createElement('option');
    opt.value = '__none';
    opt.textContent = `Uncategorized (${uncategorized})`;
    sel.appendChild(opt);
  }
  const sorted = [...categories.entries()].sort((a, b) => a[0].localeCompare(b[0]));
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
  saveFilters();
  renderMarketsList();
});

// Token chooser (custom HTML dropdown with icons)
const NATIVE_SOL_MINT = '11111111111111111111111111111111';
const SOL_ICON = 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png';
let _lastTokenSet = '';
let _tokenIconCache = new Map(); // mint → icon URL

// ── Market creation time cache (for Street Bet detection) ────────
let _creationTimeCache = new Map(); // market address → unix timestamp

/** Fetch market creation time from its earliest transaction signature */
async function fetchCreationTime(marketAddress) {
  const addr = typeof marketAddress === 'string' ? marketAddress : marketAddress.toBase58();
  if (_creationTimeCache.has(addr)) return _creationTimeCache.get(addr);
  try {
    const conn = sdk.getConnection();
    // Returns newest-first; fetch a batch and take the last (earliest) entry
    const sigs = await conn.getSignaturesForAddress(
      new PublicKey(addr),
      { limit: 20 },
      'finalized'
    );
    const earliest = sigs.length > 0 ? sigs[sigs.length - 1] : null;
    if (earliest?.blockTime) {
      _creationTimeCache.set(addr, earliest.blockTime);
      return earliest.blockTime;
    }
  } catch {}
  return null;
}

/** Check if a market qualifies as a Street Bet (runtime < 30 min) */
function isStreetBet(market) {
  return market._isStreetBet === true;
}

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
      const headers = { 'Accept': 'application/json' };
      if (JUP_API_KEY) headers['x-api-key'] = JUP_API_KEY;
      const resp = await fetch(`https://api.jup.ag/price/v3?ids=${ids}`, { headers });
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

  // Gather unique token mints from OPEN markets only
  const tokens = new Map();
  for (const { account } of allMarkets) {
    if (account.status !== 0) continue; // open markets only
    const mint = account.denomination === 0 ? NATIVE_SOL_MINT : account.tokenMint.toBase58();
    if (!tokens.has(mint)) {
      tokens.set(mint, { count: 0, denomination: account.denomination, denominationName: account.denominationName, tokenDecimals: account.tokenDecimals });
    }
    tokens.get(mint).count++;
  }

  const key = [...tokens.keys()].sort().join(',');
  if (key === _lastTokenSet) return;
  _lastTokenSet = key;

  dropdown.innerHTML = '';

  // Search input
  const searchWrap = document.createElement('div');
  searchWrap.className = 'token-chooser-search';
  searchWrap.innerHTML = `<input type="text" class="token-search-input" placeholder="Search tokens..." autocomplete="off">`;
  dropdown.appendChild(searchWrap);

  // "All Tokens" option
  const allItem = document.createElement('div');
  allItem.className = `token-chooser-item${currentTokenFilter === 'all' ? ' active' : ''}`;
  allItem.dataset.mint = 'all';
  allItem.dataset.searchable = 'all tokens';
  allItem.innerHTML = `<span class="token-chooser-label">All Tokens</span>`;
  dropdown.appendChild(allItem);

  // Build sorted list: SOL first, then by open count descending
  const tokenItems = [];

  if (tokens.has(NATIVE_SOL_MINT)) {
    tokenItems.push({ mint: NATIVE_SOL_MINT, info: tokens.get(NATIVE_SOL_MINT), isSol: true });
    tokens.delete(NATIVE_SOL_MINT);
  }

  const sorted = [...tokens.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [mint, info] of sorted) {
    tokenItems.push({ mint, info, isSol: false });
  }

  // Render items
  tokenItems.forEach(({ mint, info, isSol }, index) => {
    const item = document.createElement('div');
    item.className = `token-chooser-item${currentTokenFilter === mint ? ' active' : ''}`;
    item.dataset.mint = mint;

    if (isSol) {
      item.dataset.searchable = 'sol native solana';
      item.innerHTML = `
        <img class="token-icon" src="${SOL_ICON}" alt="SOL" onerror="this.style.display='none'">
        <span class="token-chooser-label">SOL <span class="token-chooser-sub">Native</span></span>
        <span class="token-chooser-count">${info.count}</span>
      `;
    } else {
      const shortMint = mint.slice(0, 4) + '…' + mint.slice(-4);
      const typeLabel = info.denominationName === 'Token2022' ? 'Token-2022' : 'SPL';
      item.dataset.searchable = `${shortMint} ${typeLabel}`;
      item.innerHTML = `
        <img class="token-icon" src="" alt="" style="display:none">
        <span class="token-chooser-label">
          <span class="token-symbol-name">Loading…</span>
          <a class="token-mint-link" href="https://solscan.io/token/${mint}" target="_blank" rel="noopener" title="${mint}">${shortMint}</a>
          <span class="token-chooser-sub">${typeLabel}</span>
        </span>
        <span class="token-chooser-count">${info.count}</span>
      `;

      // Fetch icon async and update searchable data
      fetchTokenIcon(mint).then(({ icon, name, symbol }) => {
        const img = item.querySelector('.token-icon');
        const label = item.querySelector('.token-symbol-name');
        if (icon) { img.src = icon; img.style.display = ''; }
        const displayName = symbol ? `${symbol}${name ? ' - ' + name : ''}` : shortMint;
        label.textContent = displayName;
        item.dataset.searchable = `${symbol || ''} ${name || ''} ${shortMint} ${typeLabel} ${mint}`.toLowerCase();
      });
    }

    // Hide items beyond top 5 by default (not counting "All Tokens")
    if (index >= 5) item.classList.add('token-overflow');

    dropdown.appendChild(item);
  });

  // Toggle scrollable
  const visibleCount = dropdown.querySelectorAll('.token-chooser-item:not(.token-overflow)').length;
  dropdown.classList.toggle('scrollable', visibleCount > 10);

  // Search handler
  const searchInput = dropdown.querySelector('.token-search-input');
  searchInput?.addEventListener('input', () => {
    const query = searchInput.value.toLowerCase().trim();
    const items = dropdown.querySelectorAll('.token-chooser-item');
    let shown = 0;
    items.forEach(item => {
      if (item.dataset.mint === 'all') {
        item.style.display = query ? 'none' : '';
        return;
      }
      const match = !query || (item.dataset.searchable || '').includes(query);
      item.style.display = match ? '' : 'none';
      item.classList.toggle('token-overflow', false); // show all when searching
      if (match) shown++;
    });
    // When search is cleared, re-hide overflow items
    if (!query) {
      items.forEach((item, i) => {
        item.style.display = '';
        // i=0 is "All Tokens", so token items start at 1, hide after top 5 (index 6+)
        if (i > 5) item.classList.add('token-overflow');
        else item.classList.remove('token-overflow');
      });
    }
    dropdown.classList.toggle('scrollable', shown > 10);
  });

  // Prevent search input clicks from closing dropdown
  searchInput?.addEventListener('click', (e) => e.stopPropagation());

  // Click handlers for items
  dropdown.querySelectorAll('.token-chooser-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.token-mint-link')) return;
      e.stopPropagation();
      currentTokenFilter = item.dataset.mint;
      saveFilters();
      updateTokenChooserButton();
      dropdown.classList.add('hidden');
      document.querySelector('.token-chooser-backdrop')?.remove();
      _lastTokenSet = '';
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
  document.getElementById('pos-token-chooser-dropdown')?.classList.add('hidden');
  document.querySelector('.token-chooser-backdrop')?.remove();
});

// Stop propagation inside dropdown
document.getElementById('token-chooser-dropdown')?.addEventListener('click', (e) => {
  e.stopPropagation();
});

// Positions filters - use event delegation for reliability
function reRenderPositions() {
  const listEl = document.getElementById('positions-list');
  if (_positionEntries.length > 0) renderPositionsList(_positionEntries, listEl);
}
document.querySelector('.positions-filters')?.addEventListener('change', (e) => {
  const id = e.target.id;
  if (id === 'positions-category-filter') {
    currentPositionsCategoryFilter = e.target.value;
    saveFilters();
    reRenderPositions();
  } else if (id === 'positions-status-filter') {
    currentPositionsStatusFilter = e.target.value;
    saveFilters();
    reRenderPositions();
  } else if (id === 'positions-result-filter') {
    currentPositionsResultFilter = e.target.value;
    saveFilters();
    reRenderPositions();
  } else if (id === 'positions-sort') {
    currentPositionsSort = e.target.value;
    saveFilters();
    reRenderPositions();
  } else if (id === 'positions-maker-filter') {
    currentPositionsMakerFilter = e.target.value;
    saveFilters();
    reRenderPositions();
  }
});
// Positions toggle buttons
document.getElementById('pos-mine-toggle')?.addEventListener('click', (e) => {
  posShowMineOnly = !posShowMineOnly;
  e.target.classList.toggle('active', posShowMineOnly);
  saveFilters();
  reRenderPositions();
});
document.getElementById('pos-street-toggle')?.addEventListener('click', (e) => {
  posShowStreetBetsOnly = !posShowStreetBetsOnly;
  e.target.classList.toggle('active', posShowStreetBetsOnly);
  saveFilters();
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

    // Set _usdVolume for estimate badge USD display
    const detDecimals = market.denomination === 0 ? 9 : (market.tokenDecimals || 9);
    market._usdVolume = (Number(market.totalPool) / (10 ** detDecimals)) * tokenUsdPrice;

    // Mark open markets past their deadline
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    market._expired = market.status === 0 && market.resolutionDeadline <= nowSec;

    // Street Bet detection
    const creationTime = await fetchCreationTime(pubkey.toBase58());
    if (creationTime) {
      const runtime = Number(market.resolutionDeadline) - creationTime;
      market._isStreetBet = runtime > 0 && runtime <= STREET_BET_SECONDS;
    } else {
      market._isStreetBet = false;
    }

    currentMarketData = market;
    const w = wallet.getWallet();
    const positions = userPositionsMap.get(pubkey.toBase58()) || null;
    el.innerHTML = ui.renderMarketDetail(pubkey, market, w?.publicKey, positions);
    // Resolve SNS names for authority/creator
    ui.resolveSnsElements(el);
    // Charts render on demand via toggle
    attachDetailListeners(pubkey, market, tokenUsdPrice);
  } catch (err) {
    console.error(err);
    el.innerHTML = '<div class="empty-state">Failed to load market.</div>';
  }
}

function attachDetailListeners(pubkey, market, tokenUsdPrice = 0) {
  // Save maker button
  const makerBtn = document.getElementById('save-maker-btn');
  if (makerBtn) {
    const makerAddr = makerBtn.dataset.address;
    // Set initial state
    if (makers.has(makerAddr)) {
      makerBtn.classList.add('saved');
      makerBtn.innerHTML = '<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    }
    makerBtn.addEventListener('click', () => {
      const nowSaved = makers.toggle(makerAddr);
      makerBtn.classList.toggle('saved', nowSaved);
      makerBtn.innerHTML = nowSaved
        ? '<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
        : '<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
      _lastCreatorSet = '';
      _lastPosMakerSet = '';
      populateCreatorFilter();
      if (_positionEntries.length > 0) populatePositionsMakerFilter(_positionEntries);
    });
  }
  // Share
  document.getElementById('detail-share-btn')?.addEventListener('click', () => {
    const url = window.location.origin + window.location.pathname + '#/market/' + pubkey.toBase58();
    shareContent(market.title, market.title + ' - Precog Markets', url);
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
  // Gate warning for bet card
  updateGateWarning('bet-gate-warning', wallet.getWallet());
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
  document.getElementById('dispute-void-btn')?.addEventListener('click', handleVoid);
  document.getElementById('dispute-resolve-btn')?.addEventListener('click', handleDisputeResolve);

  // Watchlist detail button
  const wlBtn = document.getElementById('detail-watchlist-btn');
  wlBtn?.addEventListener('click', () => {
    const addr = wlBtn.dataset.addr;
    handleWatchlistStarClick(addr, (nowWatched) => {
      wlBtn.classList.toggle('active', nowWatched);
      wlBtn.innerHTML = `<span>${nowWatched ? '★' : '☆'}</span><span>${nowWatched ? 'Watching' : 'Add to Watchlist'}</span>`;
    });
  });

  // Detail charts - render immediately (visible by default)
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
  if (!w) { btn.textContent = 'Connect Wallet First'; btn.disabled = true; }
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
  const profit = pay - lam;
  est.classList.remove('hidden');
  const v = est.querySelector('.bet-payout-value');
  const sym = currentMarketData._tokenSymbol || (isSol ? 'SOL' : 'tokens');
  const absProfit = profit < 0n ? -profit : profit;
  const sign = profit >= 0n ? '+' : '-';
  let payStr = sign + (isSol ? ui.formatSol(absProfit) : ui.formatTokenAmount(absProfit, decimals) + ' ' + sym);
  // Append USD value
  const priceMint = isSol ? SOL_MINT : currentMarketData.tokenMint.toBase58();
  const tokenPrice = getTokenPrice(priceMint) || (!isSol ? 1 : 0);
  if (tokenPrice > 0) {
    const profitTokens = Number(absProfit) / (10 ** decimals);
    const usd = profitTokens * tokenPrice;
    payStr += ` (${sign}$${usd >= 1 ? usd.toFixed(2) : usd.toFixed(4)})`;
  }
  if (v) v.textContent = payStr;
}

/**
 * Token gate check. Returns true if gate is disabled or wallet passes.
 * Shows an inline error in the given status element ID if blocked.
 * @param {PublicKey} walletPubkey
 * @param {string} statusElementId - ID of the status element to show errors in
 * @returns {Promise<boolean>}
 */
async function requireGate(walletPubkey, statusElementId) {
  if (!gateEnabled) return true;
  const passed = await checkGate(walletPubkey);
  if (passed) return true;

  // Build a message showing which tokens are required
  let msg = 'Token-gated: you must hold one of the required tokens.';
  try {
    const tokens = await getGateTokenInfo();
    if (tokens.length) {
      const names = tokens.map(t => t.symbol !== t.mint
        ? `<a href="${GATE_SWAP_URL}" target="_blank" rel="noopener" style="color:var(--gold)">${t.name} (${t.symbol})</a>`
        : `<code>${t.mint}</code>`);
      msg = `Token required: hold any amount of ${names.join(' or ')} to participate.`;
    }
  } catch { /* use generic message */ }
  ui.showCardStatus(statusElementId, msg, 'error', { html: true });
  return false;
}

/**
 * Show or hide a persistent gate warning banner on a page.
 * @param {string} elementId - ID of the .gate-warning div
 * @param {{ publicKey: PublicKey }|null} w - wallet context
 */
async function updateGateWarning(elementId, w) {
  const el = document.getElementById(elementId);
  if (!el || !gateEnabled) { el?.classList.add('hidden'); return; }
  if (!w) { el.classList.add('hidden'); return; }

  const passed = await checkGate(w.publicKey);
  if (passed) { el.classList.add('hidden'); return; }

  let msg = '🔒 Token-gated - you need to hold a required token to participate.';
  try {
    const tokens = await getGateTokenInfo();
    if (tokens.length) {
      const names = tokens.map(t => t.symbol !== t.mint
        ? `<a href="${GATE_SWAP_URL}" target="_blank" rel="noopener" style="color:var(--gold);font-weight:700">${t.name} (${t.symbol})</a>`
        : `<code>${t.mint}</code>`);
      msg = `🔒 Token-gated - hold any amount of ${names.join(' or ')} to place positions and create markets.`;
    }
  } catch { /* use generic */ }
  el.innerHTML = msg;
  el.classList.remove('hidden');
}

async function handlePlaceBet() {
  const w = wallet.getWallet(); const p = wallet.getProvider();
  if (!w || !p || selectedOutcome === null || !currentMarketPubkey || !currentMarketData) return;
  if (currentMarketData.status !== 0 || currentMarketData._expired) { ui.showBetStatus('This market is no longer open for positions.', 'error'); return; }
  if (!(await requireGate(w.publicKey, 'bet-status'))) return;
  const amount = parseFloat(document.getElementById('bet-amount-input').value);
  if (!amount || amount <= 0) return;
  const isSolBet = currentMarketData.denominationName === 'NativeSol';
  if (isSolBet && amount < 0.01) { ui.showBetStatus('Minimum position is 0.01 SOL.', 'error'); return; }
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
    await openMarketDetail(currentMarketPubkey);
    ui.showBetStatus(`Position confirmed! ${sig.slice(0, 8)}…`, 'success');
    // Background: wait for finalization then refresh positions cache
    const conn = sdk.getConnection();
    conn.getLatestBlockhash('finalized').then(({ blockhash: bh, lastValidBlockHeight: h }) =>
      conn.confirmTransaction({ signature: sig, blockhash: bh, lastValidBlockHeight: h }, 'finalized')
    ).then(() => refreshUserPositions()).catch(() => {});
  } catch (err) {
    ui.hideTxOverlay();
    ui.showBetStatus(parseProgramError(err), 'error');
  }
}

async function handleResolve() {
  const w = wallet.getWallet(); const p = wallet.getProvider();
  if (!w || !p || !currentMarketPubkey) return;
  if (Number(currentMarketData.totalPositions) === 0) { ui.showCardStatus('authority-status', 'Cannot resolve a market with no positions.', 'error'); return; }
  const outcome = parseInt(document.getElementById('resolve-outcome-dropdown')?.value);
  try {
    ui.showTxOverlay('Resolving…');
    const ix = sdk.buildResolveMarket({ market: currentMarketPubkey, authority: w.publicKey }, { winningOutcome: outcome });
    ui.updateTxOverlay('Please approve…');
    const sig = await sdk.signAndSend(ix, w.publicKey, p, { skipEstimation: true, skipSimulation: true });
    ui.updateTxOverlay('Confirming transaction…');
    const conn = sdk.getConnection();
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('finalized');
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'finalized');
    ui.hideTxOverlay();
    ui.showCardStatus('authority-status', 'Market resolved!', 'success');
    openMarketDetail(currentMarketPubkey);
  } catch (err) { ui.hideTxOverlay(); ui.showCardStatus('authority-status', parseProgramError(err), 'error'); }
}

async function handleVoid() {
  const w = wallet.getWallet(); const p = wallet.getProvider();
  if (!w || !p || !currentMarketPubkey) return;
  if (!confirm('Void this market? All positions refunded.')) return;
  const statusId = document.getElementById('dispute-status') ? 'dispute-status' : 'authority-status';
  try {
    ui.showTxOverlay('Voiding…');
    const ix = sdk.buildVoidMarket({ market: currentMarketPubkey, authority: w.publicKey });
    ui.updateTxOverlay('Please approve…');
    const sig = await sdk.signAndSend(ix, w.publicKey, p, { skipEstimation: true, skipSimulation: true });
    ui.updateTxOverlay('Confirming transaction…');
    const conn = sdk.getConnection();
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('finalized');
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'finalized');
    ui.hideTxOverlay();
    ui.showCardStatus(statusId, 'Market voided!', 'success');
    openMarketDetail(currentMarketPubkey);
  } catch (err) { ui.hideTxOverlay(); ui.showCardStatus(statusId, parseProgramError(err), 'error'); }
}

async function handleDisputeResolve() {
  const w = wallet.getWallet(); const p = wallet.getProvider();
  if (!w || !p || !currentMarketPubkey) return;
  const outcome = parseInt(document.getElementById('dispute-resolve-dropdown')?.value);
  if (isNaN(outcome)) { ui.showCardStatus('dispute-status', 'Select an outcome', 'error'); return; }
  if (!confirm('Change the winning outcome? This restarts the 24h dispute window.')) return;
  try {
    ui.showTxOverlay('Changing resolution…');
    const ix = sdk.buildDisputeResolve({ market: currentMarketPubkey, authority: w.publicKey }, { winningOutcome: outcome });
    ui.updateTxOverlay('Please approve…');
    const sig = await sdk.signAndSend(ix, w.publicKey, p, { skipEstimation: true, skipSimulation: true });
    ui.updateTxOverlay('Finalizing transaction…');
    const conn = sdk.getConnection();
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('finalized');
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'finalized');
    ui.hideTxOverlay();
    ui.showCardStatus('dispute-status', 'Resolution updated! Dispute window restarted.', 'success');
    openMarketDetail(currentMarketPubkey);
  } catch (err) { ui.hideTxOverlay(); ui.showCardStatus('dispute-status', parseProgramError(err), 'error'); }
}

async function handleFinalize() {
  const w = wallet.getWallet(); const p = wallet.getProvider();
  if (!w || !p || !currentMarketPubkey) return;
  try {
    ui.showTxOverlay('Finalizing…');
    const ix = sdk.buildFinalizeMarket(currentMarketPubkey);
    ui.updateTxOverlay('Please approve…');
    const sig = await sdk.signAndSend(ix, w.publicKey, p, { skipEstimation: true, skipSimulation: true });
    ui.updateTxOverlay('Confirming transaction…');
    const conn = sdk.getConnection();
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('finalized');
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'finalized');
    ui.hideTxOverlay();
    ui.showCardStatus('finalize-status', 'Market finalized!', 'success');
    openMarketDetail(currentMarketPubkey);
  } catch (err) { ui.hideTxOverlay(); ui.showCardStatus('finalize-status', parseProgramError(err), 'error'); }
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
let currentPositionsSort = 'created-desc';
let currentPositionsTokenFilter = 'all';
let currentPositionsMakerFilter = 'all';
let posShowMineOnly = false;
let posShowStreetBetsOnly = false;

async function loadPositions() {
  const listEl = document.getElementById('positions-list');
  const w = wallet.getWallet();
  if (!w) {
    listEl.innerHTML = '<div class="empty-state">Connect your wallet to view positions.</div>';
    _positionEntries = [];
    const makerSel = document.getElementById('positions-maker-filter');
    if (makerSel) { makerSel.innerHTML = '<option value="all">All Makers</option>'; }
    _lastPosMakerSet = '';
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

    // Mark open markets past their deadline
    const posNowSec = BigInt(Math.floor(Date.now() / 1000));
    for (const mk of Object.values(marketMap)) {
      mk._expired = mk.status === 0 && mk.resolutionDeadline <= posNowSec;
    }

    // Street Bet detection for position markets
    const w2 = wallet.getWallet();
    const myAddr = w2 ? w2.publicKey.toBase58() : '';
    await Promise.all(marketAddrs.map(async (addr) => {
      const mk = marketMap[addr];
      if (!mk) return;
      const creationTime = await fetchCreationTime(addr);
      if (creationTime) {
        const runtime = Number(mk.resolutionDeadline) - creationTime;
        mk._isStreetBet = runtime > 0 && runtime <= STREET_BET_SECONDS;
      } else {
        mk._isStreetBet = false;
      }
    }));

    // Build position entries with market data attached
    const entries = positions.map(({ pubkey: posPk, account: pos }) => {
      const mk = marketMap[pos.market.toBase58()] || null;
      const { category } = mk ? ui.parseDescription(mk.description) : { category: null };
      const deadline = mk ? mk.resolutionDeadline : 0n;
      const status = mk ? mk.status : -1;
      const claimed = pos.claimed;

      // Compute payout estimate for sorting
      let payout = 0n;
      let isWinning = false;  // finalized/resolved winner
      let isLosing = false;   // finalized/resolved loser
      let isOpenWinning = false;  // open market, user's outcome is leading
      let isOpenLosing = false;   // open market, user's outcome is not leading
      if (mk && !claimed) {
        const pool = mk.outcomePools[pos.outcomeIndex];
        if (mk.status < 2 && pool > 0n && mk.totalPool > 0n) {
          const gross = (BigInt(pos.amount) * mk.totalPool) / pool;
          const fee = (gross * BigInt(mk.feeBps)) / 10000n;
          payout = gross - fee;
          // Determine if user's outcome is currently leading
          const maxPool = mk.outcomePools.reduce((a, b) => a > b ? a : b, 0n);
          isOpenWinning = pool === maxPool;
          isOpenLosing = pool !== maxPool;
        } else if (mk.status >= 1 && mk.status <= 2 && mk.winningOutcome === pos.outcomeIndex) {
          isWinning = true;
          const winPool = mk.outcomePools[mk.winningOutcome];
          if (winPool > 0n) {
            const gross = (BigInt(pos.amount) * mk.totalPool) / winPool;
            const fee = (gross * BigInt(mk.feeBps)) / 10000n;
            payout = gross - fee;
          }
        } else if (mk.status >= 1 && mk.status <= 2 && mk.winningOutcome !== pos.outcomeIndex) {
          isLosing = true;
        }
      }

      // Convert payout to USD for sorting
      let payoutUsd = 0;
      if (payout > 0n && mk) {
        const decimals = mk.denomination === 0 ? 9 : (mk.tokenDecimals || 9);
        const priceMint = mk.denomination === 0 ? SOL_MINT : mk.tokenMint.toBase58();
        const tokenPrice = posPrices.get(priceMint) || (mk.denomination !== 0 ? 1 : 0);
        payoutUsd = (Number(payout) / (10 ** decimals)) * tokenPrice;
      }

      return { posPk, pos, mk, market: pos.market, category, deadline, status, claimed, payout, payoutUsd, isWinning, isLosing, isOpenWinning, isOpenLosing, amount: pos.amount,
        isStreetBet: mk ? mk._isStreetBet === true : false,
        isMyMarket: mk && myAddr ? (mk.authority.toBase58() === myAddr || mk.creator.toBase58() === myAddr) : false,
      };
    });

    // Populate category filter dropdown
    const categories = [...new Set(entries.map(e => e.category).filter(Boolean))].sort();
    const filterEl = document.getElementById('positions-category-filter');
    if (filterEl) {
      const prev = currentPositionsCategoryFilter || filterEl.value;
      filterEl.innerHTML = '<option value="all">All Categories</option>'
        + categories.map(c => `<option value="${c}">${c}</option>`).join('');
      if (prev && [...filterEl.options].some(o => o.value === prev)) filterEl.value = prev;
      else { filterEl.value = 'all'; currentPositionsCategoryFilter = 'all'; }
    }

    // Populate maker filter dropdown
    populatePositionsMakerFilter(entries);

    renderPositionsList(entries, listEl);
    _positionEntries = entries;
    populatePositionsTokenFilter(entries);
    updatePosTokenChooserButton();
  } catch (err) {
    console.error(err);
    listEl.innerHTML = '<div class="empty-state">Failed to load positions.</div>';
  }
}

function renderPositionsList(entries, listEl) {
  let filtered = entries;

  // Token filter
  if (currentPositionsTokenFilter !== 'all') {
    if (currentPositionsTokenFilter === NATIVE_SOL_MINT) {
      filtered = filtered.filter(e => e.mk && e.mk.denomination === 0);
    } else {
      filtered = filtered.filter(e => e.mk && e.mk.tokenMint?.toBase58() === currentPositionsTokenFilter);
    }
  }

  // Maker filter
  if (currentPositionsMakerFilter !== 'all') {
    filtered = filtered.filter(e => e.mk && (e.mk.authority.toBase58() === currentPositionsMakerFilter || e.mk.creator.toBase58() === currentPositionsMakerFilter));
  }

  // My Markets toggle
  if (posShowMineOnly) {
    filtered = filtered.filter(e => e.isMyMarket);
  }

  // Street Bets toggle
  if (posShowStreetBetsOnly) {
    filtered = filtered.filter(e => e.isStreetBet);
  }

  // Category filter
  if (currentPositionsCategoryFilter !== 'all') {
    filtered = filtered.filter(e =>
      currentPositionsCategoryFilter === '__none' ? !e.category : e.category === currentPositionsCategoryFilter
    );
  }

  // Status filter
  if (currentPositionsStatusFilter === 'closed') {
    filtered = filtered.filter(e => e.status === 0 && e.mk && e.mk._expired);
  } else if (currentPositionsStatusFilter === 'ready') {
    const nowSec = Math.floor(Date.now() / 1000);
    filtered = filtered.filter(e => e.status === 1 && e.mk && nowSec >= Number(e.mk.resolvedAt) + 86400);
  } else if (currentPositionsStatusFilter !== 'all') {
    const statusVal = parseInt(currentPositionsStatusFilter);
    if (statusVal === 0) {
      filtered = filtered.filter(e => e.status === 0 && !(e.mk && e.mk._expired));
    } else if (statusVal === 1) {
      const nowSec = Math.floor(Date.now() / 1000);
      filtered = filtered.filter(e => e.status === 1 && e.mk && nowSec < Number(e.mk.resolvedAt) + 86400);
    } else {
      filtered = filtered.filter(e => e.status === statusVal);
    }
  }

  // Result filter
  if (currentPositionsResultFilter === 'unclaimed') {
    filtered = filtered.filter(e => !e.claimed && (
      (e.status === 2 && e.isWinning) ||  // Finalized + winning outcome
      (e.status === 3)                      // Voided (refund available)
    ));
  } else if (currentPositionsResultFilter === 'claimed') {
    filtered = filtered.filter(e => e.claimed);
  } else if (currentPositionsResultFilter === 'winning') {
    filtered = filtered.filter(e => e.isOpenWinning);
  } else if (currentPositionsResultFilter === 'losing') {
    filtered = filtered.filter(e => e.isOpenLosing);
  } else if (currentPositionsResultFilter === 'won') {
    filtered = filtered.filter(e => e.isWinning);
  } else if (currentPositionsResultFilter === 'lost') {
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
      filtered.sort((a, b) => b.payoutUsd - a.payoutUsd);
      break;
    case 'payout-asc':
      filtered.sort((a, b) => a.payoutUsd - b.payoutUsd);
      break;
    case 'status':
      filtered.sort((a, b) => a.status - b.status || Number(b.deadline - a.deadline));
      break;
    case 'created-desc':
      filtered.sort((a, b) => Number(b.pos.lastDepositAt - a.pos.lastDepositAt));
      break;
    case 'created-asc':
      filtered.sort((a, b) => Number(a.pos.lastDepositAt - b.pos.lastDepositAt));
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

  // Resolve SNS names for creator addresses
  ui.resolveSnsElements(listEl);
}

// Positions category filter - store entries globally for re-render
let _positionEntries = [];

// We handle re-render in the filter handler instead

// ── Positions Token Chooser ──────────────────────────────────────
// ── Positions Maker Filter ────────────────────────────────────────
let _lastPosMakerSet = '';

function populatePositionsMakerFilter(entries) {
  const sel = document.getElementById('positions-maker-filter');
  if (!sel) return;

  // Show all saved makers, not just those in current positions
  const savedAddrs = makers.getAll();
  const key = savedAddrs.sort().join(',');
  if (key === _lastPosMakerSet) return;
  _lastPosMakerSet = key;

  const prev = currentPositionsMakerFilter || sel.value;
  sel.innerHTML = '<option value="all">All Makers</option>';

  const savedMakers = savedAddrs.map(addr => [addr, addr.slice(0, 4) + '…' + addr.slice(-4)]);
  savedMakers.sort((a, b) => a[1].localeCompare(b[1]));

  for (const [addr, short] of savedMakers) {
    const opt = document.createElement('option');
    opt.value = addr;
    opt.textContent = short;
    sel.appendChild(opt);
  }

  if (savedAddrs.includes(prev)) sel.value = prev;
  else { sel.value = 'all'; currentPositionsMakerFilter = 'all'; }

  // Resolve SNS names
  import('./sns.js').then(sns => {
    for (const [addr] of savedMakers) {
      sns.resolveDisplayName(addr).then(name => {
        const opt = sel.querySelector(`option[value="${addr}"]`);
        if (opt) opt.textContent = name;
      });
    }
  });
}

let _lastPosTokenSet = '';

function populatePositionsTokenFilter(entries) {
  const dropdown = document.getElementById('pos-token-chooser-dropdown');
  if (!dropdown) return;

  // Gather unique token mints - count OPEN markets only
  const tokens = new Map();
  const seenMarkets = new Set();
  for (const { mk, pos } of entries) {
    if (!mk) continue;
    const marketAddr = pos.market?.toBase58?.() || '';
    const mint = mk.denomination === 0 ? NATIVE_SOL_MINT : mk.tokenMint.toBase58();
    if (!tokens.has(mint)) {
      tokens.set(mint, { count: 0, denomination: mk.denomination, denominationName: mk.denominationName });
    }
    // Count unique open markets per token
    const marketKey = `${mint}:${marketAddr}`;
    if (mk.status === 0 && !seenMarkets.has(marketKey)) {
      seenMarkets.add(marketKey);
      tokens.get(mint).count++;
    }
  }

  const key = [...tokens.keys()].sort().join(',');
  if (key === _lastPosTokenSet) return;
  _lastPosTokenSet = key;

  dropdown.innerHTML = '';

  // Search input
  const searchWrap = document.createElement('div');
  searchWrap.className = 'token-chooser-search';
  searchWrap.innerHTML = `<input type="text" class="token-search-input" placeholder="Search tokens..." autocomplete="off">`;
  dropdown.appendChild(searchWrap);

  // "All Tokens" option
  const allItem = document.createElement('div');
  allItem.className = `token-chooser-item${currentPositionsTokenFilter === 'all' ? ' active' : ''}`;
  allItem.dataset.mint = 'all';
  allItem.dataset.searchable = 'all tokens';
  allItem.innerHTML = `<span class="token-chooser-label">All Tokens</span>`;
  dropdown.appendChild(allItem);

  // Build sorted list: SOL first, then by count descending
  const tokenItems = [];

  if (tokens.has(NATIVE_SOL_MINT)) {
    tokenItems.push({ mint: NATIVE_SOL_MINT, info: tokens.get(NATIVE_SOL_MINT), isSol: true });
    tokens.delete(NATIVE_SOL_MINT);
  }

  const sorted = [...tokens.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [mint, info] of sorted) {
    tokenItems.push({ mint, info, isSol: false });
  }

  // Render items
  tokenItems.forEach(({ mint, info, isSol }, index) => {
    const item = document.createElement('div');
    item.className = `token-chooser-item${currentPositionsTokenFilter === mint ? ' active' : ''}`;
    item.dataset.mint = mint;

    if (isSol) {
      item.dataset.searchable = 'sol native solana';
      item.innerHTML = `
        <img class="token-icon" src="${SOL_ICON}" alt="SOL" onerror="this.style.display='none'">
        <span class="token-chooser-label">SOL <span class="token-chooser-sub">Native</span></span>
        <span class="token-chooser-count">${info.count}</span>
      `;
    } else {
      const shortMint = mint.slice(0, 4) + '…' + mint.slice(-4);
      const typeLabel = info.denominationName === 'Token2022' ? 'Token-2022' : 'SPL';
      item.dataset.searchable = `${shortMint} ${typeLabel}`;
      item.innerHTML = `
        <img class="token-icon" src="" alt="" style="display:none">
        <span class="token-chooser-label">
          <span class="token-symbol-name">Loading…</span>
          <a class="token-mint-link" href="https://solscan.io/token/${mint}" target="_blank" rel="noopener" title="${mint}">${shortMint}</a>
          <span class="token-chooser-sub">${typeLabel}</span>
        </span>
        <span class="token-chooser-count">${info.count}</span>
      `;

      fetchTokenIcon(mint).then(({ icon, name, symbol }) => {
        const img = item.querySelector('.token-icon');
        const label = item.querySelector('.token-symbol-name');
        if (icon) { img.src = icon; img.style.display = ''; }
        const displayName = symbol ? `${symbol}${name ? ' - ' + name : ''}` : shortMint;
        label.textContent = displayName;
        item.dataset.searchable = `${symbol || ''} ${name || ''} ${shortMint} ${typeLabel} ${mint}`.toLowerCase();
      });
    }

    // Hide items beyond top 5
    if (index >= 5) item.classList.add('token-overflow');

    dropdown.appendChild(item);
  });

  const visibleCount = dropdown.querySelectorAll('.token-chooser-item:not(.token-overflow)').length;
  dropdown.classList.toggle('scrollable', visibleCount > 10);

  // Search handler
  const searchInput = dropdown.querySelector('.token-search-input');
  searchInput?.addEventListener('input', () => {
    const query = searchInput.value.toLowerCase().trim();
    const items = dropdown.querySelectorAll('.token-chooser-item');
    let shown = 0;
    items.forEach(item => {
      if (item.dataset.mint === 'all') {
        item.style.display = query ? 'none' : '';
        return;
      }
      const match = !query || (item.dataset.searchable || '').includes(query);
      item.style.display = match ? '' : 'none';
      item.classList.toggle('token-overflow', false);
      if (match) shown++;
    });
    if (!query) {
      items.forEach((item, i) => {
        item.style.display = '';
        if (i > 5) item.classList.add('token-overflow');
        else item.classList.remove('token-overflow');
      });
    }
    dropdown.classList.toggle('scrollable', shown > 10);
  });

  searchInput?.addEventListener('click', (e) => e.stopPropagation());

  // Click handlers
  dropdown.querySelectorAll('.token-chooser-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.token-mint-link')) return;
      e.stopPropagation();
      currentPositionsTokenFilter = item.dataset.mint;
      saveFilters();
      updatePosTokenChooserButton();
      dropdown.classList.add('hidden');
      document.querySelector('.token-chooser-backdrop')?.remove();
      _lastPosTokenSet = '';
      populatePositionsTokenFilter(_positionEntries);
      reRenderPositions();
    });
  });
}

function updatePosTokenChooserButton() {
  const btn = document.getElementById('pos-token-chooser-btn');
  if (!btn) return;
  if (currentPositionsTokenFilter === 'all') {
    btn.textContent = 'All Tokens ▾';
    btn.classList.remove('token-active');
  } else if (currentPositionsTokenFilter === NATIVE_SOL_MINT) {
    btn.innerHTML = `<img class="token-icon-sm" src="${SOL_ICON}" alt="SOL"> SOL ▾`;
    btn.classList.add('token-active');
  } else {
    const cached = _tokenIconCache.get(currentPositionsTokenFilter);
    const short = currentPositionsTokenFilter.slice(0, 4) + '…' + currentPositionsTokenFilter.slice(-4);
    const label = cached?.symbol || short;
    if (cached?.icon) {
      btn.innerHTML = `<img class="token-icon-sm" src="${cached.icon}" alt="${label}"> ${label} ▾`;
    } else {
      btn.textContent = `${label} ▾`;
    }
    btn.classList.add('token-active');
  }
}

// Positions token chooser button toggle
document.getElementById('pos-token-chooser-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const dd = document.getElementById('pos-token-chooser-dropdown');
  if (!dd) return;
  dd.classList.toggle('hidden');
  let backdrop = document.querySelector('.token-chooser-backdrop');
  if (!dd.classList.contains('hidden')) {
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.className = 'token-chooser-backdrop';
      backdrop.addEventListener('click', () => {
        dd.classList.add('hidden');
        backdrop.remove();
      });
    }
    document.body.insertBefore(backdrop, dd);
  } else if (backdrop) {
    backdrop.remove();
  }
});

document.getElementById('pos-token-chooser-dropdown')?.addEventListener('click', (e) => {
  e.stopPropagation();
});

async function claimWinnings(posAddr, mktAddr) {
  const w = wallet.getWallet(); const p = wallet.getProvider();
  if (!w || !p) return;
  const statusEl = document.querySelector(`.claim-status[data-position="${posAddr}"]`);
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

      // DEBUG: log all accounts for PDA verification
      console.log('=== ClaimWinnings DEBUG ===');
      console.log('denomination:', market.denomination, market.denominationName);
      console.log('market:', mk.toBase58());
      console.log('vault:', vault.toBase58());
      console.log('position:', posAddr);
      console.log('claimant:', w.publicKey.toBase58());
      console.log('protocolConfig:', pc.toBase58());
      console.log('treasury:', config.treasury.toBase58());
      console.log('creator:', market.creator.toBase58());
      console.log('claimantAta:', claimantAta.toBase58());
      console.log('treasuryAta:', treasuryAta.toBase58());
      console.log('creatorAta:', creatorAta.toBase58());
      console.log('vaultAuthority:', vaultAuthority.toBase58());
      console.log('tokenMint:', tokenMint.toBase58());
      console.log('tokenProgram:', tokenProgramId.toBase58());
      console.log('winningOutcome:', market.winningOutcome);
      console.log('=== END DEBUG ===');
    }

    const ix = sdk.buildClaimWinnings(accounts);
    ui.updateTxOverlay('Please approve…');
    const sig = await sdk.signAndSend(ix, w.publicKey, p);
    ui.updateTxOverlay('Confirming transaction…');
    const conn = sdk.getConnection();
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('finalized');
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'finalized');
    ui.hideTxOverlay();
    if (statusEl) { statusEl.textContent = 'Winnings claimed!'; statusEl.className = 'claim-status bet-status success'; statusEl.classList.remove('hidden'); }
    loadPositions();
  } catch (err) {
    ui.hideTxOverlay();
    if (statusEl) { statusEl.textContent = parseProgramError(err); statusEl.className = 'claim-status bet-status error'; statusEl.classList.remove('hidden'); }
  }
}

async function claimRefund(posAddr, mktAddr) {
  const w = wallet.getWallet(); const p = wallet.getProvider();
  if (!w || !p) return;
  const statusEl = document.querySelector(`.claim-status[data-position="${posAddr}"]`);
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
    const sig = await sdk.signAndSend(ix, w.publicKey, p);
    ui.updateTxOverlay('Confirming transaction…');
    const conn = sdk.getConnection();
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('finalized');
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'finalized');
    ui.hideTxOverlay();
    if (statusEl) { statusEl.textContent = 'Refund claimed!'; statusEl.className = 'claim-status bet-status success'; statusEl.classList.remove('hidden'); }
    loadPositions();
  } catch (err) {
    ui.hideTxOverlay();
    if (statusEl) { statusEl.textContent = parseProgramError(err); statusEl.className = 'claim-status bet-status error'; statusEl.classList.remove('hidden'); }
  }
}

// ═══════════════════════════════════════════════════════════════════
// Create Market View
// ═══════════════════════════════════════════════════════════════════
async function updateCreateForm() {
  const btn = document.getElementById('create-market-btn');
  const w = wallet.getWallet();
  const pauseNotice = document.getElementById('create-pause-notice');
  const form = document.querySelector('.create-form');

  // Check protocol pause status
  let paused = false;
  try {
    const config = await sdk.fetchProtocolConfig();
    if (config?.paused) paused = true;
  } catch {}

  if (paused) {
    pauseNotice?.classList.remove('hidden');
    btn.textContent = 'Protocol Paused';
    btn.disabled = true;
    form?.querySelectorAll('input, select, textarea, button:not(#create-market-btn)').forEach(el => el.disabled = true);
  } else {
    pauseNotice?.classList.add('hidden');
    btn.textContent = w ? 'Create Market' : 'Connect Wallet to Create';
    btn.disabled = !w;
    form?.querySelectorAll('input, select, textarea, button').forEach(el => el.disabled = false);
    if (!w) btn.disabled = true;
    updateGateWarning('create-gate-warning', w);
  }
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
  document.getElementById('mint-validation-warning')?.classList.add('hidden');
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
  const warning = document.getElementById('mint-validation-warning');

  // Show loader
  loader.classList.remove('hidden');
  warning?.classList.add('hidden');
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

  // Validate Token-2022 extensions if denomination is Token-2022
  const denomSelect = document.getElementById('create-denomination');
  const denomination = denomSelect ? parseInt(denomSelect.value) : 0;
  if (denomination === 2) {
    try {
      const mintPubkey = new PublicKey(mint);
      sdk.validateTokenMint(mintPubkey).then(result => {
        if (!result.ok) {
          const blockedNames = result.blocked.map(b => b.name || b.error).join(', ');
          warning.textContent = `Blocked extension${result.blocked.length > 1 ? 's' : ''}: ${blockedNames}. This token cannot be used for markets.`;
          warning.classList.remove('hidden');
        } else {
          warning.classList.add('hidden');
        }
      }).catch(() => {
        // Mint fetch failed - will fail at create time anyway
      });
    } catch {
      // Invalid pubkey - ignore
    }
  }
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
  // Check protocol pause
  try {
    const config = await sdk.fetchProtocolConfig();
    if (config?.paused) { showCreateError('Market creation is temporarily disabled by the protocol admin.'); return; }
  } catch {}
  if (gateEnabled && !(await checkGate(w.publicKey))) {
    let msg = 'Token-gated: you must hold one of the required tokens.';
    try {
      const tokens = await getGateTokenInfo();
      if (tokens.length) {
        const names = tokens.map(t => t.symbol !== t.mint
          ? `<a href="${GATE_SWAP_URL}" target="_blank" rel="noopener" style="color:var(--gold)">${t.name} (${t.symbol})</a>`
          : `<code>${t.mint}</code>`);
        msg = `Token required: hold any amount of ${names.join(' or ')} to participate.`;
      }
    } catch { /* use generic */ }
    showCreateError(msg);
    return;
  }
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
    if (!config) { showCreateError('Protocol not initialized'); ui.hideTxOverlay(); return; }

    // Find the next available market ID - skip any PDAs that already exist on-chain
    let marketId = config.totalMarketsCreated + 1n;
    let market, vault;
    const conn = sdk.getConnection();
    for (let attempt = 0; attempt < 20; attempt++) {
      [market] = await sdk.findMarket(w.publicKey, marketId);
      const info = await conn.getAccountInfo(market);
      if (!info) break; // PDA is free
      marketId++;
    }
    [vault] = await sdk.findVault(market);

    // Total fee = protocol default + creator's additional fee
    const feeBpsOverride = creatorFee > 0
      ? config.defaultFeeBps + creatorFee
      : null;
    const [protocolConfig] = await sdk.findProtocolConfig();

    const accounts = { market, vault, authority: w.publicKey, payer: w.publicKey, protocolConfig };
    const ixList = [];

    // For SPL/Token-2022 markets, pass token accounts
    // The program creates and initializes the token vault itself via CPI
    // tokenVault uses the SAME PDA as vault: [VAULT_SEED, market]
    if (denomination === 1 || denomination === 2) {
      const mintAddr = document.getElementById('create-token-mint')?.value.trim();
      if (!mintAddr || mintAddr.length < 32) { ui.hideTxOverlay(); return showCreateError('Token mint address is required'); }
      const tokenMint = new PublicKey(mintAddr);
      const tokenProgramId = denomination === 1 ? sdk.TOKEN_PROGRAM_ID : sdk.TOKEN_2022_PROGRAM_ID;

      // Validate Token-2022 mint extensions before building tx
      if (denomination === 2) {
        try {
          const validation = await sdk.validateTokenMint(tokenMint);
          if (!validation.ok) {
            const blockedNames = validation.blocked.map(b => b.name || b.error).join(', ');
            ui.hideTxOverlay();
            return showCreateError(`Blocked extension${validation.blocked.length > 1 ? 's' : ''}: ${blockedNames}. This token cannot be used for markets.`);
          }
        } catch (e) {
          ui.hideTxOverlay();
          return showCreateError(`Failed to validate token mint: ${e.message}`);
        }
      }

      const [vaultAuthority] = await sdk.findVaultAuthority(market);

      accounts.tokenMint = tokenMint;
      accounts.vaultAuthority = vaultAuthority;
      accounts.tokenVault = vault; // Same PDA as vault - program creates it as a token account
      accounts.tokenProgram = tokenProgramId;
    }

    const createIx = sdk.buildCreateMarket(
      accounts,
      { marketId, title, description, outcomeLabels, resolutionDeadline: deadline, feeBpsOverride, denomination, authorityIsMultisig: false }
    );
    ixList.push(createIx);

    ui.updateTxOverlay('Please approve…');
    const sig = await sdk.signAndSend(ixList, w.publicKey, p);
    ui.updateTxOverlay('Finalizing transaction…');
    // Wait for finalized confirmation before navigating
    const { blockhash: finBh, lastValidBlockHeight: finH } = await conn.getLatestBlockhash('finalized');
    await conn.confirmTransaction({ signature: sig, blockhash: finBh, lastValidBlockHeight: finH }, 'finalized');
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
    // Navigate to the new market's detail page
    openMarketDetail(market);
  } catch (err) {
    ui.hideTxOverlay();
    showCreateError(parseProgramError(err));
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
      // Not initialized - show init form
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

    // Initialized - hide init form, show stats
    initPanel.classList.add('hidden');
    document.getElementById('admin-total-markets').textContent = Number(config.totalMarketsCreated);
    document.getElementById('admin-total-volume').textContent = ui.formatSol(config.totalVolume);
    document.getElementById('admin-default-fee').textContent = `${config.defaultFeeBps / 100}%`;
    document.getElementById('admin-paused').textContent = config.paused ? 'Yes' : 'No';
    document.getElementById('admin-treasury').textContent = config.treasury.toBase58();
    document.getElementById('admin-program').textContent = PROGRAM_ID.toBase58();

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
    ui.showCardStatus('admin-status', newPaused ? 'Protocol paused' : 'Protocol unpaused', 'success');
    loadAdmin();
  } catch (err) {
    ui.hideTxOverlay();
    ui.showCardStatus('admin-status', parseProgramError(err), 'error');
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
    ui.showCardStatus('admin-status', 'Fee must be 0–10000 bps', 'error');
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
    ui.showCardStatus('admin-status', `Default fee updated to ${feeBps / 100}%`, 'success');
    feeInput.value = '';
    loadAdmin();
  } catch (err) {
    ui.hideTxOverlay();
    ui.showCardStatus('admin-status', parseProgramError(err), 'error');
  }
});

// Update treasury handler
document.getElementById('admin-update-treasury-btn')?.addEventListener('click', async () => {
  const w = wallet.getWallet();
  const p = wallet.getProvider();
  if (!w || !p) return;

  const input = document.getElementById('admin-update-treasury').value.trim();
  if (!input) {
    ui.showCardStatus('admin-status', 'Enter a treasury address', 'error');
    return;
  }

  let newTreasury;
  try { newTreasury = new PublicKey(input); }
  catch {
    ui.showCardStatus('admin-status', 'Invalid treasury address', 'error');
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
    ui.showCardStatus('admin-status', 'Treasury updated', 'success');
    document.getElementById('admin-update-treasury').value = '';
    loadAdmin();
  } catch (err) {
    ui.hideTxOverlay();
    ui.showCardStatus('admin-status', parseProgramError(err), 'error');
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
    statusEl.textContent = 'Protocol initialized successfully!';
    statusEl.className = 'form-status success';
    statusEl.classList.remove('hidden');
    // Reload admin view to show stats
    loadAdmin();
  } catch (err) {
    ui.hideTxOverlay();
    statusEl.textContent = parseProgramError(err);
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

// Nav bar share - shares current page URL
document.getElementById('nav-share-btn')?.addEventListener('click', () => {
  const url = window.location.href;
  const hash = window.location.hash;
  let title = 'Precog Markets';
  let text = 'Check out Precog Markets';
  if (hash.startsWith('#/market/') && currentMarketData) {
    title = currentMarketData.title;
    text = currentMarketData.title + ' - Precog Markets';
  }
  shareContent(title, text, url);
});

// Detail share - wired up in attachDetailListeners

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
    ${watchlist.sortedCategories(categories).map(cat => `
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

  list.innerHTML = watchlist.sortedCategories(categories).map(cat => {
    const count = Object.values(meta).filter(m => m.category === cat).length;
    const isProtected = watchlist.isProtected(cat);
    return `
      <div class="category-item" data-cat="${cat}">
        <span class="category-item-name">${cat}${isProtected ? ' 🔒' : ''}</span>
        <span class="category-item-count">${count} market${count !== 1 ? 's' : ''}</span>
        ${isProtected ? '' : '<button class="category-item-btn rename-cat-btn" title="Rename">✎</button>'}
        ${isProtected ? '' : '<button class="category-item-btn danger remove-cat-btn" title="Delete">×</button>'}
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

    // Mark open markets past their deadline
    const wlNowSec = BigInt(Math.floor(Date.now() / 1000));
    for (const { account } of cards) {
      account._expired = account.status === 0 && account.resolutionDeadline <= wlNowSec;
    }

    const categories = watchlist.sortedCategories(watchlist.getCategories());
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

    // Resolve SNS names for creator addresses
    ui.resolveSnsElements(listEl);
  } catch (err) {
    console.error('Watchlist load error:', err);
    listEl.innerHTML = '<div class="empty-state">Failed to load watchlist.</div>';
  }
}

// Clear watchlist button (now in manage categories panel)
document.getElementById('clear-watchlist-btn')?.addEventListener('click', () => {
  if (!confirm('Clear your entire watchlist? This removes ALL markets from every category.')) return;
  watchlist.clearMarkets();
  renderCategoryTabs();
  document.getElementById('watchlist-list').innerHTML = '<div class="empty-state">No markets in your watchlist.</div>';
});

// Clear trash button
document.getElementById('clear-trash-btn')?.addEventListener('click', () => {
  const trashCount = watchlist.getByCategory('Trash').length;
  if (trashCount === 0) { ui.showStatus('Trash is empty.', 'info'); return; }
  if (!confirm(`Remove ${trashCount} market${trashCount !== 1 ? 's' : ''} from Trash?`)) return;
  watchlist.clearTrash();
  renderCategoryTabs();
  loadWatchlist();
});

// Export watchlist
document.getElementById('export-watchlist-btn')?.addEventListener('click', () => {
  const data = watchlist.exportData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'precog-watchlist.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  ui.showStatus('Watchlist exported!', 'success');
});

// Import watchlist
document.getElementById('import-watchlist-btn')?.addEventListener('click', () => {
  document.getElementById('import-watchlist-file')?.click();
});
document.getElementById('import-watchlist-file')?.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const imported = JSON.parse(reader.result);
      const result = watchlist.importData(imported);
      const parts = [];
      if (result.marketsAdded) parts.push(`${result.marketsAdded} market${result.marketsAdded !== 1 ? 's' : ''} added`);
      if (result.marketsUpdated) parts.push(`${result.marketsUpdated} updated`);
      if (result.categoriesAdded) parts.push(`${result.categoriesAdded} categor${result.categoriesAdded !== 1 ? 'ies' : 'y'} added`);
      const msg = parts.length > 0 ? `Import complete: ${parts.join(', ')}.` : 'Nothing new to import.';
      ui.showStatus(msg, 'success');
      renderCategoryTabs();
      renderCategoryManager();
      loadWatchlist();
    } catch (err) {
      ui.showStatus('Invalid watchlist file.', 'error');
    }
    e.target.value = '';
  };
  reader.readAsText(file);
});

// ═══════════════════════════════════════════════════════════════════
// Wallet Integration
// ═══════════════════════════════════════════════════════════════════
function setupWallet() {
  wallet.onWalletChange(async (ctx) => {
    if (ctx) {
      const disconnectBtn = ui.renderWalletConnected(ctx.publicKey);
      disconnectBtn.addEventListener('click', wallet.disconnect);
      const indicator = document.getElementById('network-indicator');
      indicator?.classList.add('connected');
      indicator?.classList.remove('gated');
      // Check gate status for indicator color
      if (gateEnabled) {
        try {
          const passed = await checkGate(ctx.publicKey);
          indicator?.classList.toggle('gated', !passed);
        } catch {
          indicator?.classList.add('gated');
        }
      }
      // Check if connected wallet is admin
      sdk.fetchProtocolConfig().then(config => {
        const adminLink = document.querySelector('.footer-admin-link');
        if (adminLink) {
          adminLink.classList.toggle('hidden', !config || config.admin.toBase58() !== ctx.publicKey.toBase58());
        }
      }).catch(() => {});
    } else {
      const isMob = wallet.isMobile() && !wallet.isWalletBrowser();
      ui.renderWalletDisconnected(wallet.getAvailableWallets(), isMob);
      attachConnectListeners();
      document.getElementById('network-indicator')?.classList.remove('connected', 'gated');
      // Hide admin link on disconnect
      document.querySelector('.footer-admin-link')?.classList.add('hidden');
      clearGateCache();
    }
    // Refresh current view
    refreshUserPositions().then(() => {
      const activeNav = document.querySelector('.nav-btn.active');
      if (activeNav) {
        const view = activeNav.dataset.view;
        if (view === 'explore') renderMarketsList(false);
        if (view === 'positions') loadPositions();
        if (view === 'make') updateCreateForm();
        if (view === 'watchlist') loadWatchlist();
        if (view === 'admin') loadAdmin();
      }
      // Re-render market detail if currently viewing one
      if (currentMarketPubkey && !document.getElementById('view-market')?.classList.contains('hidden')) {
        openMarketDetail(currentMarketPubkey);
      }
    });
    // Update detail view bet button
    updateBetUI();
    // Refresh gate warnings on any visible gated cards
    const w = wallet.getWallet();
    updateGateWarning('bet-gate-warning', w);
    updateGateWarning('create-gate-warning', w);
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

  // iOS mobile (not in wallet browser): show deep link chooser
  if (isMob && wallet.isIOS()) {
    const iosOptions = wallet.getIOSWalletOptions();
    const dropdown = document.createElement('div');
    dropdown.id = 'ios-wallet-dropdown';
    dropdown.className = 'ios-wallet-dropdown hidden';
    dropdown.innerHTML = iosOptions.map((w, i) => `
      <a class="ios-wallet-option" href="${w.browseUrl}" rel="noopener">
        <img class="ios-wallet-icon" src="${w.icon}" alt="${w.name}" onerror="this.style.display='none'">
        <span class="ios-wallet-name">${w.name}</span>
      </a>
    `).join('');
    connectBtn.parentElement.style.position = 'relative';
    connectBtn.parentElement.appendChild(dropdown);

    connectBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('hidden');
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#ios-wallet-dropdown') && !e.target.closest('#connect-wallet-btn')) {
        dropdown.classList.add('hidden');
      }
    });
    return;
  }

  // Android mobile: MWA flow
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
// Settings Page
// ═══════════════════════════════════════════════════════════════════
function renderSettingsPage() {
  // Update notification toggle state
  const toggleBtn = document.getElementById('notification-toggle');
  const statusEl = document.getElementById('notification-status');
  if (toggleBtn) {
    toggleBtn.classList.toggle('active', notifications.isEnabled());
    if (statusEl) {
      if (typeof Notification === 'undefined') {
        statusEl.textContent = 'Notifications are not supported in this browser.';
      } else if (Notification.permission === 'denied') {
        statusEl.textContent = 'Notifications are blocked. Enable them in your browser settings.';
      } else if (notifications.isEnabled()) {
        statusEl.textContent = 'Listening for events on your watchlisted markets.';
        statusEl.style.color = 'var(--green)';
      } else {
        statusEl.textContent = '';
        statusEl.style.color = '';
      }
    }
  }

  // Update RPC override state
  const rpcInput = document.getElementById('rpc-override-input');
  const rpcToggle = document.getElementById('rpc-override-toggle');
  const rpcStatus = document.getElementById('rpc-override-status');
  if (rpcInput) {
    const savedUrl = localStorage.getItem('precog_rpc_override') || '';
    const enabled = localStorage.getItem('precog_rpc_enabled') === 'true';
    rpcInput.value = savedUrl;
    rpcToggle?.classList.toggle('active', enabled && !!savedUrl);
    if (rpcStatus) {
      if (enabled && savedUrl) {
        rpcStatus.textContent = 'Using custom RPC';
        rpcStatus.style.color = 'var(--green)';
      } else if (savedUrl) {
        rpcStatus.textContent = 'Custom RPC saved but disabled';
        rpcStatus.style.color = '';
      } else {
        rpcStatus.textContent = 'Using default RPC';
        rpcStatus.style.color = '';
      }
    }
  }

  const listEl = document.getElementById('makers-list');
  if (!listEl) return;

  const allMakers = makers.getAllWithMeta();
  const addrs = Object.keys(allMakers).sort();

  if (addrs.length === 0) {
    listEl.innerHTML = '<div class="empty-state" style="padding:12px 0;font-size:0.78rem">No saved makers yet. Visit a market detail page and tap the + button next to a Maker to save them.</div>';
    return;
  }

  listEl.innerHTML = '';
  for (const addr of addrs) {
    const meta = allMakers[addr];
    const short = addr.slice(0, 4) + '…' + addr.slice(-4);
    const item = document.createElement('div');
    item.className = 'maker-item';
    item.innerHTML = `
      <span class="maker-item-name sns-resolve" data-address="${addr}">${short}</span>
      <span class="maker-item-address">${addr}</span>
      <button class="maker-remove-btn" data-address="${addr}" title="Remove">✕</button>
    `;
    listEl.appendChild(item);
  }

  // Resolve SNS names
  ui.resolveSnsElements(listEl);

  // Remove handlers
  listEl.querySelectorAll('.maker-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      makers.remove(btn.dataset.address);
      renderSettingsPage();
      _lastCreatorSet = '';
      _lastPosMakerSet = '';
      populateCreatorFilter();
      if (_positionEntries.length > 0) populatePositionsMakerFilter(_positionEntries);
    });
  });
}

// Settings export/import
// Notification toggle
document.getElementById('notification-toggle')?.addEventListener('click', async () => {
  if (notifications.isEnabled()) {
    notifications.disable();
  } else {
    await notifications.enable();
  }
  renderSettingsPage();
});

// RPC Override handlers
document.getElementById('rpc-override-save')?.addEventListener('click', () => {
  const url = document.getElementById('rpc-override-input')?.value.trim();
  if (!url) return;
  try { new URL(url); } catch { alert('Invalid URL'); return; }
  localStorage.setItem('precog_rpc_override', url);
  localStorage.setItem('precog_rpc_enabled', 'true');
  sdk.resetConnection();
  renderSettingsPage();
});

document.getElementById('rpc-override-toggle')?.addEventListener('click', () => {
  const savedUrl = localStorage.getItem('precog_rpc_override');
  if (!savedUrl) return;
  const enabled = localStorage.getItem('precog_rpc_enabled') === 'true';
  localStorage.setItem('precog_rpc_enabled', enabled ? 'false' : 'true');
  sdk.resetConnection();
  renderSettingsPage();
});

document.getElementById('rpc-override-remove')?.addEventListener('click', () => {
  localStorage.removeItem('precog_rpc_override');
  localStorage.removeItem('precog_rpc_enabled');
  const input = document.getElementById('rpc-override-input');
  if (input) input.value = '';
  sdk.resetConnection();
  renderSettingsPage();
});

document.getElementById('makers-export-btn')?.addEventListener('click', () => {
  const data = makers.exportData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${Math.floor(Date.now() / 1000)}-makers.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

document.getElementById('makers-import-input')?.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const statusEl = document.getElementById('makers-import-status');
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const imported = JSON.parse(reader.result);
      const result = makers.importData(imported);
      statusEl.textContent = `Imported: ${result.added} added, ${result.skipped} skipped.`;
      statusEl.style.color = 'var(--green)';
      renderSettingsPage();
      _lastCreatorSet = '';
      _lastPosMakerSet = '';
    } catch (err) {
      statusEl.textContent = parseProgramError(err);
      statusEl.style.color = 'var(--red)';
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

// ═══════════════════════════════════════════════════════════════════
// Navigation
// ═══════════════════════════════════════════════════════════════════
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});
document.querySelector('.logo-btn')?.addEventListener('click', () => switchView('explore'));

// WUT? TOC smooth scroll (avoids hash router conflicts)
document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-scroll-to]');
  if (!link) return;
  e.preventDefault();
  const target = document.getElementById(link.dataset.scrollTo);
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// Legal page links and back buttons
document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-view]');
  if (!link) return;
  e.preventDefault();
  const view = link.dataset.view;
  if (viewNames.includes(view)) switchView(view);
});

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
 *   #/make             → Make Market view
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
  loadFilters();
  applyFiltersToDOM();
  setupWallet();

  // Initialize notifications
  notifications.init(sdk.getConnection());

  // Initial wallet render
  const isMob = wallet.isMobile() && !wallet.isWalletBrowser();
  ui.renderWalletDisconnected(wallet.getAvailableWallets(), isMob);
  attachConnectListeners();

  // Try silent reconnect
  await wallet.trySilentConnect();

  // Route based on initial URL hash (handles direct links like #/market/<addr>)
  const hash = window.location.hash || '';
  if (hash.startsWith('#/market/')) {
    // Let handleRoute open the market directly - skip loadMarkets first
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