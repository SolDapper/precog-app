/**
 * @module gate
 * Token-gated access control. Checks whether the connected wallet holds
 * any amount (>0) of at least one token from the configured gate list.
 *
 * When TOKEN_GATE is empty, the gate is disabled and all wallets pass.
 */
import { PublicKey } from '@solana/web3.js';
import { TOKEN_GATE } from './config.js';
import { getConnection } from './sdk.js';

// ── Parse gate mints from CSV config ─────────────────────────────

/** @type {PublicKey[]} */
const GATE_MINTS = TOKEN_GATE
  ? TOKEN_GATE.split(',').map(s => s.trim()).filter(Boolean).map(s => new PublicKey(s))
  : [];

/** Whether the gate is active (at least one mint configured). */
export const gateEnabled = GATE_MINTS.length > 0;

// ── Cache ────────────────────────────────────────────────────────

/** @type {Map<string, { passed: boolean, ts: number }>} */
const _cache = new Map();
const CACHE_TTL_MS = 30_000; // 30 seconds

/** Clear cache (call on wallet disconnect). */
export function clearGateCache() { _cache.clear(); }

// ── Token-2022 program ID ────────────────────────────────────────

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

// ── Core check ───────────────────────────────────────────────────

/**
 * Check whether a wallet passes the token gate.
 * Returns `true` if the gate is disabled or the wallet holds >0 of any gate mint.
 * Results are cached for 30 seconds per wallet.
 *
 * @param {PublicKey} walletPubkey
 * @returns {Promise<boolean>}
 */
export async function checkGate(walletPubkey) {
  if (!gateEnabled) return true;

  const key = walletPubkey.toBase58();
  const cached = _cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.passed;

  const conn = getConnection();
  let passed = false;
  const gateMintSet = new Set(GATE_MINTS.map(m => m.toBase58()));

  // Check both SPL Token and Token-2022 programs
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    if (passed) break;
    try {
      const resp = await conn.getParsedTokenAccountsByOwner(walletPubkey, {
        programId,
      });
      for (const { account } of resp.value) {
        const info = account.data.parsed?.info;
        if (!info) continue;
        const mint = info.mint;
        const rawAmount = info.tokenAmount?.amount;
        if (gateMintSet.has(mint) && rawAmount && BigInt(rawAmount) > 0n) {
          passed = true;
          break;
        }
      }
    } catch {
      // RPC error — continue to next program
    }
  }

  _cache.set(key, { passed, ts: Date.now() });
  return passed;
}

// ── Token metadata for UI messages ───────────────────────────────

/** @type {Map<string, { symbol: string, name: string }>} */
const _metaCache = new Map();

/**
 * Fetch on-chain metadata for gate tokens. Returns an array of
 * `{ mint, symbol, name }` for each configured gate mint.
 * Falls back to a truncated address if metadata is unavailable.
 *
 * @returns {Promise<Array<{ mint: string, symbol: string, name: string }>>}
 */
export async function getGateTokenInfo() {
  if (!gateEnabled) return [];

  const conn = getConnection();
  const results = [];

  for (const mint of GATE_MINTS) {
    const addr = mint.toBase58();

    if (_metaCache.has(addr)) {
      results.push({ mint: addr, ..._metaCache.get(addr) });
      continue;
    }

    let symbol = addr.slice(0, 4) + '…' + addr.slice(-4);
    let name = 'Unknown Token';

    try {
      const info = await conn.getParsedAccountInfo(mint);
      if (info.value?.data?.parsed?.info) {
        // Some parsed mint data doesn't include name/symbol
      }
    } catch { /* ignore */ }

    // Try Metaplex token metadata (most common source for name/symbol)
    try {
      const METADATA_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
      const [metadataPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('metadata'), METADATA_PROGRAM.toBuffer(), mint.toBuffer()],
        METADATA_PROGRAM
      );
      const acct = await conn.getAccountInfo(metadataPda);
      if (acct?.data) {
        const parsed = parseMetaplexMetadata(acct.data);
        if (parsed.symbol) symbol = parsed.symbol;
        if (parsed.name) name = parsed.name;
      }
    } catch { /* no metadata — use fallback */ }

    _metaCache.set(addr, { symbol, name });
    results.push({ mint: addr, symbol, name });
  }

  return results;
}

/**
 * Minimal Metaplex token metadata v1 parser.
 * Layout: 1 byte key, 32 bytes update_authority, 32 bytes mint,
 *         then borsh string (4-byte LE len + bytes) for name,
 *         then borsh string for symbol.
 */
function parseMetaplexMetadata(data) {
  let offset = 1 + 32 + 32; // key + update_authority + mint
  const readString = () => {
    if (offset + 4 > data.length) return '';
    const len = data.readUInt32LE(offset); offset += 4;
    if (offset + len > data.length) return '';
    const s = data.slice(offset, offset + len).toString('utf8'); offset += len;
    // Metaplex pads with null bytes
    return s.replace(/\0+$/g, '').trim();
  };
  const name = readString();
  const symbol = readString();
  return { name, symbol };
}