/**
 * @module wallet
 * Wallet connection logic — desktop injected providers + Solana Mobile Wallet Adapter.
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

export function isTelegramBrowser() {
  const ua = navigator.userAgent || navigator.vendor || window.opera;
  return /Telegram/i.test(ua) || window.TelegramWebviewProxy !== undefined ||
    window.Telegram !== undefined || typeof window.Telegram?.WebApp !== 'undefined';
}

export function isWalletBrowser() {
  return window.phantom?.solana?.isPhantom || window.solflare?.isSolflare || /Phantom|Solflare/i.test(navigator.userAgent);
}

/** Returns array of { name, provider } for installed desktop wallets */
export function getAvailableWallets() {
  const wallets = [];
  if (window.phantom?.solana?.isPhantom) wallets.push({ name: 'Phantom', provider: window.phantom.solana });
  if (window.solflare?.isSolflare) wallets.push({ name: 'Solflare', provider: window.solflare });
  if (window.jupiter?.solana) wallets.push({ name: 'Jupiter', provider: window.jupiter.solana });
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

  _setConnected(resp.publicKey);
}

/** Attempt silent reconnect */
export async function trySilentConnect() {
  const wallets = getAvailableWallets();
  if (wallets.length === 0) return false;
  try {
    const resp = await wallets[0].provider.connect({ onlyIfTrusted: true });
    _walletProvider = wallets[0].provider;
    _setConnected(resp.publicKey);
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
  try { await _walletProvider?.disconnect?.(); } catch {}
  _walletContext = null;
  _walletProvider = null;
  _mobileAuthToken = null;
  _notify();
}

// ── Internal ─────────────────────────────────────────────────────

function _setConnected(publicKey) {
  _walletContext = { publicKey };
  _notify();
}
