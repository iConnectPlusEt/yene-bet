// Small helpers shared by the website's API routes.
import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { personFromRequest } from './identity.js';

const STATUS = { rate_limited: 429, suspended: 403, rules: 403, no_chat: 409, in_chat: 409, no_offer: 409 };

export const json = (body, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

/** Turn a { ok, error } result from the chat functions into a response. */
export function reply(result) {
  if (result.ok || result.warn) return json(result);
  return json(result, STATUS[result.error] || 400);
}

export async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : {};
  } catch {
    return {};
  }
}

/** Runs a handler for the signed-in anonymous person, or answers 401. */
export async function withPerson(request, handler) {
  try {
    const person = await personFromRequest(request);
    if (!person) return json({ ok: false, error: 'unauthorized' }, 401);
    return await handler(person, await (request.method === 'GET' ? {} : readJson(request)));
  } catch (error) {
    console.error(`[api] ${request.method} ${new URL(request.url).pathname}`, error);
    return json({ ok: false, error: 'server' }, 500);
  }
}

/** A one-way hash of the caller's address, used only for rate limiting. */
export function ipHash(request) {
  const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
  return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 24);
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/** True when the request carries the CRON_SECRET bearer token. */
export function isAdmin(request) {
  const header = request.headers.get('authorization') || '';
  return safeEqual(header.replace(/^Bearer /, ''), process.env.CRON_SECRET);
}
