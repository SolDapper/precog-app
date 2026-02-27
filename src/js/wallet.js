/**
 * @module wallet
 * Wallet connection logic — legacy injected providers, Wallet Standard, and
 * Solana Mobile Wallet Adapter.
 *
 * Legacy providers (Phantom, Solflare) inject globals like window.phantom.solana.
 * Newer wallets (Jupiter, Backpack, etc.) use the Wallet Standard protocol —
 * they register via `wallet-standard:register-wallet` window events.
 * This module listens for both without importing any adapter packages.
 */
import { PublicKey } from '@solana/web3.js';
import { transact } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js';
import bs58 from 'bs58';
import { APP_IDENTITY } from './config.js';

// ── State ────────────────────────────────────────────────────────
let _walletContext = null;   // { publicKey: PublicKey }
let _walletProvider = null;  // provider object with signTransaction
let _mobileAuthToken = null;
let _listeners = [];

// ── Public API ───────────────────────────────────────────────────

export function getWallet() { return _walletContext; }
export function getProvider() { return _walletProvider; }
export function isConnected() { return _walletContext !== null; }

/** Subscribe to wallet changes. Returns unsubscribe fn. */
export function onWalletChange(fn) {
  _listeners.push(fn);
  return () => { _listeners = _listeners.filter(l => l !== fn); };
}

function _notify() {
  for (const fn of _listeners) {
    try { fn(_walletContext); } catch (e) { console.error('wallet listener error', e); }
  }
}

// ── Detection helpers ────────────────────────────────────────────

export function isMobile() {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
}

export function isIOS() {
  return /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPad with desktop UA
}

export function isTelegramBrowser() {
  const ua = navigator.userAgent || navigator.vendor || window.opera;
  return /Telegram/i.test(ua) || window.TelegramWebviewProxy !== undefined ||
    window.Telegram !== undefined || typeof window.Telegram?.WebApp !== 'undefined';
}

export function isWalletBrowser() {
  // Legacy injected providers
  if (window.phantom?.solana?.isPhantom) return true;
  if (window.solflare?.isSolflare) return true;
  // Backpack injects window.backpack
  if (window.backpack?.isBackpack) return true;
  // UA sniffing fallback for in-app browsers
  if (/Phantom|Solflare|Backpack/i.test(navigator.userAgent)) return true;
  // If any Wallet Standard wallets registered synchronously, we're likely in a wallet browser
  if (_standardWallets.size > 0) return true;
  return false;
}

// ═══════════════════════════════════════════════════════════════════
// Wallet Standard Detection
// ═══════════════════════════════════════════════════════════════════

/**
 * Wallet Standard wallets discovered via window events.
 * Map of name → raw Wallet Standard wallet object.
 */
const _standardWallets = new Map();
let _standardListenerReady = false;

/**
 * Check if a Wallet Standard wallet supports the Solana features we need.
 */
function isSolanaWallet(wallet) {
  const features = wallet.features || {};
  return 'standard:connect' in features && 'solana:signTransaction' in features;
}

/**
 * Wrap a Wallet Standard wallet into a provider object compatible with our
 * existing connectDesktop / signAndSend flow.
 *
 * The wrapper exposes: connect(), signTransaction(), signAllTransactions(),
 * disconnect(), publicKey, and on().
 */
function wrapStandardWallet(standardWallet) {
  let _account = null;

  const wrapper = {
    _isWalletStandard: true,
    _standardWallet: standardWallet,
    publicKey: null,

    async connect(opts) {
      const connectFeature = standardWallet.features['standard:connect'];
      const result = await connectFeature.connect(opts?.onlyIfTrusted ? { silent: true } : undefined);
      const accounts = result?.accounts ?? standardWallet.accounts ?? [];
      if (accounts.length === 0) throw new Error('No accounts returned');
      _account = accounts[0];
      // Wallet Standard accounts store address as base58 string
      wrapper.publicKey = new PublicKey(_account.address);
      return { publicKey: wrapper.publicKey };
    },

    async signTransaction(transaction) {
      const signFeature = standardWallet.features['solana:signTransaction'];
      const serialized = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
      const results = await signFeature.signTransaction({
        transaction: serialized,
        account: _account,
        chain: _account.chains?.[0] || 'solana:mainnet',
      });
      // Result may be a single object or array; normalize
      const signed = Array.isArray(results) ? results[0] : results;
      const signedBytes = signed.signedTransaction || signed;
      const { Transaction } = await import('@solana/web3.js');
      return Transaction.from(signedBytes);
    },

    async signAllTransactions(transactions) {
      return Promise.all(transactions.map(tx => wrapper.signTransaction(tx)));
    },

    async disconnect() {
      try {
        const disconnectFeature = standardWallet.features['standard:disconnect'];
        if (disconnectFeature) await disconnectFeature.disconnect();
      } catch {}
      _account = null;
      wrapper.publicKey = null;
    },

    on(event, handler) {
      const eventsFeature = standardWallet.features['standard:events'];
      if (eventsFeature) {
        eventsFeature.on('change', (changes) => {
          if (event === 'accountChanged' && changes.accounts?.length > 0) {
            _account = changes.accounts[0];
            wrapper.publicKey = new PublicKey(_account.address);
            handler(wrapper.publicKey);
          }
          if (event === 'disconnect' && changes.accounts?.length === 0) {
            handler();
          }
        });
      }
    },
  };

  return wrapper;
}

/**
 * Callback passed to wallet registration events.
 * The wallet calls this with its Wallet Standard interface.
 */
function _registerStandardWallet(wallet) {
  if (!wallet || !wallet.name) return;
  if (isSolanaWallet(wallet)) {
    _standardWallets.set(wallet.name, wallet);
  }
}

/**
 * Start listening for Wallet Standard registrations.
 * Wallets that already registered before we started listening will be picked up
 * when we dispatch the `wallet-standard:app-ready` event.
 */
function initWalletStandardListener() {
  if (_standardListenerReady) return;
  _standardListenerReady = true;

  // The api object the wallet's callback expects: { register }
  const api = Object.freeze({ register: _registerStandardWallet });

  try {
    // Listen for wallets registering themselves
    window.addEventListener('wallet-standard:register-wallet', (event) => {
      const callback = event.detail;
      if (typeof callback === 'function') {
        callback(api);
      }
    });

    // Tell already-loaded wallets that we're ready to receive registrations
    window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', {
      detail: api,
      bubbles: false,
      cancelable: false,
    }));
  } catch (err) {
    console.warn('Wallet Standard listener init failed:', err);
  }
}

// Initialize immediately so we catch wallets that register early
initWalletStandardListener();

// ═══════════════════════════════════════════════════════════════════
// iOS Wallet Browse Deep Links
// ═══════════════════════════════════════════════════════════════════

/**
 * Returns the list of wallets available for iOS deep-link browsing.
 * Each entry has a name, icon (emoji/char), and a function to build the
 * browse URL that opens the current page inside the wallet's in-app browser.
 */
export function getIOSWalletOptions() {
  const currentUrl = encodeURIComponent(window.location.href);
  const ref = encodeURIComponent(window.location.origin);
  return [
    {
      name: 'Phantom',
      icon: '👻',
      browseUrl: `https://phantom.app/ul/browse/${currentUrl}?ref=${ref}`,
    },
    {
      name: 'Solflare',
      icon: '☀️',
      browseUrl: `https://solflare.com/ul/v1/browse/${currentUrl}?ref=${ref}`,
    },
    {
      name: 'Backpack',
      icon: '🎒',
      browseUrl: `https://backpack.app/ul/browse/${currentUrl}?ref=${ref}`,
    },
  ];
}

// ═══════════════════════════════════════════════════════════════════
// Wallet Discovery (legacy + standard)
// ═══════════════════════════════════════════════════════════════════

// Legacy wallet names to skip in standard results (prevents duplicates —
// prefer the legacy provider for these since their legacy APIs are mature)
const LEGACY_NAMES = new Set(['phantom', 'solflare']);

/** Returns array of { name, provider } for installed desktop wallets */
export function getAvailableWallets() {
  const wallets = [];
  const seen = new Set();

  // Legacy injected providers
  if (window.phantom?.solana?.isPhantom) {
    wallets.push({ name: 'Phantom', provider: window.phantom.solana });
    seen.add('phantom');
  }
  if (window.solflare?.isSolflare) {
    wallets.push({ name: 'Solflare', provider: window.solflare });
    seen.add('solflare');
  }

  // Wallet Standard providers (Jupiter, Backpack, and any future compliant wallets)
  for (const [name, stdWallet] of _standardWallets) {
    const lowerName = name.toLowerCase();
    // Skip if we already have a legacy provider for this wallet
    if (seen.has(lowerName)) continue;
    if ([...LEGACY_NAMES].some(ln => lowerName.includes(ln))) continue;

    wallets.push({ name, provider: wrapStandardWallet(stdWallet) });
    seen.add(lowerName);
  }

  return wallets;
}

// ── Desktop connect ──────────────────────────────────────────────

export async function connectDesktop(provider) {
  const resp = await provider.connect();
  _walletProvider = provider;

  provider.on?.('accountChanged', (pk) => {
    if (pk) { _setConnected(pk); }
    else { disconnect(); }
  });
  provider.on?.('disconnect', disconnect);

  // Phantom returns { publicKey } from connect(); Solflare/Standard set provider.publicKey
  const publicKey = resp?.publicKey ?? provider.publicKey;
  if (!publicKey) throw new Error('Wallet did not return a public key');
  _setConnected(publicKey);
}

/** Attempt silent reconnect */
export async function trySilentConnect() {
  const wallets = getAvailableWallets();
  if (wallets.length === 0) return false;
  try {
    const resp = await wallets[0].provider.connect({ onlyIfTrusted: true });
    _walletProvider = wallets[0].provider;
    const publicKey = resp?.publicKey ?? wallets[0].provider.publicKey;
    if (!publicKey) return false;
    _setConnected(publicKey);
    return true;
  } catch {
    return false;
  }
}

// ── Mobile connect (MWA) ─────────────────────────────────────────

export async function connectMobile() {
  await transact(async (wallet) => {
    const authResult = await wallet.authorize({
      chain: 'solana:mainnet-beta',
      identity: APP_IDENTITY,
    });
    _mobileAuthToken = authResult.auth_token;

    const binaryData = Buffer.from(authResult.accounts[0].address, 'base64');
    const base58Address = bs58.encode(binaryData);
    const publicKey = new PublicKey(base58Address);

    _walletProvider = {
      publicKey,
      signTransaction: async (transaction) => {
        return await transact(async (w) => {
          await w.reauthorize({ auth_token: _mobileAuthToken, identity: APP_IDENTITY });
          const signed = await w.signTransactions({ transactions: [transaction] });
          return signed[0];
        });
      },
      signAllTransactions: async (transactions) => {
        return await transact(async (w) => {
          await w.reauthorize({ auth_token: _mobileAuthToken, identity: APP_IDENTITY });
          return await w.signTransactions({ transactions });
        });
      },
      disconnect: async () => {
        _mobileAuthToken = null;
        disconnect();
      },
    };

    _setConnected(publicKey);
  });
}

// ── Disconnect ───────────────────────────────────────────────────

export async function disconnect() {
  const provider = _walletProvider;
  _walletContext = null;
  _walletProvider = null;
  _mobileAuthToken = null;
  _notify();
  try { await provider?.disconnect?.(); } catch {}
}

// ── Internal ─────────────────────────────────────────────────────

function _setConnected(publicKey) {
  _walletContext = { publicKey };
  _notify();
}