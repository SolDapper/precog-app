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
  TransactionInstruction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { RPC_URL, PROGRAM_ID, TOLERANCE, PRIORITY } from './config.js';

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
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,

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
      computeUnitMargin: TOLERANCE,
      priorityLevel: PRIORITY,
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

// Re-export token program constants
export { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID };

const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

/**
 * Derive the Associated Token Account address.
 */
export function getAssociatedTokenAddress(mint, owner, tokenProgramId = TOKEN_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgramId.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

/**
 * Build a createAssociatedTokenAccountIdempotent instruction.
 * Returns { ata: PublicKey, ix: TransactionInstruction }
 */
export function buildCreateATA(payer, owner, mint, tokenProgramId = TOKEN_PROGRAM_ID) {
  const [ata] = getAssociatedTokenAddress(mint, owner, tokenProgramId);
  const ix = new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: new PublicKey('11111111111111111111111111111111'), isSigner: false, isWritable: false },
      { pubkey: tokenProgramId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]), // 1 = CreateIdempotent
  });
  return { ata, ix };
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
  // Hand-craft the instruction data to match exact wire format
  const parts = [0x08]; // discriminator

  // Option<u16> new_default_fee_bps
  if (args.newDefaultFeeBps != null) {
    parts.push(1, args.newDefaultFeeBps & 0xff, (args.newDefaultFeeBps >> 8) & 0xff);
  } else {
    parts.push(0);
  }

  // Option<[u8; 32]> new_treasury
  if (args.newTreasury != null) {
    parts.push(1);
    const buf = args.newTreasury instanceof PublicKey ? args.newTreasury.toBuffer() : args.newTreasury;
    for (let i = 0; i < 32; i++) parts.push(buf[i]);
  } else {
    parts.push(0);
  }

  // Option<bool> paused
  if (args.paused != null) {
    parts.push(1, args.paused ? 1 : 0);
  } else {
    parts.push(0);
  }

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: accounts.protocolConfig, isSigner: false, isWritable: true },
      { pubkey: accounts.admin, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(parts),
  });
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
export async function signAndSend(instructionOrArray, signerPublicKey, walletProvider, opts = {}) {
  const conn = getConnection();
  const client = getClient();
  const instructions = Array.isArray(instructionOrArray) ? instructionOrArray : [instructionOrArray];

  let cuIx, feeIx;
  if (!opts.skipEstimation) {
    try {
      const [cuResult, feeResult] = await Promise.allSettled([
        client.estimateComputeUnits(instructions, signerPublicKey),
        client.estimatePriorityFee(instructions, signerPublicKey),
      ]);

      if (cuResult.status === 'fulfilled') cuIx = cuResult.value.instruction;
      else console.warn('CU estimation failed:', cuResult.reason);
      if (feeResult.status === 'fulfilled') feeIx = feeResult.value.instruction;
      else console.warn('Priority fee estimation failed:', feeResult.reason);
    } catch (err) {
      console.warn('Fee estimation failed, sending without compute budget:', err);
    }
  }

  // Build transaction: [CU limit, priority fee, ...instructions]
  // If CU estimation failed, set a generous default so the real error surfaces
  const tx = new Transaction();
  if (cuIx) {
    tx.add(cuIx);
  } else {
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: opts.cuLimit || 1_400_000 }));
  }
  if (feeIx) tx.add(feeIx);
  for (const ix of instructions) tx.add(ix);

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = signerPublicKey;

  if (!opts.skipSimulation) {
    // Simulate before signing to catch errors early
    const simResult = await conn.simulateTransaction(tx);
    if (simResult.value.err) {
      const logs = simResult.value.logs || [];
      console.error('=== Transaction simulation failed ===');
      console.error('Error:', JSON.stringify(simResult.value.err, null, 2));
      console.error('Logs:');
      logs.forEach((l, i) => console.error(`  [${i}] ${l}`));
      console.error('Instruction keys:');
      instructions.forEach((ix, i) => {
        console.error(`  IX ${i} program: ${ix.programId.toBase58()}`);
        console.error(`  IX ${i} data (hex): ${Buffer.from(ix.data).toString('hex')}`);
        ix.keys.forEach((k, j) => console.error(`    [${j}] ${k.pubkey.toBase58()} signer=${k.isSigner} writable=${k.isWritable}`));
      });
      console.error('=== End simulation error ===');
      const errorLog = logs.filter(l => l.includes('Error') || l.includes('error') || l.includes('failed')).pop();
      const errMsg = errorLog
        ? errorLog.replace(/^Program log: /, '')
        : JSON.stringify(simResult.value.err);
      throw new Error(`Simulation failed: ${errMsg}`);
    }
  }

  // Sign via wallet adapter
  const signedTx = await walletProvider.signTransaction(tx);

  // Send with SWQoS-optimized settings
  const sig = await conn.sendRawTransaction(signedTx.serialize(), {
    skipPreflight: true,
    maxRetries: 0,
  });

  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
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