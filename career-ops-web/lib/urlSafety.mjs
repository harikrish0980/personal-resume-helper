import net from 'node:net';
import { lookup } from 'node:dns/promises';

const BLOCKED_HOSTS = new Set([
  'localhost',
  '0.0.0.0',
  '127.0.0.1',
  '::1',
]);

export function validateJobUrl(rawUrl) {
  if (!rawUrl || !rawUrl.trim()) return { ok: true, url: '' };

  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { ok: false, error: 'Enter a valid URL.' };
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'Only https job URLs are allowed.' };
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTS.has(host) || host.endsWith('.localhost')) {
    return { ok: false, error: 'Localhost URLs are blocked for safety.' };
  }

  const ipType = net.isIP(host);
  if (ipType && isBlockedIp(host)) {
    return { ok: false, error: 'Private, loopback, and metadata IPs are blocked.' };
  }

  return { ok: true, url: parsed.toString() };
}

export async function validatePublicUrl(rawUrl) {
  const check = validateJobUrl(rawUrl);
  if (!check.ok || !check.url) return check;
  try {
    const host = new URL(check.url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (isBlockedHostname(host)) {
      return { ok: false, error: 'Local and private hosts are blocked for safety.' };
    }
    const literalType = net.isIP(host);
    if (literalType && isBlockedIp(host)) {
      return { ok: false, error: 'Private, loopback, and metadata IPs are blocked.' };
    }
    const addresses = await lookup(host, { all: true, verbatim: false }).catch(() => []);
    if (!addresses.length) return { ok: false, error: 'Could not verify this public host.' };
    if (addresses.some((address) => isBlockedIp(address.address))) {
      return { ok: false, error: 'This host resolves to a private or local network address.' };
    }
    return check;
  } catch {
    return { ok: false, error: 'Could not verify this public URL.' };
  }
}

export async function safePublicFetch(rawUrl, fetchImpl = fetch, options = {}) {
  const check = await validatePublicUrl(rawUrl);
  if (!check.ok) throw new Error(check.error);
  const response = await fetchImpl(check.url, { redirect: 'manual', ...options });
  const location = response.headers?.get?.('location');
  if (location && response.status >= 300 && response.status < 400) {
    const redirected = new URL(location, check.url).toString();
    const redirectCheck = await validatePublicUrl(redirected);
    if (!redirectCheck.ok) throw new Error('Unsafe redirect blocked.');
  }
  return response;
}

export function isBlockedHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return BLOCKED_HOSTS.has(host)
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host === 'metadata.google.internal';
}

function isBlockedIp(ip) {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === '169.254.169.254') return true;
  if (normalized.includes(':')) {
    return normalized === '::1'
      || normalized === '0:0:0:0:0:0:0:1'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || normalized.startsWith('fe80:')
      || normalized.startsWith('::ffff:127.')
      || normalized.startsWith('::ffff:10.')
      || normalized.startsWith('::ffff:192.168.')
      || /^::ffff:172\.(1[6-9]|2\d|3[01])\./.test(normalized);
  }

  const parts = normalized.split('.').map(Number);
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}
