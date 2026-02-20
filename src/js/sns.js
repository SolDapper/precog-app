/**
 * @module sns
 * SNS (.sol) domain name resolution with local cache.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { getMultiplePrimaryDomains } from '@bonfida/spl-name-service';
import { RPC_URL } from './config.js';

const _cache = {};
let _connection = null;

function getConnection() {
  if (!_connection) _connection = new Connection(RPC_URL, 'confirmed');
  return _connection;
}

/**
 * Resolve a wallet address to its .sol name, or return a truncated address.
 * @param {string} address - Base58 wallet address
 * @returns {Promise<string>}
 */
export async function resolveDisplayName(address) {
  if (_cache[address]) return _cache[address];

  const short = address.slice(0, 4) + '…' + address.slice(-4);

  try {
    const conn = getConnection();
    const primaryDomains = await getMultiplePrimaryDomains(conn, [new PublicKey(address)]);
    if (primaryDomains && primaryDomains.length > 0) {
      const primaryDomain = primaryDomains[0];
      if (primaryDomain) {
        const display = primaryDomain + '.sol';
        _cache[address] = display;
        return display;
      }
    }
  } catch (err) {
    // SNS lookup failed
  }

  _cache[address] = short;
  return short;
}

/** Batch resolve — returns array of display names in same order */
export async function resolveDisplayNames(addresses) {
  try {
    const conn = getConnection();
    const pks = addresses.map(a => new PublicKey(a));
    const primaryDomains = await getMultiplePrimaryDomains(conn, pks);

    return addresses.map((addr, i) => {
      if (_cache[addr]) return _cache[addr];
      const primaryDomain = primaryDomains?.[i];
      if (primaryDomain) {
        const display = primaryDomain + '.sol';
        _cache[addr] = display;
        return display;
      }
      const short = addr.slice(0, 4) + '…' + addr.slice(-4);
      _cache[addr] = short;
      return short;
    });
  } catch {
    return addresses.map(addr => {
      if (_cache[addr]) return _cache[addr];
      const short = addr.slice(0, 4) + '…' + addr.slice(-4);
      _cache[addr] = short;
      return short;
    });
  }
}

/** Short address without SNS lookup */
export function shortAddress(address) {
  return address.slice(0, 4) + '…' + address.slice(-4);
}