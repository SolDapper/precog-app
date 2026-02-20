/**
 * @module ui
 * DOM rendering helpers for market cards, detail views, positions, etc.
 */
import { lamportsToSol, getImpliedProbabilities } from './sdk.js';
import { resolveDisplayName, shortAddress } from './sns.js';
import * as watchlist from './watchlist.js';

// ═══════════════════════════════════════════════════════════════════
// Category Parser
// ═══════════════════════════════════════════════════════════════════

const CAT_TAG = '[:cat:]';

/**
 * Parse a description that may contain an embedded category.
 * Format: "CategoryName[:cat:]Actual description text"
 * @param {string} raw - The raw description from on-chain
 * @returns {{ category: string|null, description: string }}
 */
export function parseDescription(raw) {
  if (!raw) return { category: null, description: '' };
  const idx = raw.indexOf(CAT_TAG);
  if (idx === -1) return { category: null, description: raw };
  const category = raw.slice(0, idx).trim();
  const description = raw.slice(idx + CAT_TAG.length).trim();
  return { category: category || null, description };
}

/**
 * Encode category + description into the on-chain format.
 * @param {string} category
 * @param {string} description
 * @returns {string}
 */
export function encodeDescription(category, description) {
  if (!category || !category.trim()) return description;
  return category.trim() + CAT_TAG + description;
}

// ═══════════════════════════════════════════════════════════════════
// Formatting
// ═══════════════════════════════════════════════════════════════════

export function formatSol(lamports) {
  const sol = lamportsToSol(lamports);
  if (sol >= 1000) return sol.toFixed(1) + ' SOL';
  if (sol >= 1) return sol.toFixed(3) + ' SOL';
  return sol.toFixed(5) + ' SOL';
}

export function formatTokenAmount(amount, decimals) {
  const val = Number(amount) / Math.pow(10, decimals);
  return val.toLocaleString(undefined, { maximumFractionDigits: decimals });
}

export function formatPct(ratio) {
  return (ratio * 100).toFixed(1) + '%';
}

export function formatCountdown(deadline) {
  const now = Date.now() / 1000;
  const dl = Number(deadline);
  const diff = dl - now;
  if (diff <= 0) return 'Ended';
  const d = Math.floor(diff / 86400);
  const h = Math.floor((diff % 86400) / 3600);
  const m = Math.floor((diff % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function formatDate(timestamp) {
  const d = new Date(Number(timestamp) * 1000);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function escapeHtml(str) {
  const el = document.createElement('div');
  el.textContent = str;
  return el.innerHTML;
}

// ═══════════════════════════════════════════════════════════════════
// Status Bar
// ═══════════════════════════════════════════════════════════════════

const statusBar = () => document.getElementById('status-bar');

export function showStatus(msg, type = 'info') {
  const el = statusBar();
  el.textContent = msg;
  el.className = `status-bar ${type}`;
  el.classList.remove('hidden');
  if (type !== 'error') {
    setTimeout(() => el.classList.add('hidden'), 5000);
  }
}

export function hideStatus() { statusBar()?.classList.add('hidden'); }

// ═══════════════════════════════════════════════════════════════════
// Transaction Overlay
// ═══════════════════════════════════════════════════════════════════

export function showTxOverlay(msg = 'Processing transaction…') {
  const el = document.getElementById('tx-overlay');
  document.getElementById('tx-overlay-status').textContent = msg;
  el.classList.remove('hidden');
}

export function updateTxOverlay(msg) {
  document.getElementById('tx-overlay-status').textContent = msg;
}

export function hideTxOverlay() {
  document.getElementById('tx-overlay').classList.add('hidden');
}

// ═══════════════════════════════════════════════════════════════════
// Market Card (for explore list)
// ═══════════════════════════════════════════════════════════════════

export function renderMarketCard(pubkey, market) {
  const probs = getImpliedProbabilities(market.outcomePools, market.totalPool);
  const statusClass = market.statusName.toLowerCase();

  const outcomeBarsHtml = market.outcomeLabels.map((label, i) => {
    const pct = probs[i] * 100;
    const isWinner = market.status >= 2 && market.winningOutcome === i;
    return `
      <div class="outcome-bar-row">
        <span class="outcome-label">${escapeHtml(label)}</span>
        <div class="outcome-bar-track ${isWinner ? 'outcome-bar-winner' : ''}">
          <div class="outcome-bar-fill idx-${i}" style="width:${Math.max(pct, 1)}%"></div>
          <span class="outcome-bar-pct">${formatPct(probs[i])}</span>
        </div>
      </div>
    `;
  }).join('');

  const denomLabel = market.denominationName === 'NativeSol' ? 'SOL' : market.denominationName;
  const volumeStr = market.denominationName === 'NativeSol'
    ? formatSol(market.totalPool)
    : formatTokenAmount(market.totalPool, market.tokenDecimals) + ' tokens';
  const deadlineStr = market.status === 0 ? formatCountdown(market.resolutionDeadline) : formatDate(market.resolutionDeadline);

  const addr = pubkey.toBase58();
  const isWatched = watchlist.has(addr);
  const { category: marketCategory } = parseDescription(market.description);

  const card = document.createElement('div');
  card.className = 'market-card';
  card.dataset.pubkey = addr;
  card.innerHTML = `
    <div class="market-card-header">
      <span class="market-card-title">${escapeHtml(market.title)}</span>
      <button class="watchlist-star ${isWatched ? 'active' : ''}" data-addr="${addr}" title="Toggle watchlist">${isWatched ? '★' : '☆'}</button>
      <span class="market-status-badge ${statusClass}">${market.statusName}</span>
    </div>
    ${marketCategory ? `<span class="market-category-badge">${escapeHtml(marketCategory)}</span>` : ''}
    <div class="outcome-bars">${outcomeBarsHtml}</div>
    <div class="market-card-stats">
      <div class="market-stat">
        <span class="market-stat-value">${volumeStr}</span>
        <span class="market-stat-label">Volume</span>
      </div>
      <div class="market-stat">
        <span class="market-stat-value">${Number(market.totalPositions)}</span>
        <span class="market-stat-label">Positions</span>
      </div>
      <div class="market-stat">
        <span class="market-stat-value">${deadlineStr}</span>
        <span class="market-stat-label">${market.status === 0 ? 'Closes In' : 'Deadline'}</span>
      </div>
      <div class="market-stat">
        <span class="market-stat-value">${market.feeBps / 100}%</span>
        <span class="market-stat-label">Fee</span>
      </div>
    </div>
  `;

  return card;
}

// ═══════════════════════════════════════════════════════════════════
// Market Detail
// ═══════════════════════════════════════════════════════════════════

export function renderMarketDetail(pubkey, market, connectedWallet = null) {
  const probs = getImpliedProbabilities(market.outcomePools, market.totalPool);
  const statusClass = market.statusName.toLowerCase();
  const denomLabel = market.denominationName === 'NativeSol' ? 'SOL' : market.denominationName;
  const volumeStr = market.denominationName === 'NativeSol'
    ? formatSol(market.totalPool) : formatTokenAmount(market.totalPool, market.tokenDecimals);

  const outcomeBarsHtml = market.outcomeLabels.map((label, i) => {
    const pct = probs[i] * 100;
    const pool = market.denominationName === 'NativeSol'
      ? formatSol(market.outcomePools[i]) : formatTokenAmount(market.outcomePools[i], market.tokenDecimals);
    const isWinner = market.status >= 2 && market.winningOutcome === i;
    return `
      <div class="outcome-bar-row">
        <span class="outcome-label" title="${pool}">${escapeHtml(label)}</span>
        <div class="outcome-bar-track ${isWinner ? 'outcome-bar-winner' : ''}">
          <div class="outcome-bar-fill idx-${i}" style="width:${Math.max(pct, 1)}%"></div>
          <span class="outcome-bar-pct">${formatPct(probs[i])}</span>
        </div>
      </div>
    `;
  }).join('');

  // Bet section (only if market is open)
  let betSectionHtml = '';
  if (market.status === 0) {
    const outcomeBtns = market.outcomeLabels.map((label, i) => `
      <button class="bet-outcome-btn" data-outcome="${i}">
        <span>${escapeHtml(label)}</span>
        <span class="bet-outcome-pct">${formatPct(probs[i])}</span>
      </button>
    `).join('');

    betSectionHtml = `
      <div class="bet-section">
        <div class="card">
          <div class="bet-section-title">Place a Bet</div>
          <div class="bet-outcomes">${outcomeBtns}</div>
          <div class="bet-amount-row">
            <input id="bet-amount-input" type="number" class="bet-amount-input"
              placeholder="0.00" min="0" step="0.001">
            <span class="bet-amount-suffix">${denomLabel}</span>
          </div>
          <div id="bet-payout-estimate" class="bet-payout-estimate hidden">
            Est. payout: <span class="bet-payout-value">—</span>
          </div>
          <button id="place-bet-btn" class="action-btn primary-btn" disabled>Select an Outcome</button>
        </div>
      </div>
    `;
  }

  // Authority actions (only visible to the market authority)
  const isAuthority = connectedWallet && market.authority.toBase58() === connectedWallet.toBase58();
  let authorityHtml = '';
  if (isAuthority && market.status === 0) {
    authorityHtml = `
      <div class="authority-actions card" style="margin-top:8px">
        <div class="bet-section-title">Authority Actions</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button id="resolve-market-btn" class="action-btn secondary-btn" style="flex:1;min-width:120px" disabled>Resolve</button>
          <button id="void-market-btn" class="action-btn danger-btn" style="flex:1;min-width:120px" disabled>Void</button>
        </div>
        <div id="resolve-outcome-select" class="hidden" style="margin-top:10px">
          <select id="resolve-outcome-dropdown" class="form-select" style="margin-bottom:8px">
            ${market.outcomeLabels.map((l, i) => `<option value="${i}">${escapeHtml(l)}</option>`).join('')}
          </select>
          <button id="confirm-resolve-btn" class="action-btn primary-btn">Confirm Resolution</button>
        </div>
      </div>
    `;
  } else if (market.status === 1) {
    // Finalize is permissionless — anyone can call it after dispute window
    authorityHtml = `
      <div class="authority-actions card" style="margin-top:8px">
        <div class="bet-section-title">Finalize Market</div>
        <p style="font-size:0.82rem;color:var(--text-secondary);margin-bottom:10px">
          Anyone can finalize after the 24h dispute window.
        </p>
        <button id="finalize-market-btn" class="action-btn primary-btn">Finalize Market</button>
      </div>
    `;
  }

  const addr = pubkey.toBase58();
  const isWatched = watchlist.has(addr);
  const { category: marketCategory, description: cleanDesc } = parseDescription(market.description);

  return `
    <div class="market-detail-header">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
        <h1 class="market-detail-title">${escapeHtml(market.title)}</h1>
        <span class="market-status-badge ${statusClass}">${market.statusName}</span>
      </div>
      ${marketCategory ? `<span class="market-category-badge" style="margin-bottom:6px">${escapeHtml(marketCategory)}</span>` : ''}
      ${cleanDesc ? `<p class="market-detail-desc">${escapeHtml(cleanDesc)}</p>` : ''}
      <button class="watchlist-detail-btn ${isWatched ? 'active' : ''}" id="detail-watchlist-btn" data-addr="${addr}">
        <span>${isWatched ? '★' : '☆'}</span>
        <span>${isWatched ? 'Watching' : 'Add to Watchlist'}</span>
      </button>
    </div>

    <div class="market-detail-meta">
      <div class="meta-item">
        <span class="meta-label">Volume</span>
        <span class="meta-value gold">${volumeStr}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Positions</span>
        <span class="meta-value">${Number(market.totalPositions)}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Deadline</span>
        <span class="meta-value">${formatDate(market.resolutionDeadline)}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Fee</span>
        <span class="meta-value">${market.feeBps / 100}%</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Denomination</span>
        <span class="meta-value">${denomLabel}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Authority</span>
        <span class="meta-value" style="font-size:0.72rem">${shortAddress(market.authority.toBase58())}</span>
      </div>
    </div>

    <div class="outcome-bars" style="margin-top:12px">${outcomeBarsHtml}</div>

    <button class="chart-toggle-btn" id="detail-chart-toggle">▸ Show Charts</button>
    <div class="detail-charts-row hidden" id="detail-charts-wrap">
      <div class="chart-container card">
        <div class="chart-title">Outcome Distribution</div>
        <canvas id="detail-donut-chart" height="200"></canvas>
      </div>
      <div class="chart-container card">
        <div class="chart-title">Pool per Outcome</div>
        <canvas id="detail-pool-chart" height="200"></canvas>
      </div>
    </div>

    ${betSectionHtml}
    ${authorityHtml}

    <div class="card" style="margin-top:8px">
      <div class="bet-section-title">Market Address</div>
      <div style="display:flex;align-items:center;gap:8px">
        <code style="font-size:0.72rem;color:var(--text-secondary);word-break:break-all">${addr}</code>
        <button class="copy-btn" data-copy="${addr}">Copy</button>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════════
// Position Card (for My Bets view)
// ═══════════════════════════════════════════════════════════════════

export function renderPositionCard(positionPubkey, position, market, marketPubkey) {
  if (!market) {
    return `<div class="position-card"><span class="text-muted">Market data unavailable</span></div>`;
  }

  const denomLabel = market.denominationName === 'NativeSol' ? 'SOL' : market.denominationName;
  const amountStr = market.denominationName === 'NativeSol'
    ? formatSol(position.amount) : formatTokenAmount(position.amount, market.tokenDecimals);
  const outcomeLabel = market.outcomeLabels[position.outcomeIndex] ?? `Outcome ${position.outcomeIndex}`;
  const statusClass = market.statusName.toLowerCase();

  // Determine action buttons
  let actionsHtml = '';
  if (market.status === 2 && !position.claimed && market.winningOutcome === position.outcomeIndex) {
    actionsHtml = `<div class="position-actions">
      <button class="action-btn primary-btn claim-winnings-btn"
        data-position="${positionPubkey.toBase58()}"
        data-market="${marketPubkey.toBase58()}">Claim Winnings</button>
    </div>`;
  } else if (market.status === 3 && !position.claimed) {
    actionsHtml = `<div class="position-actions">
      <button class="action-btn secondary-btn claim-refund-btn"
        data-position="${positionPubkey.toBase58()}"
        data-market="${marketPubkey.toBase58()}">Claim Refund</button>
    </div>`;
  } else if (position.claimed) {
    actionsHtml = `<div style="margin-top:10px;font-size:0.78rem;color:var(--green)">✓ Claimed</div>`;
  }

  const card = document.createElement('div');
  card.className = 'position-card';
  card.innerHTML = `
    <div class="position-card-header">
      <span class="position-market-title" data-market-pubkey="${marketPubkey.toBase58()}">${escapeHtml(market.title)}</span>
      <span class="market-status-badge ${statusClass}">${market.statusName}</span>
    </div>
    <div class="position-details">
      <div class="position-detail">
        <span class="position-detail-label">Outcome</span>
        <span class="position-detail-value">${escapeHtml(outcomeLabel)}</span>
      </div>
      <div class="position-detail">
        <span class="position-detail-label">Amount</span>
        <span class="position-detail-value">${amountStr}</span>
      </div>
      <div class="position-detail">
        <span class="position-detail-label">Deposited</span>
        <span class="position-detail-value">${formatDate(position.lastDepositAt)}</span>
      </div>
    </div>
    ${actionsHtml}
  `;

  return card;
}

// ═══════════════════════════════════════════════════════════════════
// Charts
// ═══════════════════════════════════════════════════════════════════

const CHART_COLORS = [
  '#00e676','#ff5252','#448aff','#b388ff','#ffbc0c',
  '#18ffff','#ff80ab','#69f0ae','#ffd740','#8c9eff'
];

let _volumeChart = null;
let _donutChart = null;
let _poolBarChart = null;

/** Render the explore view volume bar chart (top 8 markets) */
export function renderVolumeChart(markets) {
  const canvas = document.getElementById('explore-volume-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  if (_volumeChart) { _volumeChart.destroy(); _volumeChart = null; }

  const sorted = [...markets].sort((a, b) => Number(b.account.totalPool - a.account.totalPool)).slice(0, 10);
  if (sorted.length === 0) { canvas.parentElement.style.display = 'none'; return; }
  canvas.parentElement.style.display = '';

  const labels = sorted.map(m => m.account.title.length > 28 ? m.account.title.slice(0, 28) + '…' : m.account.title);
  const data = sorted.map(m => lamportsToSol(m.account.totalPool));

  _volumeChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: 'rgba(255, 188, 12, 0.5)',
        borderColor: '#ffbc0c',
        borderWidth: 1,
        borderRadius: 4,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => c.parsed.x.toFixed(4) + ' SOL' } } },
      scales: {
        x: { beginAtZero: true, grid: { color: 'rgba(255,210,12,0.08)' }, ticks: { color: 'rgba(255,188,12,0.6)', font: { size: 10 } } },
        y: { grid: { display: false }, ticks: { color: 'rgba(255,188,12,0.8)', font: { size: 11 } } },
      },
    },
  });
}

/** Render outcome donut chart on market detail. Call after detail HTML is in DOM. */
export function renderDetailCharts(market) {
  if (typeof Chart === 'undefined') return;

  // Donut — outcome distribution
  const donutCanvas = document.getElementById('detail-donut-chart');
  if (donutCanvas) {
    if (_donutChart) { _donutChart.destroy(); _donutChart = null; }
    const data = market.outcomePools.map(p => Number(p));
    const hasData = data.some(v => v > 0);
    _donutChart = new Chart(donutCanvas, {
      type: 'doughnut',
      data: {
        labels: market.outcomeLabels,
        datasets: [{
          data: hasData ? data : market.outcomeLabels.map(() => 1),
          backgroundColor: CHART_COLORS.slice(0, market.numOutcomes),
          borderColor: '#010101',
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '60%',
        plugins: {
          legend: { position: 'bottom', labels: { color: 'rgba(255,255,255,0.7)', font: { size: 11 }, padding: 10, usePointStyle: true, pointStyleWidth: 8 } },
          tooltip: { callbacks: { label: (c) => {
            const sol = lamportsToSol(BigInt(market.outcomePools[c.dataIndex]));
            return `${c.label}: ${sol.toFixed(4)} SOL`;
          } } },
        },
      },
    });
  }

  // Bar — pool per outcome
  const barCanvas = document.getElementById('detail-pool-chart');
  if (barCanvas) {
    if (_poolBarChart) { _poolBarChart.destroy(); _poolBarChart = null; }
    _poolBarChart = new Chart(barCanvas, {
      type: 'bar',
      data: {
        labels: market.outcomeLabels,
        datasets: [{
          data: market.outcomePools.map(p => lamportsToSol(p)),
          backgroundColor: CHART_COLORS.slice(0, market.numOutcomes),
          borderRadius: 4,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => c.parsed.y.toFixed(4) + ' SOL' } } },
        scales: {
          x: { grid: { display: false }, ticks: { color: 'rgba(255,188,12,0.8)', font: { size: 11 } } },
          y: { beginAtZero: true, grid: { color: 'rgba(255,210,12,0.08)' }, ticks: { color: 'rgba(255,188,12,0.6)', font: { size: 10 } } },
        },
      },
    });
  }
}

// ═══════════════════════════════════════════════════════════════════
// Wallet UI
// ═══════════════════════════════════════════════════════════════════

export function renderWalletConnected(publicKey) {
  const short = shortAddress(publicKey.toBase58());
  const section = document.getElementById('wallet-section');
  section.innerHTML = `<button id="disconnect-btn" class="wallet-btn connected">${short}</button>`;

  // Resolve SNS name in the background and update the button text
  resolveDisplayName(publicKey.toBase58())
    .then(displayName => {
      const btn = document.getElementById('disconnect-btn');
      if (btn && btn.classList.contains('connected')) {
        btn.textContent = displayName;
      }
    })
    .catch(err => {
      console.warn('SNS wallet display failed:', err);
    });

  return document.getElementById('disconnect-btn');
}

export function renderWalletDisconnected(wallets, isMobileDevice) {
  const section = document.getElementById('wallet-section');

  if (isMobileDevice) {
    section.innerHTML = `<button id="connect-wallet-btn" class="wallet-btn">Connect</button>`;
    return;
  }

  if (wallets.length === 0) {
    section.innerHTML = `<button class="wallet-btn" disabled>No Wallet</button>`;
    return;
  }

  if (wallets.length === 1) {
    section.innerHTML = `<button id="connect-wallet-btn" class="wallet-btn">Connect ${wallets[0].name}</button>`;
    return;
  }

  section.innerHTML = `
    <div class="wallet-dropdown">
      <button id="connect-wallet-btn" class="wallet-btn">Connect</button>
      <div id="wallet-options" class="wallet-options hidden">
        ${wallets.map((w, i) => `<button class="wallet-option" data-index="${i}">${w.name}</button>`).join('')}
      </div>
    </div>
  `;
}