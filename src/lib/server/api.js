// Small helpers shared by the website's API routes.
import { NextResponse } from 'next/server';
import { personFromRequest } from './identity.js';
import { ipHash, safeEqual } from './secrets.js';

export { ipHash, safeEqual };

const STATUS = { rate_limited: 429, suspended: 403, rules: 403, no_chat: 409, in_chat: 409, no_offer: 409, busy: 409, not_found: 404 };

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

/** True when the request carries the CRON_SECRET bearer token. */
export function isAdmin(request) {
  const header = request.headers.get('authorization') || '';
  return safeEqual(header.replace(/^Bearer /, ''), process.env.CRON_SECRET);
}
