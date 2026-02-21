/**
 * @module ui
 * DOM rendering helpers for market cards, detail views, positions, etc.
 */
import { lamportsToSol, getImpliedProbabilities } from './sdk.js';
import { resolveDisplayName, resolveDisplayNames, shortAddress } from './sns.js';
import * as watchlist from './watchlist.js';
import { Chart, registerables } from 'chart.js';
Chart.register(...registerables);

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
  el.innerHTML = `<span class="status-msg">${msg}</span><button class="status-dismiss" aria-label="Dismiss">&times;</button>`;
  el.className = `status-bar ${type}`;
  el.classList.remove('hidden');
  el.querySelector('.status-dismiss').addEventListener('click', () => el.classList.add('hidden'));
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

export function renderMarketCard(pubkey, market, userPositions = null) {
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

  const denomLabel = market._tokenSymbol || (market.denominationName === 'NativeSol' ? 'SOL' : market.denominationName);
  const tokenIcon = market._tokenIcon || '';
  const volumeStr = market.denominationName === 'NativeSol'
    ? formatSol(market.totalPool)
    : formatTokenAmount(market.totalPool, market.tokenDecimals) + ' ' + denomLabel;
  const deadlineStr = market.status === 0 ? formatCountdown(market.resolutionDeadline) : formatDate(market.resolutionDeadline);

  const addr = pubkey.toBase58();
  const isWatched = watchlist.has(addr);
  const { category: marketCategory } = parseDescription(market.description);

  // User position estimate badges
  let positionBadges = '';
  if (userPositions && userPositions.length > 0) {
    const isSol = market.denominationName === 'NativeSol';
    const sym = denomLabel;
    const decimals = isSol ? 9 : (market.tokenDecimals || 9);
    const usdPerToken = (market._usdVolume && market.totalPool > 0n)
      ? market._usdVolume / (Number(market.totalPool) / (10 ** decimals))
      : 0;
    const fmtUsd = (raw) => {
      if (!usdPerToken) return '';
      const tokens = Number(raw) / (10 ** decimals);
      const usd = tokens * usdPerToken;
      return ` ($${usd >= 1 ? usd.toFixed(2) : usd.toFixed(4)})`;
    };
    const badges = userPositions.filter(p => !p.claimed).map(p => {
      const outcomeLabel = market.outcomeLabels[p.outcomeIndex] ?? `#${p.outcomeIndex}`;
      const amountStr = isSol ? formatSol(p.amount) : formatTokenAmount(p.amount, market.tokenDecimals) + ' ' + sym;
      const pool = market.outcomePools[p.outcomeIndex];
      if (market.status < 2 && pool > 0n && market.totalPool > 0n) {
        const gross = (BigInt(p.amount) * market.totalPool) / pool;
        const fee = (gross * BigInt(market.feeBps)) / 10000n;
        const net = gross - fee;
        const payStr = isSol ? formatSol(net) : formatTokenAmount(net, market.tokenDecimals) + ' ' + sym;
        return `<span class="position-estimate-badge" title="${amountStr} on ${outcomeLabel}">Est. ${payStr}${fmtUsd(net)}</span>`;
      } else if (market.status === 2 && market.winningOutcome === p.outcomeIndex) {
        const winPool = market.outcomePools[market.winningOutcome];
        if (winPool > 0n) {
          const gross = (BigInt(p.amount) * market.totalPool) / winPool;
          const fee = (gross * BigInt(market.feeBps)) / 10000n;
          const net = gross - fee;
          const payStr = isSol ? formatSol(net) : formatTokenAmount(net, market.tokenDecimals) + ' ' + sym;
          return `<span class="position-estimate-badge win" title="${amountStr} on ${outcomeLabel}">Win ${payStr}${fmtUsd(net)}</span>`;
        }
      } else if (market.status === 2 && market.winningOutcome !== p.outcomeIndex) {
        return `<span class="position-estimate-badge lost" title="${amountStr} on ${outcomeLabel}">Lost</span>`;
      }
      return '';
    }).filter(Boolean);
    positionBadges = badges.join('');
  }

  const hasBadgeRow = marketCategory || positionBadges;

  const usdVolume = market._usdVolume || 0;
  const usdStr = usdVolume > 0 ? '$' + (usdVolume >= 1 ? usdVolume.toFixed(2) : usdVolume.toFixed(4)) : '—';

  const card = document.createElement('div');
  card.className = 'market-card';
  card.dataset.pubkey = addr;
  card.innerHTML = `
    <div class="market-card-header">
      <span class="market-card-title">${escapeHtml(market.title)}</span>
      <button class="watchlist-star ${isWatched ? 'active' : ''}" data-addr="${addr}" title="Toggle watchlist">${isWatched ? '★' : '☆'}</button>
      <span class="market-status-badge ${statusClass}">${market.statusName}</span>
    </div>
    ${hasBadgeRow ? `<div class="market-badge-row">
      ${marketCategory ? `<span class="position-category-badge">${escapeHtml(marketCategory)}</span>` : ''}
      ${positionBadges}
    </div>` : ''}
    <div class="outcome-bars">${outcomeBarsHtml}</div>
    <div class="market-card-stats">
      <div class="market-stat">
        <span class="market-stat-value">${tokenIcon ? `<img class="token-icon-inline" src="${tokenIcon}" alt="${denomLabel}" onerror="this.style.display='none'">` : ''}${volumeStr}</span>
        <span class="market-stat-label">Volume</span>
      </div>
      <div class="market-stat">
        <span class="market-stat-value">${usdStr}</span>
        <span class="market-stat-label">Value</span>
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
        <span class="market-stat-value sns-resolve" data-address="${market.creator.toBase58()}">${shortAddress(market.creator.toBase58())}</span>
        <span class="market-stat-label">Creator</span>
      </div>
    </div>
  `;

  return card;
}

// ═══════════════════════════════════════════════════════════════════
// Market Detail
// ═══════════════════════════════════════════════════════════════════

export function renderMarketDetail(pubkey, market, connectedWallet = null, userPositions = null) {
  const probs = getImpliedProbabilities(market.outcomePools, market.totalPool);
  const statusClass = market.statusName.toLowerCase();
  const denomLabel = market._tokenSymbol || (market.denominationName === 'NativeSol' ? 'SOL' : market.denominationName);
  const tokenIcon = market._tokenIcon || '';
  const tokenName = market._tokenName || denomLabel;
  const volumeStr = market.denominationName === 'NativeSol'
    ? formatSol(market.totalPool) : formatTokenAmount(market.totalPool, market.tokenDecimals) + ' ' + denomLabel;

  const outcomeBarsHtml = market.outcomeLabels.map((label, i) => {
    const pct = probs[i] * 100;
    const pool = market.denominationName === 'NativeSol'
      ? formatSol(market.outcomePools[i]) : formatTokenAmount(market.outcomePools[i], market.tokenDecimals) + ' ' + denomLabel;
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

  // Position section (only if market is open)
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
          <div class="bet-section-title">Choose Position</div>
          <div class="bet-outcomes">${outcomeBtns}</div>
          <div class="bet-amount-row">
            <input id="bet-amount-input" type="number" class="bet-amount-input"
              placeholder="0.001" min="0.001" step="0.001">
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

  // User position estimate badges for detail view
  const isSol = market.denominationName === 'NativeSol';
  const sym = denomLabel;
  const detDecimals = isSol ? 9 : (market.tokenDecimals || 9);
  const detUsdPerToken = (market._usdVolume && market.totalPool > 0n)
    ? market._usdVolume / (Number(market.totalPool) / (10 ** detDecimals))
    : 0;
  const detFmtUsd = (raw) => {
    if (!detUsdPerToken) return '';
    const tokens = Number(raw) / (10 ** detDecimals);
    const usd = tokens * detUsdPerToken;
    return ` ($${usd >= 1 ? usd.toFixed(2) : usd.toFixed(4)})`;
  };
  let positionBadges = '';
  if (userPositions && userPositions.length > 0) {
    const badges = userPositions.filter(p => !p.claimed).map(p => {
      const outcomeLabel = market.outcomeLabels[p.outcomeIndex] ?? `#${p.outcomeIndex}`;
      const amountStr = isSol ? formatSol(p.amount) : formatTokenAmount(p.amount, market.tokenDecimals) + ' ' + sym;
      const pool = market.outcomePools[p.outcomeIndex];
      if (market.status < 2 && pool > 0n && market.totalPool > 0n) {
        const gross = (BigInt(p.amount) * market.totalPool) / pool;
        const fee = (gross * BigInt(market.feeBps)) / 10000n;
        const net = gross - fee;
        const payStr = isSol ? formatSol(net) : formatTokenAmount(net, market.tokenDecimals) + ' ' + sym;
        return `<span class="position-estimate-badge" title="${amountStr} on ${escapeHtml(outcomeLabel)}">Est. ${payStr}${detFmtUsd(net)}</span>`;
      } else if (market.status === 2 && market.winningOutcome === p.outcomeIndex) {
        const winPool = market.outcomePools[market.winningOutcome];
        if (winPool > 0n) {
          const gross = (BigInt(p.amount) * market.totalPool) / winPool;
          const fee = (gross * BigInt(market.feeBps)) / 10000n;
          const net = gross - fee;
          const payStr = isSol ? formatSol(net) : formatTokenAmount(net, market.tokenDecimals) + ' ' + sym;
          return `<span class="position-estimate-badge win" title="${amountStr} on ${escapeHtml(outcomeLabel)}">Win ${payStr}${detFmtUsd(net)}</span>`;
        }
      } else if (market.status === 2 && market.winningOutcome !== p.outcomeIndex) {
        return `<span class="position-estimate-badge lost" title="${amountStr} on ${escapeHtml(outcomeLabel)}">Lost</span>`;
      }
      return '';
    }).filter(Boolean);
    positionBadges = badges.join('');
  }

  const hasBadgeRow = marketCategory || positionBadges;

  return `
    <div class="market-detail-header">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
        <h1 class="market-detail-title">${escapeHtml(market.title)}</h1>
        <span class="detail-header-badges">
          ${marketCategory ? `<span class="position-category-badge">${escapeHtml(marketCategory)}</span>` : ''}
          <span class="market-status-badge ${statusClass}">${market.statusName}</span>
        </span>
      </div>
      ${cleanDesc ? `<p class="market-detail-desc">${escapeHtml(cleanDesc)}</p>` : ''}
      <div class="detail-action-row">
        <button class="watchlist-detail-btn ${isWatched ? 'active' : ''}" id="detail-watchlist-btn" data-addr="${addr}">
          <span>${isWatched ? '★' : '☆'}</span>
          <span>${isWatched ? 'Watching' : 'Add to Watchlist'}</span>
        </button>
        <button class="detail-share-btn" id="detail-share-btn" title="Share this market">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
          <span>Share</span>
        </button>
        ${positionBadges ? positionBadges.replace(/position-estimate-badge/g, 'detail-estimate-btn') : ''}
      </div>
    </div>

    <div class="market-detail-meta">
      <div class="meta-item">
        <span class="meta-label">Volume</span>
        <span class="meta-value gold">${tokenIcon ? `<img class="token-icon-inline" src="${tokenIcon}" alt="${denomLabel}" onerror="this.style.display='none'">` : ''}${volumeStr}</span>
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
        <span class="meta-value">${market.feeBps / 100}%${market.creatorFeeBps > 0 ? ` <span style="font-size:0.68rem;color:var(--text-muted)">(${(market.feeBps - market.creatorFeeBps) / 100}% protocol + ${market.creatorFeeBps / 100}% creator)</span>` : ''}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Denomination</span>
        <span class="meta-value">${tokenIcon ? `<img class="token-icon-inline" src="${tokenIcon}" alt="${denomLabel}" onerror="this.style.display='none'">` : ''}${tokenName}${tokenName !== denomLabel ? ` (${denomLabel})` : ''}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Authority</span>
        <span class="meta-value sns-resolve" data-address="${market.authority.toBase58()}" style="font-size:0.72rem">${shortAddress(market.authority.toBase58())}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Creator</span>
        <span class="meta-value sns-resolve" data-address="${market.creator.toBase58()}" style="font-size:0.72rem">${shortAddress(market.creator.toBase58())}</span>
      </div>
    </div>

    <div class="outcome-bars" style="margin-top:12px">${outcomeBarsHtml}</div>

    <button class="chart-toggle-btn open" id="detail-chart-toggle">▾ Hide Charts</button>
    <div class="detail-charts-row" id="detail-charts-wrap">
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
// Position Card (for My Positions view)
// ═══════════════════════════════════════════════════════════════════

export function renderPositionCard(positionPubkey, position, market, marketPubkey) {
  if (!market) {
    return `<div class="position-card"><span class="text-muted">Market data unavailable</span></div>`;
  }

  const denomLabel = market._tokenSymbol || (market.denominationName === 'NativeSol' ? 'SOL' : market.denominationName);
  const tokenIcon = market._tokenIcon || '';
  const amountStr = market.denominationName === 'NativeSol'
    ? formatSol(position.amount) : formatTokenAmount(position.amount, market.tokenDecimals) + ' ' + denomLabel;
  const outcomeLabel = market.outcomeLabels[position.outcomeIndex] ?? `Outcome ${position.outcomeIndex}`;
  const statusClass = market.statusName.toLowerCase();
  const { category } = parseDescription(market.description);
  const deadlineStr = market.status === 0 ? formatCountdown(market.resolutionDeadline) : formatDate(market.resolutionDeadline);

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

  // Payout estimate badge
  const isSol = market.denominationName === 'NativeSol';
  const sym = denomLabel;
  const posDecimals = isSol ? 9 : (market.tokenDecimals || 9);
  const posUsdPerToken = (market._usdVolume && market.totalPool > 0n)
    ? market._usdVolume / (Number(market.totalPool) / (10 ** posDecimals))
    : 0;
  const posFmtUsd = (raw) => {
    if (!posUsdPerToken) return '';
    const tokens = Number(raw) / (10 ** posDecimals);
    const usd = tokens * posUsdPerToken;
    return ` ($${usd >= 1 ? usd.toFixed(2) : usd.toFixed(4)})`;
  };
  let payoutBadge = '';
  if (!position.claimed) {
    const pool = market.outcomePools[position.outcomeIndex];
    if (market.status < 2 && pool > 0n && market.totalPool > 0n) {
      const gross = (BigInt(position.amount) * market.totalPool) / pool;
      const fee = (gross * BigInt(market.feeBps)) / 10000n;
      const net = gross - fee;
      payoutBadge = `<span class="position-estimate-badge">Est. ${isSol ? formatSol(net) : formatTokenAmount(net, market.tokenDecimals) + ' ' + sym}${posFmtUsd(net)}</span>`;
    } else if (market.status === 2 && market.winningOutcome === position.outcomeIndex) {
      const winPool = market.outcomePools[market.winningOutcome];
      if (winPool > 0n) {
        const gross = (BigInt(position.amount) * market.totalPool) / winPool;
        const fee = (gross * BigInt(market.feeBps)) / 10000n;
        const net = gross - fee;
        payoutBadge = `<span class="position-estimate-badge win">Win ${isSol ? formatSol(net) : formatTokenAmount(net, market.tokenDecimals) + ' ' + sym}${posFmtUsd(net)}</span>`;
      }
    } else if (market.status === 2 && market.winningOutcome !== position.outcomeIndex) {
      payoutBadge = `<span class="position-estimate-badge lost">Lost</span>`;
    }
  }

  const hasBadgeRow = category || payoutBadge;

  const card = document.createElement('div');
  card.className = 'position-card';
  card.innerHTML = `
    <div class="position-card-header">
      <span class="position-market-title" data-market-pubkey="${marketPubkey.toBase58()}">${escapeHtml(market.title)}</span>
      <span class="market-status-badge ${statusClass}">${market.statusName}</span>
    </div>
    ${hasBadgeRow ? `<div class="position-badge-row">
      ${category ? `<span class="position-category-badge">${escapeHtml(category)}</span>` : ''}
      ${payoutBadge}
    </div>` : ''}
    <div class="position-details">
      <div class="position-detail">
        <span class="position-detail-label">Outcome</span>
        <span class="position-detail-value">${escapeHtml(outcomeLabel)}</span>
      </div>
      <div class="position-detail">
        <span class="position-detail-label">Amount</span>
        <span class="position-detail-value">${tokenIcon ? `<img class="token-icon-inline" src="${tokenIcon}" alt="${denomLabel}" onerror="this.style.display='none'">` : ''}${amountStr}</span>
      </div>
      <div class="position-detail">
        <span class="position-detail-label">Deposited</span>
        <span class="position-detail-value">${formatDate(position.lastDepositAt)}</span>
      </div>
      <div class="position-detail">
        <span class="position-detail-label">Deadline</span>
        <span class="position-detail-value">${deadlineStr}</span>
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
  '#ffffff','#448aff','#90caf9','#b0bec5','#82b1ff',
  '#cfd8dc','#bbdefb','#e0e0e0','#8c9eff','#eceff1'
];

let _volumeChart = null;
let _donutChart = null;
let _poolBarChart = null;

/** Render the explore view volume bar chart (top 10 markets) */
export function renderVolumeChart(markets, onClickMarket) {
  const canvas = document.getElementById('explore-volume-chart');
  if (!canvas || !Chart) return;
  if (_volumeChart) { _volumeChart.destroy(); _volumeChart = null; }

  // Sort by USD volume (fallback to raw pool for markets without price)
  const withVolume = [...markets].filter(m => m.account.status === 0);
  const sorted = withVolume.sort((a, b) => (b.account._usdVolume || 0) - (a.account._usdVolume || 0)).slice(0, 10);
  const hasVolume = sorted.some(m => (m.account._usdVolume || 0) > 0 || m.account.totalPool > 0n);

  if (sorted.length === 0 || !hasVolume) {
    canvas.style.display = 'none';
    let msg = canvas.parentElement.querySelector('.chart-empty');
    if (!msg) {
      msg = document.createElement('div');
      msg.className = 'chart-empty';
      msg.style.cssText = 'text-align:center;padding:32px 0;color:var(--text-muted);font-size:0.82rem;';
      canvas.parentElement.appendChild(msg);
    }
    msg.textContent = sorted.length === 0 ? 'No markets found.' : 'No volume yet — place the first position!';
    return;
  }

  // Remove empty state if present
  canvas.parentElement.querySelector('.chart-empty')?.remove();
  canvas.style.display = '';

  const labels = sorted.map(m => {
    const sym = m.account._tokenSymbol || (m.account.denominationName === 'NativeSol' ? 'SOL' : '?');
    return `[${sym}] ${m.account.title}`;
  });
  const data = sorted.map(m => m.account._usdVolume || 0);

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
    plugins: [{
      id: 'barLabels',
      afterDraw(chart) {
        const ctx = chart.ctx;
        const meta = chart.getDatasetMeta(0);
        ctx.save();
        ctx.font = 'bold 10px sans-serif';
        ctx.textBaseline = 'middle';
        meta.data.forEach((bar, i) => {
          const label = chart.data.labels[i];
          const barWidth = bar.width;
          const x = bar.x - barWidth + 14;
          const y = bar.y;
          // Use dark text on the bar for readability
          ctx.fillStyle = barWidth > 60 ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.8)';
          const textX = barWidth > 60 ? x + 4 : bar.x + 6;
          ctx.fillText(label, textX, y);
        });
        ctx.restore();
      }
    }],
    options: {
      animation: false,
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { left: 15, right: 10 } },
      onHover: (event, elements) => {
        canvas.style.cursor = elements.length > 0 ? 'pointer' : 'default';
      },
      onClick: (event, elements) => {
        if (elements.length > 0 && onClickMarket) {
          const idx = elements[0].index;
          onClickMarket(sorted[idx].pubkey);
        }
      },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => '$' + c.parsed.x.toFixed(2) + ' USD' } } },
      scales: {
        x: { beginAtZero: true, grid: { color: 'rgba(255,210,12,0.08)' }, ticks: { color: 'rgba(255,188,12,0.6)', font: { size: 10 }, callback: (v) => '$' + v.toLocaleString() } },
        y: { display: false },
      },
    },
  });
}

/** Render outcome donut chart on market detail. Call after detail HTML is in DOM. */
export function renderDetailCharts(market, tokenUsdPrice = 0) {
  if (!Chart) return;

  const isSol = market.denominationName === 'NativeSol';
  const decimals = isSol ? 9 : (market.tokenDecimals || 9);
  const symbol = market._tokenSymbol || (isSol ? 'SOL' : 'Token');
  const useUsd = tokenUsdPrice > 0;

  /** Convert raw pool bigint to display value */
  const toDisplay = (raw) => {
    const tokenAmount = Number(raw) / (10 ** decimals);
    return useUsd ? tokenAmount * tokenUsdPrice : tokenAmount;
  };
  const unitLabel = useUsd ? 'USD' : symbol;
  const fmtValue = (v) => useUsd ? '$' + v.toFixed(2) : v.toFixed(4) + ' ' + symbol;

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
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        cutout: '60%',
        plugins: {
          legend: { position: 'bottom', labels: { color: 'rgba(255,255,255,0.7)', font: { size: 11 }, padding: 10, usePointStyle: true, pointStyleWidth: 8 } },
          tooltip: { callbacks: { label: (c) => {
            const val = toDisplay(BigInt(market.outcomePools[c.dataIndex]));
            return `${c.label}: ${fmtValue(val)}`;
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
          data: market.outcomePools.map(p => toDisplay(p)),
          backgroundColor: CHART_COLORS.slice(0, market.numOutcomes),
          borderRadius: 4,
        }],
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => fmtValue(c.parsed.y) } } },
        scales: {
          x: { grid: { display: false }, ticks: { color: 'rgba(255,188,12,0.8)', font: { size: 11 } } },
          y: { beginAtZero: true, grid: { color: 'rgba(255,210,12,0.08)' }, ticks: { color: 'rgba(255,188,12,0.6)', font: { size: 10 }, callback: (v) => useUsd ? '$' + v.toLocaleString() : v } },
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

/** Resolve all .sns-resolve elements on the page to SNS names */
export async function resolveSnsElements(container = document) {
  const els = container.querySelectorAll('.sns-resolve[data-address]');
  if (els.length === 0) return;
  const addresses = [...new Set([...els].map(el => el.dataset.address))];
  const names = await resolveDisplayNames(addresses);
  const nameMap = {};
  addresses.forEach((addr, i) => { nameMap[addr] = names[i]; });
  els.forEach(el => {
    const name = nameMap[el.dataset.address];
    if (name) el.textContent = name;
  });
}