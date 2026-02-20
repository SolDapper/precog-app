/**
 * @module sdk
 * Bridge between the Pelfmont app and the precog-markets SDK.
 * Uses PrecogMarketsClient for smart transactions (CU estimation,
 * priority fees, SWQoS-optimized sending).
 */
import {
  Connection,
  PublicKey,
  Transaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { RPC_URL, PROGRAM_ID } from './config.js';

// ── Re-exports from precog-markets SDK ────────────────────────────
import {
  // PDA derivation
  findProtocolConfigAddress,
  findMarketAddress,
  findVaultAddress,
  findVaultAuthorityAddress,
  findPositionAddress,
  findMultisigAddress,
  findProposalAddress,

  // Account decoders
  decodeMarket,
  decodeUserPosition,
  decodeProtocolConfig,

  // Instruction builders
  initializeProtocol,
  createMarket,
  placeBet,
  resolveMarket,
  finalizeMarket,
  claimWinnings,
  voidMarket,
  claimRefund,
  updateProtocolConfig,

  // Constants
  ACCOUNT_DISCRIMINATORS,

  // Client
  PrecogMarketsClient,
} from 'precog-markets';

// ═══════════════════════════════════════════════════════════════════
// Connection & Client singletons
// ═══════════════════════════════════════════════════════════════════

let _connection = null;
export function getConnection() {
  if (!_connection) _connection = new Connection(RPC_URL, 'confirmed');
  return _connection;
}

let _client = null;
function getClient() {
  if (!_client) {
    _client = new PrecogMarketsClient(getConnection(), {
      programId: PROGRAM_ID,
      computeUnitMargin: 1.1,
      priorityLevel: 'Medium',
    });
  }
  return _client;
}

// ═══════════════════════════════════════════════════════════════════
// PDA wrappers (use app PROGRAM_ID)
// ═══════════════════════════════════════════════════════════════════

export function findProtocolConfig() {
  return findProtocolConfigAddress(PROGRAM_ID);
}
export function findMarket(authority, marketId) {
  return findMarketAddress(authority, marketId, PROGRAM_ID);
}
export function findVault(market) {
  return findVaultAddress(market, PROGRAM_ID);
}
export function findVaultAuthority(market) {
  return findVaultAuthorityAddress(market, PROGRAM_ID);
}
export function findPosition(market, owner, outcomeIndex) {
  return findPositionAddress(market, owner, outcomeIndex, PROGRAM_ID);
}
export function findMultisig(creator, nonce) {
  return findMultisigAddress(creator, nonce, PROGRAM_ID);
}
export function findProposal(multisig, proposalId) {
  return findProposalAddress(multisig, proposalId, PROGRAM_ID);
}

// ═══════════════════════════════════════════════════════════════════
// Instruction builder wrappers (inject app PROGRAM_ID)
// ═══════════════════════════════════════════════════════════════════

export function buildInitializeProtocol(accounts, args) {
  return initializeProtocol(accounts, args, PROGRAM_ID);
}

export function buildCreateMarket(accounts, args) {
  return createMarket(accounts, args, PROGRAM_ID);
}

export function buildPlaceBet(accounts, args) {
  return placeBet(accounts, args, PROGRAM_ID);
}

export function buildResolveMarket(accounts, args) {
  return resolveMarket(accounts, args, PROGRAM_ID);
}

export function buildFinalizeMarket(market) {
  return finalizeMarket({ market }, PROGRAM_ID);
}

export function buildClaimWinnings(accounts) {
  return claimWinnings(accounts, PROGRAM_ID);
}

export function buildVoidMarket(accounts) {
  return voidMarket(accounts, PROGRAM_ID);
}

export function buildClaimRefund(accounts) {
  return claimRefund(accounts, PROGRAM_ID);
}

export function buildUpdateProtocolConfig(accounts, args) {
  return updateProtocolConfig(accounts, args, PROGRAM_ID);
}

// ═══════════════════════════════════════════════════════════════════
// Base58 encoder for memcmp filter bytes
// ═══════════════════════════════════════════════════════════════════

const BS58_ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function bs58Encode(buf) {
  const bytes = [...buf];
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [0];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) { carry += digits[j] * 256; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  return BS58_ALPHA[0].repeat(zeros) + digits.reverse().map(d => BS58_ALPHA[d]).join('');
}

// ═══════════════════════════════════════════════════════════════════
// Fetch helpers
// ═══════════════════════════════════════════════════════════════════

/**
 * Fetch all Market accounts, optionally filtered by status.
 * @param {{ status?: number }} [filters]
 * @returns {Promise<Array<{ pubkey: PublicKey, account: Object }>>}
 */
export async function fetchAllMarkets(filters = {}) {
  const conn = getConnection();
  const accounts = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: bs58Encode(ACCOUNT_DISCRIMINATORS.MARKET) } }],
  });

  const results = [];
  for (const { pubkey, account } of accounts) {
    try {
      const decoded = decodeMarket(account.data);
      if (filters.status !== undefined && decoded.status !== filters.status) continue;
      results.push({ pubkey, account: decoded });
    } catch {
      // Decode failure — skip
    }
  }
  return results;
}

/** Fetch a single market by address */
export async function fetchMarket(address) {
  const conn = getConnection();
  const info = await conn.getAccountInfo(address);
  if (!info) return null;
  return decodeMarket(info.data);
}

/** Fetch all positions for a wallet */
export async function fetchPositionsByOwner(owner) {
  const conn = getConnection();
  // owner is at offset: 8 (disc) + 1 (bump) + 32 (market) = 41
  const accounts = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [
      { memcmp: { offset: 0, bytes: bs58Encode(ACCOUNT_DISCRIMINATORS.USER_POSITION) } },
      { memcmp: { offset: 41, bytes: owner.toBase58() } },
    ],
  });
  const results = [];
  for (const { pubkey, account } of accounts) {
    try {
      results.push({ pubkey, account: decodeUserPosition(account.data) });
    } catch {}
  }
  return results;
}

/** Fetch protocol config */
export async function fetchProtocolConfig() {
  const conn = getConnection();
  const [addr] = await findProtocolConfig();
  const info = await conn.getAccountInfo(addr);
  if (!info) return null;
  return decodeProtocolConfig(info.data);
}

// ═══════════════════════════════════════════════════════════════════
// Smart transaction signing (browser wallet adapter)
// ═══════════════════════════════════════════════════════════════════

/**
 * Build a smart transaction with CU estimation + priority fee,
 * sign via wallet adapter, and send with SWQoS settings.
 *
 * @param {TransactionInstruction} instruction - The program instruction
 * @param {PublicKey} signerPublicKey - Fee payer / signer
 * @param {Object} walletProvider - Wallet adapter provider (.signTransaction)
 * @returns {Promise<string>} transaction signature
 */
export async function signAndSend(instruction, signerPublicKey, walletProvider) {
  const conn = getConnection();
  const client = getClient();
  const instructions = [instruction];

  let cuIx, feeIx;
  try {
    // Estimate CU and priority fee in parallel
    const [cuResult, feeResult] = await Promise.allSettled([
      client.estimateComputeUnits(instructions, signerPublicKey),
      client.estimatePriorityFee(instructions, signerPublicKey),
    ]);

    if (cuResult.status === 'fulfilled') cuIx = cuResult.value.instruction;
    if (feeResult.status === 'fulfilled') feeIx = feeResult.value.instruction;
  } catch (err) {
    console.warn('Fee estimation failed, sending without compute budget:', err);
  }

  // Build transaction: [CU limit, priority fee, ...instructions]
  const tx = new Transaction();
  if (cuIx) tx.add(cuIx);
  if (feeIx) tx.add(feeIx);
  tx.add(instruction);

  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  tx.feePayer = signerPublicKey;

  // Sign via wallet adapter
  const signedTx = await walletProvider.signTransaction(tx);

  // Send with SWQoS-optimized settings
  const sig = await conn.sendRawTransaction(signedTx.serialize(), {
    skipPreflight: true,
    maxRetries: 0,
  });

  await conn.confirmTransaction(sig, 'confirmed');
  return sig;
}

// ═══════════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════════

export function lamportsToSol(lamports) {
  return Number(lamports) / LAMPORTS_PER_SOL;
}

export function solToLamports(sol) {
  return BigInt(Math.round(sol * LAMPORTS_PER_SOL));
}

export function getImpliedProbabilities(outcomePools, totalPool) {
  const t = Number(totalPool);
  if (t === 0) return outcomePools.map(() => 0);
  return outcomePools.map(p => Number(p) / t);
}

export function calculatePayout(positionAmount, winningPool, totalPool, feeBps) {
  const pos = BigInt(positionAmount), win = BigInt(winningPool), tot = BigInt(totalPool);
  if (win === 0n || tot === 0n) return 0n;
  const gross = (pos * tot) / win;
  const fee = (gross * BigInt(feeBps)) / 10000n;
  return gross - fee;
}

export function formatTokenAmount(amount, decimals = 9) {
  const n = Number(amount) / (10 ** decimals);
  return n >= 1000 ? n.toFixed(1) : n >= 1 ? n.toFixed(2) : n.toFixed(Math.min(4, decimals));
}