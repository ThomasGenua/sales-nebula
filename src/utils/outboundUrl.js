/**
 * Guard for URLs the server will fetch on a user's behalf.
 *
 * A webhook target is supplied by a person and requested by the server, so an
 * unchecked one turns the application into a proxy for whatever it can reach:
 * the cloud metadata endpoint, a database admin port on localhost, anything
 * else inside the private network. Public HTTP(S) only, and never an address
 * that resolves into a reserved range.
 */

const dns = require('dns').promises;
const net = require('net');

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Reserved IPv4 and IPv6 ranges that must never be a target. */
function isPrivateAddress(ip) {
  const version = net.isIP(ip);
  if (version === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return true;                       // 10/8
    if (a === 127) return true;                      // loopback
    if (a === 0) return true;                        // this network
    if (a === 169 && b === 254) return true;         // link-local, incl. metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true;         // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a >= 224) return true;                       // multicast and reserved
    return false;
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80')) return true;       // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
    // IPv4-mapped, e.g. ::ffff:127.0.0.1
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return false;
}

/**
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
async function assertPublicHttpUrl(value, { resolve = true } = {}) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return { ok: false, reason: 'Not a valid URL' };
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { ok: false, reason: `Protocol ${url.protocol} is not allowed; use http or https` };
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) return { ok: false, reason: 'URL has no host' };

  if (net.isIP(host)) {
    return isPrivateAddress(host)
      ? { ok: false, reason: 'Target address is in a reserved range' }
      : { ok: true };
  }

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    return { ok: false, reason: 'Target host is not publicly routable' };
  }

  if (!resolve) return { ok: true };

  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    return { ok: false, reason: 'Target host does not resolve' };
  }
  if (addresses.some(a => isPrivateAddress(a.address))) {
    return { ok: false, reason: 'Target host resolves into a reserved range' };
  }
  return { ok: true };
}

module.exports = { assertPublicHttpUrl, isPrivateAddress };
