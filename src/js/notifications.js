/**
 * Watchlist Notifications Module
 * 
 * Subscribes to on-chain program logs via WebSocket, detects events
 * on watchlisted markets, and fires native browser notifications.
 */
import { WSS_URL, PROGRAM_ID } from './config.js';
import * as watchlist from './watchlist.js';

const STORAGE_KEY = 'precog_notifications';
const RECONNECT_DELAY = 5000;
const TX_FETCH_DELAY = 2000; // wait for tx to be available

let _ws = null;
let _subscriptionId = null;
let _enabled = false;
let _reconnectTimer = null;
let _connection = null; // set via init()

// Instruction log patterns → user-friendly event names
const IX_EVENTS = {
  'PlaceBet': 'New position placed',
  'ResolveMarket': 'Market resolved',
  'FinalizeMarket': 'Market finalized',
  'VoidMarket': 'Market voided',
  'DisputeResolve': 'Dispute resolution',
  'ClaimWinnings': 'Winnings claimed',
  'ClaimRefund': 'Refund claimed',
};

// ── Public API ──────────────────────────────────────────────────────

export function init(connection) {
  _connection = connection;
  _enabled = loadPref();
  if (_enabled && hasPermission()) {
    start();
  }
}

export function isEnabled() {
  return _enabled;
}

export function hasPermission() {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

export async function enable() {
  if (typeof Notification === 'undefined') return false;

  if (Notification.permission === 'default') {
    const result = await Notification.requestPermission();
    if (result !== 'granted') return false;
  } else if (Notification.permission === 'denied') {
    return false;
  }

  _enabled = true;
  savePref(true);
  start();
  return true;
}

export function disable() {
  _enabled = false;
  savePref(false);
  stop();
}

export function toggle() {
  if (_enabled) {
    disable();
    return false;
  } else {
    return enable();
  }
}

// ── WebSocket Subscription ──────────────────────────────────────────

function start() {
  if (_ws) return; // already connected
  if (!WSS_URL) { console.warn('Notifications: WSS_URL not configured'); return; }

  try {
    _ws = new WebSocket(WSS_URL);

    _ws.onopen = () => {
      console.log('Notifications: WebSocket connected');
      // Subscribe to program logs
      _ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'logsSubscribe',
        params: [
          { mentions: [PROGRAM_ID.toBase58()] },
          { commitment: 'confirmed' },
        ],
      }));
    };

    _ws.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);

        // Capture subscription ID from the subscribe response
        if (data.id === 1 && data.result != null) {
          _subscriptionId = data.result;
          console.log('Notifications: subscribed, id:', _subscriptionId);
          return;
        }

        // Handle log notifications
        if (data.method === 'logsNotification' && data.params?.result?.value) {
          handleLogNotification(data.params.result.value);
        }
      } catch (e) {
        console.warn('Notifications: message parse error', e);
      }
    };

    _ws.onclose = () => {
      console.log('Notifications: WebSocket closed');
      _ws = null;
      _subscriptionId = null;
      if (_enabled) {
        _reconnectTimer = setTimeout(start, RECONNECT_DELAY);
      }
    };

    _ws.onerror = (e) => {
      console.warn('Notifications: WebSocket error', e);
      _ws?.close();
    };
  } catch (e) {
    console.warn('Notifications: failed to connect', e);
    _ws = null;
    if (_enabled) {
      _reconnectTimer = setTimeout(start, RECONNECT_DELAY);
    }
  }
}

function stop() {
  clearTimeout(_reconnectTimer);
  _reconnectTimer = null;

  if (_ws) {
    // Unsubscribe before closing
    if (_subscriptionId != null) {
      try {
        _ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'logsUnsubscribe',
          params: [_subscriptionId],
        }));
      } catch {}
    }
    _ws.onclose = null; // prevent reconnect
    _ws.close();
    _ws = null;
    _subscriptionId = null;
  }
}

// ── Log Parsing ─────────────────────────────────────────────────────

function handleLogNotification(value) {
  const { signature, err, logs } = value;
  if (err) return; // failed transaction, ignore

  // Parse instruction type from logs
  let eventType = null;
  for (const line of (logs || [])) {
    const match = line.match(/Program log: IX: (\w+)/);
    if (match && IX_EVENTS[match[1]]) {
      eventType = match[1];
      break;
    }
  }

  if (!eventType) return; // not an interesting instruction

  // Fetch the transaction to get the market address
  // Delay slightly to ensure the RPC has indexed it
  setTimeout(() => fetchAndNotify(signature, eventType), TX_FETCH_DELAY);
}

async function fetchAndNotify(signature, eventType) {
  if (!_connection) return;

  try {
    const tx = await _connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });

    if (!tx?.transaction?.message) return;

    const message = tx.transaction.message;
    const accountKeys = message.staticAccountKeys
      ? message.staticAccountKeys.map(k => k.toBase58())
      : message.accountKeys.map(k => k.toBase58());

    // The market address is typically the first account in the program instruction
    // Find the program instruction and get its accounts
    const programId = PROGRAM_ID.toBase58();
    const instructions = message.compiledInstructions || message.instructions;

    for (const ix of instructions) {
      const progIdx = typeof ix.programIdIndex === 'number' ? ix.programIdIndex : ix.programIdIndex;
      if (accountKeys[progIdx] !== programId) continue;

      // First account in the instruction's account list is usually the market
      const accountIndices = ix.accountKeyIndexes || ix.accounts;
      if (!accountIndices || accountIndices.length === 0) continue;

      const marketAddr = accountKeys[accountIndices[0]];

      // Check if this market is in the watchlist
      if (watchlist.has(marketAddr)) {
        const category = watchlist.getCategory(marketAddr);
        const categoryStr = category ? ` [${category}]` : '';
        fireNotification(
          IX_EVENTS[eventType],
          `${marketAddr.slice(0, 8)}...${categoryStr}`,
          marketAddr
        );
      }
      break;
    }
  } catch (e) {
    // Transaction not found or RPC error - skip silently
  }
}

// ── Browser Notification ────────────────────────────────────────────

function fireNotification(title, body, marketAddr) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

  try {
    const n = new Notification(`Precog Markets - ${title}`, {
      body,
      icon: '/.well-known/icon.png',
      tag: `precog-${marketAddr}-${Date.now()}`,
      silent: false,
    });

    // Click notification → focus app and open market detail
    n.onclick = () => {
      window.focus();
      window.location.hash = `#/market/${marketAddr}`;
      n.close();
    };

    // Auto-close after 10 seconds
    setTimeout(() => n.close(), 10000);
  } catch (e) {
    console.warn('Notifications: failed to fire', e);
  }
}

// ── Persistence ─────────────────────────────────────────────────────

function loadPref() {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch { return false; }
}

function savePref(val) {
  try {
    localStorage.setItem(STORAGE_KEY, val ? 'true' : 'false');
  } catch {}
}
