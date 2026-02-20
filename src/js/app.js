/**
 * @module app
 * Main application controller.
 */
import { Buffer } from 'buffer';
window.Buffer = Buffer;

import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { PROGRAM_ID, MARKET_POLL_MS } from './config.js';
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
let pollInterval = null;

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
    allMarkets = await sdk.fetchAllMarkets();
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
    case 'volume': filtered.sort((a, b) => Number(b.account.totalPool - a.account.totalPool)); break;
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
}

/** Append market cards for a range of filteredMarkets */
function appendMarketCards(listEl, markets, start, end) {
  for (let i = start; i < end; i++) {
    const { pubkey, account } = markets[i];
    const card = ui.renderMarketCard(pubkey, account);
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
    const card = ui.renderMarketCard(pubkey, account);
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
let exploreChartRendered = false;
document.getElementById('explore-chart-toggle')?.addEventListener('click', () => {
  const wrap = document.getElementById('explore-chart-wrap');
  const btn = document.getElementById('explore-chart-toggle');
  const isHidden = wrap.classList.toggle('hidden');
  btn.textContent = isHidden ? '▸ Show Hot Markets' : '▾ Hide Hot Markets';
  btn.classList.toggle('open', !isHidden);
  if (!isHidden && !exploreChartRendered && allMarkets.length > 0) {
    ui.renderVolumeChart(allMarkets);
    exploreChartRendered = true;
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
    currentMarketData = market;
    const w = wallet.getWallet();
    el.innerHTML = ui.renderMarketDetail(pubkey, market, w?.publicKey);
    // Charts render on demand via toggle
    attachDetailListeners(pubkey, market);
  } catch (err) {
    console.error(err);
    el.innerHTML = '<div class="empty-state">Failed to load market.</div>';
  }
}

function attachDetailListeners(pubkey, market) {
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

  // Detail charts toggle
  let detailChartsRendered = false;
  document.getElementById('detail-chart-toggle')?.addEventListener('click', () => {
    const wrap = document.getElementById('detail-charts-wrap');
    const btn = document.getElementById('detail-chart-toggle');
    const isHidden = wrap.classList.toggle('hidden');
    btn.textContent = isHidden ? '▸ Show Charts' : '▾ Hide Charts';
    btn.classList.toggle('open', !isHidden);
    if (!isHidden && !detailChartsRendered) {
      ui.renderDetailCharts(market);
      detailChartsRendered = true;
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
  else { btn.textContent = 'Place Bet'; btn.disabled = false; }
  // Payout estimate
  const est = document.getElementById('bet-payout-estimate');
  if (!est || !currentMarketData || selectedOutcome === null || !amount || amount <= 0) { est?.classList.add('hidden'); return; }
  const lam = sdk.solToLamports(amount);
  const newPool = currentMarketData.outcomePools[selectedOutcome] + lam;
  const newTotal = currentMarketData.totalPool + lam;
  const pay = sdk.calculatePayout(lam, newPool, newTotal, currentMarketData.feeBps);
  est.classList.remove('hidden');
  const v = est.querySelector('.bet-payout-value');
  if (v) v.textContent = ui.formatSol(pay);
}

async function handlePlaceBet() {
  const w = wallet.getWallet(); const p = wallet.getProvider();
  if (!w || !p || selectedOutcome === null || !currentMarketPubkey) return;
  const amount = parseFloat(document.getElementById('bet-amount-input').value);
  if (!amount || amount <= 0) return;
  try {
    ui.showTxOverlay('Building transaction…');
    const lam = sdk.solToLamports(amount);
    const [vault] = await sdk.findVault(currentMarketPubkey);
    const [position] = await sdk.findPosition(currentMarketPubkey, w.publicKey, selectedOutcome);
    const ix = sdk.buildPlaceBet(
      { market: currentMarketPubkey, vault, position, bettor: w.publicKey },
      { outcomeIndex: selectedOutcome, amount: lam }
    );
    ui.updateTxOverlay('Please approve…');
    const sig = await sdk.signAndSend(ix, w.publicKey, p);
    ui.hideTxOverlay();
    ui.showStatus(`Bet placed! ${sig.slice(0, 8)}…`, 'success');
    openMarketDetail(currentMarketPubkey);
  } catch (err) {
    ui.hideTxOverlay();
    ui.showStatus(err.message || 'Bet failed', 'error');
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
    await sdk.signAndSend(ix, w.publicKey, p);
    ui.hideTxOverlay(); ui.showStatus('Market resolved!', 'success');
    openMarketDetail(currentMarketPubkey);
  } catch (err) { ui.hideTxOverlay(); ui.showStatus(err.message || 'Resolve failed', 'error'); }
}

async function handleVoid() {
  const w = wallet.getWallet(); const p = wallet.getProvider();
  if (!w || !p || !currentMarketPubkey) return;
  if (!confirm('Void this market? All bets refunded.')) return;
  try {
    ui.showTxOverlay('Voiding…');
    const ix = sdk.buildVoidMarket({ market: currentMarketPubkey, authority: w.publicKey });
    ui.updateTxOverlay('Please approve…');
    await sdk.signAndSend(ix, w.publicKey, p);
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
    await sdk.signAndSend(ix, w.publicKey, p);
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
      listEl.innerHTML = '<div class="empty-state">No positions found. Place a bet to get started!</div>';
      return;
    }
    const marketAddrs = [...new Set(positions.map(p => p.account.market.toBase58()))];
    const marketMap = {};
    for (const addr of marketAddrs) {
      try { const mk = await sdk.fetchMarket(new PublicKey(addr)); if (mk) marketMap[addr] = mk; } catch {}
    }
    listEl.innerHTML = '';
    for (const { pubkey: posPk, account: pos } of positions) {
      const mk = marketMap[pos.market.toBase58()] || null;
      const card = ui.renderPositionCard(posPk, pos, mk, pos.market);
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
  } catch (err) {
    console.error(err);
    listEl.innerHTML = '<div class="empty-state">Failed to load positions.</div>';
  }
}

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
    const ix = sdk.buildClaimWinnings({
      market: mk, vault, position: new PublicKey(posAddr),
      claimant: w.publicKey, protocolConfig: pc, treasury: config.treasury,
    });
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
    const ix = sdk.buildClaimRefund({
      market: mk, vault, position: new PublicKey(posAddr), claimant: w.publicKey,
    });
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
  el.textContent = msg; el.className = 'form-status error'; el.classList.remove('hidden');
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
});

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
  const feeBps = feeInput ? parseInt(feeInput) : null;
  if (feeBps !== null && (feeBps < 0 || feeBps > 500)) return showCreateError('Fee must be 0–500 bps');

  try {
    ui.showTxOverlay('Creating market…');
    const config = await sdk.fetchProtocolConfig();
    const marketId = config ? config.totalMarketsCreated + 1n : 1n;
    const [market] = await sdk.findMarket(w.publicKey, marketId);
    const [vault] = await sdk.findVault(market);
    const [protocolConfig] = await sdk.findProtocolConfig();
    const ix = sdk.buildCreateMarket(
      { market, vault, authority: w.publicKey, payer: w.publicKey, protocolConfig },
      { marketId, title, description, outcomeLabels, resolutionDeadline: deadline, feeBpsOverride: feeBps, denomination, authorityIsMultisig: false }
    );
    ui.updateTxOverlay('Please approve…');
    const sig = await sdk.signAndSend(ix, w.publicKey, p);
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
    el.textContent = `Market created: ${market.toBase58()}`; el.className = 'form-status success'; el.classList.remove('hidden');
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
  const initBtn = document.getElementById('init-protocol-btn');
  const w = wallet.getWallet();

  try {
    const config = await sdk.fetchProtocolConfig();
    if (!config) {
      // Not initialized — show init form
      initPanel.classList.remove('hidden');
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
  } catch (err) {
    console.error('Admin load error:', err);
  }
}

// Initialize protocol handler
document.getElementById('init-protocol-btn')?.addEventListener('click', handleInitProtocol);

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

    const categories = watchlist.getCategories();
    listEl.innerHTML = '';
    for (const { pubkey, account, address: addr } of cards) {
      const card = ui.renderMarketCard(pubkey, account);

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
    const activeNav = document.querySelector('.nav-btn.active');
    if (activeNav) {
      const view = activeNav.dataset.view;
      if (view === 'positions') loadPositions();
      if (view === 'create') updateCreateForm();
    }
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
 *   #/positions        → My Bets view
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