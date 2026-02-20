/**
 * @module sdk
 * Bridge between the app and the precog-markets SDK.
 * Provides a single initialized client + helper functions.
 *
 * NOTE: Since precog-markets SDK is a local package, this module
 * inlines the essential SDK functionality. In production you'd
 * import from the installed 'precog-markets' package.
 */
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { RPC_URL, PROGRAM_ID } from './config.js';

// ═══════════════════════════════════════════════════════════════════
// Connection singleton
// ═══════════════════════════════════════════════════════════════════

let _connection = null;
export function getConnection() {
  if (!_connection) _connection = new Connection(RPC_URL, 'confirmed');
  return _connection;
}

// ═══════════════════════════════════════════════════════════════════
// Inline Borsh Writer
// ═══════════════════════════════════════════════════════════════════

class BW {
  constructor(cap = 512) { this.buf = Buffer.alloc(cap); this.o = 0; }
  _g(n) { while (this.o + n > this.buf.length) { const b = Buffer.alloc(this.buf.length * 2); this.buf.copy(b); this.buf = b; } }
  done() { return this.buf.subarray(0, this.o); }
  u8(v) { this._g(1); this.buf.writeUInt8(v, this.o); this.o += 1; return this; }
  u16(v) { this._g(2); this.buf.writeUInt16LE(v, this.o); this.o += 2; return this; }
  u32(v) { this._g(4); this.buf.writeUInt32LE(v, this.o); this.o += 4; return this; }
  u64(v) { this._g(8); this.buf.writeBigUInt64LE(BigInt(v), this.o); this.o += 8; return this; }
  i64(v) { this._g(8); this.buf.writeBigInt64LE(BigInt(v), this.o); this.o += 8; return this; }
  bool(v) { return this.u8(v ? 1 : 0); }
  str(s) { const b = Buffer.from(s, 'utf-8'); this.u32(b.length); this._g(b.length); b.copy(this.buf, this.o); this.o += b.length; return this; }
  bytes(d) { this._g(d.length); Buffer.from(d).copy(this.buf, this.o); this.o += d.length; return this; }
  pk(p) { return this.bytes(p.toBuffer()); }
  vec(arr, fn) { this.u32(arr.length); for (const a of arr) fn(this, a); return this; }
  opt(v, fn) { if (v == null) this.u8(0); else { this.u8(1); fn(this, v); } return this; }
}

// ═══════════════════════════════════════════════════════════════════
// Inline Borsh Reader
// ═══════════════════════════════════════════════════════════════════

class BR {
  constructor(data) { this.buf = Buffer.from(data); this.o = 0; }
  _c(n) { if (this.o + n > this.buf.length) throw new RangeError('read past end'); }
  u8() { this._c(1); const v = this.buf.readUInt8(this.o); this.o += 1; return v; }
  u16() { this._c(2); const v = this.buf.readUInt16LE(this.o); this.o += 2; return v; }
  u32() { this._c(4); const v = this.buf.readUInt32LE(this.o); this.o += 4; return v; }
  u64() { this._c(8); const v = this.buf.readBigUInt64LE(this.o); this.o += 8; return v; }
  i64() { this._c(8); const v = this.buf.readBigInt64LE(this.o); this.o += 8; return v; }
  bool() { return this.u8() !== 0; }
  fixedBytes(n) { this._c(n); const s = this.buf.subarray(this.o, this.o + n); this.o += n; return Buffer.from(s); }
  pk() { return new PublicKey(this.fixedBytes(32)); }
  skip(n) { this._c(n); this.o += n; }
}

// ═══════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════

const SEEDS = {
  PROTOCOL_CONFIG: Buffer.from('protocol_config'),
  MARKET: Buffer.from('market'),
  VAULT: Buffer.from('vault'),
  VAULT_AUTHORITY: Buffer.from('vault_authority'),
  POSITION: Buffer.from('position'),
  MULTISIG: Buffer.from('multisig'),
  PROPOSAL: Buffer.from('proposal'),
};

const DISC = {
  INIT_PROTOCOL:    Buffer.from([0]),
  CREATE_MARKET:    Buffer.from([1]),
  PLACE_BET:        Buffer.from([2]),
  RESOLVE_MARKET:   Buffer.from([3]),
  FINALIZE_MARKET:  Buffer.from([4]),
  CLAIM_WINNINGS:   Buffer.from([5]),
  VOID_MARKET:      Buffer.from([6]),
  CLAIM_REFUND:     Buffer.from([7]),
  UPDATE_CONFIG:    Buffer.from([8]),
  CREATE_MULTISIG:  Buffer.from([9]),
  CREATE_PROPOSAL:  Buffer.from([10]),
  APPROVE_PROPOSAL: Buffer.from([11]),
  EXECUTE_PROPOSAL: Buffer.from([12]),
  HARVEST:          Buffer.from([13]),
};

const STATUS_MAP = { 0: 'Open', 1: 'Resolved', 2: 'Finalized', 3: 'Voided' };
const DENOM_MAP = { 0: 'NativeSol', 1: 'SplToken', 2: 'Token2022' };
const MAX_OUTCOMES = 10;

// Account discriminators (8-byte magic headers)
const ACCOUNT_DISC = {
  MARKET:          Buffer.from([0x4d, 0x41, 0x52, 0x4b, 0x45, 0x54, 0x56, 0x32]), // MARKETV2
  USER_POSITION:   Buffer.from([0x50, 0x4f, 0x53, 0x49, 0x54, 0x4e, 0x56, 0x31]), // POSITNV1
  PROTOCOL_CONFIG: Buffer.from([0x50, 0x52, 0x4f, 0x54, 0x4f, 0x43, 0x4f, 0x4c]), // PROTOCOL
  MULTISIG:        Buffer.from([0x4d, 0x55, 0x4c, 0x54, 0x53, 0x49, 0x47, 0x31]), // MULTSIG1
  PROPOSAL:        Buffer.from([0x50, 0x52, 0x4f, 0x50, 0x4f, 0x53, 0x4c, 0x31]), // PROPOSL1
};

function u64le(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; }
function meta(pk, signer, mut) { return { pubkey: pk, isSigner: signer, isWritable: mut }; }

// Minimal base58 encoder for memcmp filter bytes
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
function ws(pk) { return meta(pk, true, true); }
function rs(pk) { return meta(pk, true, false); }
function w(pk) { return meta(pk, false, true); }
function ro(pk) { return meta(pk, false, false); }

// ═══════════════════════════════════════════════════════════════════
// PDA derivation
// ═══════════════════════════════════════════════════════════════════

export function findProtocolConfig() {
  return PublicKey.findProgramAddress([SEEDS.PROTOCOL_CONFIG], PROGRAM_ID);
}
export function findMarket(authority, marketId) {
  return PublicKey.findProgramAddress([SEEDS.MARKET, authority.toBuffer(), u64le(marketId)], PROGRAM_ID);
}
export function findVault(market) {
  return PublicKey.findProgramAddress([SEEDS.VAULT, market.toBuffer()], PROGRAM_ID);
}
export function findVaultAuthority(market) {
  return PublicKey.findProgramAddress([SEEDS.VAULT_AUTHORITY, market.toBuffer()], PROGRAM_ID);
}
export function findPosition(market, owner, outcomeIndex) {
  return PublicKey.findProgramAddress([SEEDS.POSITION, market.toBuffer(), owner.toBuffer(), Buffer.from([outcomeIndex])], PROGRAM_ID);
}
export function findMultisig(creator, nonce) {
  return PublicKey.findProgramAddress([SEEDS.MULTISIG, creator.toBuffer(), u64le(nonce)], PROGRAM_ID);
}
export function findProposal(multisig, proposalId) {
  return PublicKey.findProgramAddress([SEEDS.PROPOSAL, multisig.toBuffer(), u64le(proposalId)], PROGRAM_ID);
}

// ═══════════════════════════════════════════════════════════════════
// Account decoders
// ═══════════════════════════════════════════════════════════════════

function decFixStr(buf, len) { return Buffer.from(buf).subarray(0, len).toString('utf-8'); }

export function decodeMarket(data) {
  const r = new BR(data);
  const disc = r.fixedBytes(8);
  const bump = r.u8();
  const marketId = r.u64();
  const authority = r.pk();
  const authorityIsMultisig = r.bool();
  const status = r.u8();
  const resolutionDeadline = r.i64();
  const resolvedAt = r.i64();
  const winningOutcome = r.u8();
  const feeBps = r.u16();
  const feesCollected = r.u64();
  const numOutcomes = r.u8();
  const outcomePools = [];
  for (let i = 0; i < MAX_OUTCOMES; i++) outcomePools.push(r.u64());
  const totalPool = r.u64();
  const totalPositions = r.u64();
  const denomination = r.u8();
  const tokenMint = r.pk();
  const tokenDecimals = r.u8();
  const hasTransferFee = r.bool();
  const transferFeeBps = r.u16();
  const maxTransferFee = r.u64();
  const titleBytes = r.fixedBytes(128);
  const titleLen = r.u16();
  const descBytes = r.fixedBytes(512);
  const descLen = r.u16();
  const rawLabels = [];
  for (let i = 0; i < MAX_OUTCOMES; i++) rawLabels.push(r.fixedBytes(64));
  const labelLens = [];
  for (let i = 0; i < MAX_OUTCOMES; i++) labelLens.push(r.u16());
  const outcomeLabels = [];
  for (let i = 0; i < numOutcomes; i++) outcomeLabels.push(decFixStr(rawLabels[i], labelLens[i]));
  // skip reserved (209 bytes)

  return {
    bump, marketId, authority, authorityIsMultisig,
    status, statusName: STATUS_MAP[status] ?? `Unknown(${status})`,
    resolutionDeadline, resolvedAt, winningOutcome,
    feeBps, feesCollected, numOutcomes,
    outcomePools: outcomePools.slice(0, numOutcomes),
    totalPool, totalPositions,
    denomination, denominationName: DENOM_MAP[denomination] ?? `Unknown(${denomination})`,
    tokenMint, tokenDecimals,
    hasTransferFee, transferFeeBps, maxTransferFee,
    title: decFixStr(titleBytes, titleLen),
    description: decFixStr(descBytes, descLen),
    outcomeLabels,
  };
}

export function decodeUserPosition(data) {
  const r = new BR(data);
  r.fixedBytes(8); // disc
  return {
    bump: r.u8(), market: r.pk(), owner: r.pk(),
    outcomeIndex: r.u8(), amount: r.u64(), claimed: r.bool(), lastDepositAt: r.i64(),
    // skip reserved (64 bytes)
  };
}

export function decodeProtocolConfig(data) {
  const r = new BR(data);
  r.fixedBytes(8);
  return {
    bump: r.u8(), admin: r.pk(), defaultFeeBps: r.u16(),
    treasury: r.pk(), paused: r.bool(),
    totalMarketsCreated: r.u64(), totalVolume: r.u64(),
    // skip reserved (128 bytes)
  };
}

// ═══════════════════════════════════════════════════════════════════
// Instruction builders
// ═══════════════════════════════════════════════════════════════════

export function buildInitializeProtocol(accounts, args) {
  const wr = new BW();
  wr.bytes(DISC.INIT_PROTOCOL);
  wr.u16(args.defaultFeeBps);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      w(accounts.protocolConfig),
      ws(accounts.admin),
      ro(accounts.treasury),
      ro(SystemProgram.programId),
    ],
    data: wr.done(),
  });
}

export function buildCreateMarket(accounts, args) {
  const wr = new BW(1024);
  wr.bytes(DISC.CREATE_MARKET);
  wr.u64(args.marketId);
  wr.str(args.title);
  wr.str(args.description);
  wr.vec(args.outcomeLabels, (w, s) => w.str(s));
  wr.i64(args.resolutionDeadline);
  wr.opt(args.feeBpsOverride, (w, v) => w.u16(v));
  wr.u8(args.denomination);
  wr.bool(args.authorityIsMultisig ?? false);

  const keys = [
    w(accounts.market), w(accounts.vault), ro(accounts.authority),
    ws(accounts.payer), w(accounts.protocolConfig), ro(SystemProgram.programId),
  ];
  if (accounts.tokenMint) {
    keys.push(ro(accounts.tokenMint), ro(accounts.vaultAuthority),
      w(accounts.tokenVault), ro(accounts.tokenProgram), ro(SYSVAR_RENT_PUBKEY));
  }
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data: wr.done() });
}

export function buildPlaceBet(accounts, args) {
  const wr = new BW();
  wr.bytes(DISC.PLACE_BET);
  wr.u8(args.outcomeIndex);
  wr.u64(args.amount);
  const keys = [
    w(accounts.market), w(accounts.vault), w(accounts.position),
    ws(accounts.bettor), ro(SystemProgram.programId),
  ];
  if (accounts.bettorTokenAccount) {
    keys.push(w(accounts.bettorTokenAccount), w(accounts.tokenVault),
      ro(accounts.tokenMint), ro(accounts.tokenProgram), ro(accounts.vaultAuthority));
  }
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data: wr.done() });
}

export function buildResolveMarket(accounts, args) {
  const wr = new BW();
  wr.bytes(DISC.RESOLVE_MARKET);
  wr.u8(args.winningOutcome);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [w(accounts.market), rs(accounts.authority)],
    data: wr.done(),
  });
}

export function buildFinalizeMarket(market) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [w(market)],
    data: Buffer.from(DISC.FINALIZE_MARKET),
  });
}

export function buildClaimWinnings(accounts) {
  const keys = [
    ro(accounts.market), w(accounts.vault), w(accounts.position),
    ws(accounts.claimant), ro(accounts.protocolConfig), w(accounts.treasury),
    ro(SystemProgram.programId),
  ];
  if (accounts.claimantTokenAccount) {
    keys.push(w(accounts.claimantTokenAccount), w(accounts.treasuryTokenAccount),
      w(accounts.tokenVault), ro(accounts.vaultAuthority),
      ro(accounts.tokenMint), ro(accounts.tokenProgram));
  }
  return new TransactionInstruction({
    programId: PROGRAM_ID, keys, data: Buffer.from(DISC.CLAIM_WINNINGS),
  });
}

export function buildVoidMarket(accounts) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [w(accounts.market), rs(accounts.authority)],
    data: Buffer.from(DISC.VOID_MARKET),
  });
}

export function buildClaimRefund(accounts) {
  const keys = [
    ro(accounts.market), w(accounts.vault), w(accounts.position),
    ws(accounts.claimant), ro(SystemProgram.programId),
  ];
  if (accounts.claimantTokenAccount) {
    keys.push(w(accounts.claimantTokenAccount), w(accounts.tokenVault),
      ro(accounts.vaultAuthority), ro(accounts.tokenMint), ro(accounts.tokenProgram));
  }
  return new TransactionInstruction({
    programId: PROGRAM_ID, keys, data: Buffer.from(DISC.CLAIM_REFUND),
  });
}

// ═══════════════════════════════════════════════════════════════════
// High-level operations
// ═══════════════════════════════════════════════════════════════════

/**
 * Fetch all Market accounts, optionally filtered by status.
 * @param {{ status?: number }} [filters]
 * @returns {Promise<Array<{ pubkey: PublicKey, account: Object }>>}
 */
export async function fetchAllMarkets(filters = {}) {
  const conn = getConnection();
  const accounts = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: bs58Encode(ACCOUNT_DISC.MARKET) } }],
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
      { memcmp: { offset: 0, bytes: bs58Encode(ACCOUNT_DISC.USER_POSITION) } },
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

/** Send a transaction with wallet signing */
export async function signAndSend(instruction, signerPublicKey, walletProvider) {
  const conn = getConnection();
  const tx = new Transaction().add(instruction);
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.feePayer = signerPublicKey;

  const signedTx = await walletProvider.signTransaction(tx);
  const signature = await conn.sendRawTransaction(signedTx.serialize());
  await conn.confirmTransaction(signature, 'confirmed');
  return signature;
}

// ═══════════════════════════════════════════════════════════════════
// Utility
// ═══════════════════════════════════════════════════════════════════

export function lamportsToSol(lamports) {
  return Number(lamports) / LAMPORTS_PER_SOL;
}

export function solToLamports(sol) {
  return BigInt(Math.round(sol * LAMPORTS_PER_SOL));
}

export function getImpliedProbabilities(outcomePools, totalPool) {
  if (totalPool === 0n) return outcomePools.map(() => 0);
  return outcomePools.map(p => Number((p * 10000n) / totalPool) / 10000);
}

export function calculatePayout(positionAmount, winningPool, totalPool, feeBps) {
  if (winningPool === 0n) return { gross: 0n, fee: 0n, net: 0n };
  const gross = (positionAmount * totalPool) / winningPool;
  const fee = (gross * BigInt(feeBps)) / 10000n;
  return { gross, fee, net: gross - fee };
}