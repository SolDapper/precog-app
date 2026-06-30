/**
 * @module config
 * App-wide configuration. Override via env vars at build time.
 */
import { PublicKey } from '@solana/web3.js';

export const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';
export const WSS_URL = process.env.WSS_URL || 'wss://api.devnet.solana.com';
export const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || '6KfoCcTUVsS8i1h31dhK8cydvDXGmRyTdya7jbjoymn9'
);

export const APP_IDENTITY = {
  name: 'Precog Markets',
  uri: 'https://x.com/SolDapper',
  icon: '/.well-known/icon.png',
};

// Polling intervals
export const MARKET_POLL_MS = 20_000;
export const PRICE_CACHE_MS = 60_000;

// Compute budget
export const TOLERANCE = parseFloat(process.env.TOLERANCE) || 1.1;
export const PRIORITY = process.env.PRIORITY || 'Medium';

// SOL price
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Token gate — comma-separated mint addresses. Wallet must hold >0 of ANY listed token.
// Leave empty string to disable gate (open access).
export const TOKEN_GATE = process.env.TOKEN_GATE || '';