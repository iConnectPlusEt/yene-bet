// Small helpers with no framework dependencies, so tests can use them directly.
import crypto from 'node:crypto';

/** A one-way hash of the caller's address, used only for rate limiting. */
export function ipHash(request) {
  const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
  return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 24);
}

/** Compare two secrets without leaking where they differ. */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
