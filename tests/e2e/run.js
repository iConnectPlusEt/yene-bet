// End-to-end check in real browsers: starts the built app against a local
// database, then drives separate phone-sized browsers as venters and
// listeners. Run `npm run build` first, then `npm run e2e`.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import postgres from 'postgres';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const shots = path.join(here, 'shots');
const PORT = 3210;
const BASE = `http://127.0.0.1:${PORT}`;
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/yb_dev';

fs.mkdirSync(shots, { recursive: true });
const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
await sql`delete from people`; // cascades to everything a person owns
await sql`delete from rate_limits`;

const webpush = require('web-push');
const vapid = webpush.generateVAPIDKeys();
const server = spawn('npx', ['next', 'start', '-p', String(PORT)], {
  cwd: root,
  env: { ...process.env, DATABASE_URL, ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', NEXT_PUBLIC_SUPABASE_URL: '', ADMIN_SECRET: 'e2e-secret', VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true, // own process group, so the whole server tree can be stopped
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server did not start:\n${serverLog}`);
}

const browser = await chromium.launch();
const pageErrors = [];

async function phone(label) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(`${label}: ${e.message}`));
  page.on('console', (m) => {
    // The stats test types a wrong secret on purpose, which answers 401.
    if (m.type() === 'error' && !(label === 'stats' && /401/.test(m.text()))) pageErrors.push(`${label}: ${m.text()}`);
  });
  await page.goto(BASE);
  return page;
}
const shot = (page, name) => page.screenshot({ path: path.join(shots, `${name}.png`) });
const click = (page, name) => page.getByRole('button', { name, exact: true }).click();
const see = (page, text) => page.getByText(text, { exact: false }).first().waitFor({ timeout: 15000 });

async function agree(page) {
  await click(page, 'I am 18+ and I agree');
  await see(page, 'Make matches better');
  await click(page, 'Skip for now');
  await see(page, 'What do you need right now?');
}

async function becomeListener(page, topic) {
  await agree(page);
  await page.getByRole('button', { name: /I am here to listen/ }).click();
  if (topic) await click(page, topic);
  await click(page, 'I am available');
  await see(page, 'You are available');
}

async function say(page, text) {
  await page.getByLabel('Message').fill(text);
  await click(page, 'Send');
}

const results = [];
async function scenario(name, fn) {
  try { await fn(); results.push(`ok   ${name}`); } catch (e) { results.push(`FAIL ${name}\n     ${e.message.split('\n').slice(0, 4).join(' / ')}`); }
}

try {
  await waitForServer();

  await scenario('venter is connected to a waiting listener and they talk both ways', async () => {
    const listener = await phone('listener-1');
    await shot(listener, '01-rules');
    await agree(listener);
    await shot(listener, '02-start');
    await listener.getByRole('button', { name: /I am here to listen/ }).click();
    await click(listener, 'Work');
    await shot(listener, '03-listen-form');
    await click(listener, 'I am available');
    await see(listener, 'You are available');
    await shot(listener, '04-waiting');

    const venter = await phone('venter-1');
    await agree(venter);
    await venter.getByRole('button', { name: /I need to vent/ }).click();
    await venter.getByLabel('What is on your mind?').fill('My boss blamed me for his mistake in front of the whole team.');
    assert.equal(await venter.getByRole('button', { name: 'Connect me now' }).isDisabled(), true, 'they must choose advice or listening first');
    await click(venter, 'I would like advice');
    await shot(venter, '05-vent-form');
    const t0 = Date.now();
    await click(venter, 'Connect me now');
    await see(venter, 'They are a real person, here to listen');
    const connectMs = Date.now() - t0;
    results.push(`     connected in ${connectMs} ms`);

    await see(listener, 'My boss blamed me for his mistake');
    await see(listener, 'would like advice');
    await say(listener, 'That is so unfair. What did you do?');
    await see(venter, 'That is so unfair. What did you do?');
    await say(venter, 'I just froze. I am still angry about it.');
    await see(listener, 'I just froze. I am still angry about it.');
    await shot(venter, '06-chat-venter');
    await shot(listener, '07-chat-listener');

    await say(venter, 'you can call me on 0911 234 567');
    await see(venter, 'ends your anonymity');
    await shot(venter, '08-contact-warning');
    assert.equal(await listener.getByText('0911 234 567').count(), 0, 'not delivered before confirming');
    await click(venter, 'Edit message');

    await click(venter, 'End');
    await shot(venter, '09-end-sheet');
    await click(venter, 'End conversation');
    await see(listener, 'The other person ended the conversation');
    await shot(listener, '10a-ended-by-other');
    await shot(listener, '10-ended');
    await click(listener, 'Back to start');
    await see(listener, 'What do you need right now?');

    await see(venter, 'Did you feel heard?');
    await click(venter, 'Yes');
    await venter.getByLabel('Thank-you note').fill('Thank you for not judging me.');
    await shot(venter, '20-did-you-feel-heard');
    await click(venter, 'Send');
    await see(venter, 'That helps the next person');
    await see(listener, 'Thank you for not judging me.');
    await shot(listener, '21-thank-you-note');
    await listener.context().close();
    await venter.context().close();
  });

  await scenario('nobody free: honest waiting room, no automatic replies, then a listener joins and sees it all', async () => {
    const venter = await phone('venter-2');
    await agree(venter);
    await see(venter, 'No listeners right now. Be the first.');
    await shot(venter, '11-start-with-presence');
    await venter.getByRole('button', { name: /I need to vent/ }).click();
    await venter.getByLabel('What is on your mind?').fill('the breakup');
    await click(venter, 'I just want someone to listen');
    await click(venter, 'Connect me now');
    await see(venter, 'No one is free this second');
    await see(venter, 'Looking for someone');
    await see(venter, 'No listeners online yet');
    await say(venter, 'we are not talking');
    await say(venter, 'it has been 3 days');
    await venter.waitForTimeout(4000);
    assert.equal(await venter.locator('.bubble.ai').count(), 0, 'nothing replies automatically');
    assert.equal(await venter.locator('.dots').count(), 0, 'and nothing pretends to be typing');
    await shot(venter, '12-waiting-room');

    await click(venter, 'Read shared stories while you wait');
    await see(venter, 'Anonymous, and gone after a week');
    await click(venter, 'Back to waiting');
    await see(venter, 'Looking for someone');

    const listener = await phone('listener-2');
    await agree(listener);
    await see(listener, '1 waiting to be heard');
    await listener.getByRole('button', { name: /I am here to listen/ }).click();
    await click(listener, 'I am available');
    await see(venter, 'They are a real person, here to listen');
    for (const line of ['the breakup', 'we are not talking', 'it has been 3 days']) await see(listener, line);
    await say(listener, 'Three days of silence is heavy. I am here.');
    await see(venter, 'Three days of silence is heavy.');
    await shot(venter, '13-after-waiting');

    await say(venter, 'Some days I want to kill myself');
    await venter.locator('.help').waitFor({ timeout: 15000 });
    await see(listener, 'may be in danger');
    await shot(venter, '15-help-card');

    // The conversation is saved for each of them.
    await click(venter, 'End');
    await click(venter, 'End conversation');
    await click(venter, 'Skip');
    await click(venter, 'Your conversations');
    await see(venter, 'You talked with');
    await shot(venter, '26-your-conversations');
    await venter.locator('.past-item').first().click();
    await see(venter, 'Three days of silence is heavy.');
    await click(venter, 'Remove from my conversations');
    await see(venter, 'Nothing here yet.');
    await click(listener, 'Back to start');
    await click(listener, 'Your conversations');
    await see(listener, 'You listened to');
    await listener.context().close();
    await venter.context().close();
  });

  await scenario('a vent nobody answered is kept, and can be posted to shared stories', async () => {
    const venter = await phone('venter-unanswered');
    await agree(venter);
    await venter.getByRole('button', { name: /I need to vent/ }).click();
    await venter.getByLabel('What is on your mind?').fill('I lost my job today and I cannot tell anyone.');
    await click(venter, 'I just want someone to listen');
    await click(venter, 'Connect me now');
    await see(venter, 'No one is free this second');
    await click(venter, 'End');
    await click(venter, 'End conversation');
    await see(venter, 'Nobody was free this time');
    await shot(venter, '27-unanswered');
    await click(venter, 'Post this to Shared stories');
    await see(venter, 'Posted to Shared stories');
    await click(venter, 'Back to start');
    await click(venter, 'Your conversations');
    await see(venter, 'A vent nobody was free for');
    await click(venter, 'Back');
    await venter.getByRole('button', { name: /Shared stories/ }).click();
    await see(venter, 'I lost my job today');
    await click(venter, 'Remove my post');
    await venter.context().close();
  });

  await scenario('venter chooses who to talk to', async () => {
    const a = await phone('listener-3a');
    await becomeListener(a, 'Money');
    const b = await phone('listener-3b');
    await becomeListener(b, 'Family');
    const venter = await phone('venter-3');
    await agree(venter);
    await venter.getByRole('button', { name: /I need to vent/ }).click();
    await venter.getByLabel('What is on your mind?').fill('My parents keep comparing me to my brother.');
    await click(venter, 'I just want someone to listen');
    await click(venter, 'Let me choose who');
    await see(venter, 'Who would you like to talk to?');
    const cards = venter.locator('.person');
    assert.equal(await cards.count(), 2);
    assert.match(await cards.first().innerText(), /family/i, 'the relatable listener is listed first');
    await shot(venter, '16-choose');
    await cards.nth(1).click();
    await see(venter, 'They are a real person, here to listen');
    await see(a, 'My parents keep comparing me');
    await see(b, 'You are available');
    await click(b, 'Stop listening');
    await see(b, 'What do you need right now?');
    await a.context().close();
    await b.context().close();
    await venter.context().close();
  });

  await scenario('a listener who closes the page is not matched; the other side is shown as away', async () => {
    const ghost = await phone('listener-ghost');
    await becomeListener(ghost, null);
    await ghost.context().close();
    await new Promise((r) => setTimeout(r, 11000));
    const venter = await phone('venter-ghost');
    await agree(venter);
    await venter.getByRole('button', { name: /I need to vent/ }).click();
    await venter.getByLabel('What is on your mind?').fill('Is anyone actually there?');
    await click(venter, 'I just want someone to listen');
    await click(venter, 'Connect me now');
    await see(venter, 'No one is free this second');

    // This listener is connected at once, so there is no waiting screen.
    const listener = await phone('listener-away');
    await agree(listener);
    await listener.getByRole('button', { name: /I am here to listen/ }).click();
    await click(listener, 'I am available');
    await see(listener, 'Is anyone actually there?');
    await see(venter, 'They are a real person, here to listen');
    await listener.context().close();
    await venter.getByText('They seem to have stepped away').waitFor({ timeout: 40000 });
    await shot(venter, '17-partner-away');
    await click(venter, 'End');
    await click(venter, 'End conversation');
    await see(venter, 'This conversation has ended');
    await venter.context().close();
  });

  await scenario('a listener with the same experience is listed first and labelled', async () => {
    const other = await phone('listener-other');
    await becomeListener(other, 'Work');
    const same = await phone('listener-same');
    await agree(same);
    await same.getByRole('button', { name: /I am here to listen/ }).click();
    await same.getByLabel('What have you been through?').fill('I lost my father two years ago.');
    await shot(same, '18-listener-story');
    await click(same, 'I am available');
    await see(same, 'First in line for people going through: losing a parent');

    const venter = await phone('venter-exp');
    await agree(venter);
    await venter.getByRole('button', { name: /I need to vent/ }).click();
    await venter.getByLabel('What is on your mind?').fill('My dad died last month and nobody around me understands.');
    await click(venter, 'I just want someone to listen');
    await click(venter, 'Let me choose who');
    const cards = venter.locator('.person');
    assert.match(await cards.first().innerText(), /Has been through losing a parent/);
    await shot(venter, '19-choose-by-experience');
    await click(venter, 'Just connect me now');
    await see(same, 'My dad died last month');
    await see(other, 'You are available');
    await click(other, 'Stop listening');
    await see(other, 'What do you need right now?');
    for (const p of [other, same, venter]) await p.context().close();
  });

  await scenario('sharing wall: post, "I have been there", invite, talk, then talk again', async () => {
    const author = await phone('wall-author');
    await agree(author);
    await author.getByRole('button', { name: /Shared stories/ }).click();
    await author.getByLabel('Share what you are going through').fill('I failed my final exam and I have not told my parents yet.');
    await click(author, 'Share anonymously');
    await see(author, 'Nobody has answered yet.');

    const reader = await phone('wall-reader');
    await agree(reader);
    await reader.getByRole('button', { name: /Shared stories/ }).click();
    await see(reader, 'I failed my final exam');
    await shot(reader, '22-wall');
    await click(reader, 'I have been there');
    await see(reader, 'You have been there');
    await click(reader, 'Back');

    await see(author, '1 person has been there too.');
    await shot(author, '23-wall-my-post');
    await click(author, 'Invite to talk');
    await see(author, 'Invited');

    await see(reader, 'would like to talk with you');
    await shot(reader, '24-invitation');
    await click(reader, 'Talk now');
    await see(reader, 'I failed my final exam');
    await say(reader, 'I failed mine twice. It felt like the end and it was not.');
    await see(author, 'I failed mine twice.');
    await click(author, 'End');
    await click(author, 'End conversation');

    await click(author, 'I would talk to them again');
    await see(author, 'If they say the same');
    await click(reader, 'I would talk to them again');
    await see(reader, 'You both said you would talk again');
    await click(reader, 'Back to start');
    await see(reader, 'People you would talk to again');
    await shot(reader, '25-talk-again');
    await click(reader, 'Invite');
    await reader.getByLabel('What is going on?').fill('Rough evening. Are you around?');
    await click(reader, 'Send invitation');
    await see(reader, 'Invitation sent');

    await click(author, 'Skip');
    await see(author, 'would like to talk with you again');
    await click(author, 'Talk now');
    await see(author, 'Rough evening. Are you around?');
    await see(reader, 'They are a real person, here to listen');
    await click(reader, 'End');
    await click(reader, 'End conversation');
    await author.context().close();
    await reader.context().close();
  });

  await scenario('closing the tab and coming back returns to the same conversation', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto(BASE);
    await agree(page);
    await page.getByRole('button', { name: /I need to vent/ }).click();
    await page.getByLabel('What is on your mind?').fill('Exams are next week and I cannot focus.');
    await click(page, 'I just want someone to listen');
    await click(page, 'Connect me now');
    await see(page, 'No one is free this second');
    await page.close();
    const again = await context.newPage();
    await again.goto(BASE);
    await see(again, 'Exams are next week and I cannot focus.');
    await context.close();
  });
  await scenario('private stats page: needs the secret, then shows totals only', async () => {
    const page = await phone('stats');
    await page.goto(`${BASE}/stats`);
    await see(page, 'Enter the secret');
    await page.getByLabel('Secret').fill('not-it');
    await click(page, 'Open');
    await see(page, 'That is not the right secret.');
    await page.getByLabel('Secret').fill('e2e-secret');
    await click(page, 'Open');
    await see(page, 'Conversations');
    await see(page, 'Reached a person');
    await see(page, 'Telegram reach');
    await see(page, 'Where people leave');
    await see(page, 'Request waves');
    await see(page, 'Telegram and website');
    await see(page, 'When people vent');
    await see(page, 'Median first reply');
    const text = await page.locator('main').innerText();
    for (const private_ of ['Three days of silence', 'I lost my job today', 'my boss blamed me']) {
      assert.equal(text.includes(private_), false, 'no message text on the page');
    }
    await shot(page, '28-stats');
    await page.context().close();
  });

  await scenario('preferences: skip in one tap, or set them from the start screen', async () => {
    const page = await phone('prefs');
    await click(page, 'I am 18+ and I agree');
    await see(page, 'Make matches better');
    await shot(page, '29-prefs');
    await click(page, 'Skip for now');
    await see(page, 'What do you need right now?');
    await click(page, 'Preferences');
    await see(page, 'Who would you like to talk to?');
    await page.getByRole('button', { name: '25–34', exact: true }).first().click();
    await click(page, 'Save');
    await see(page, 'What do you need right now?');
    await click(page, 'Preferences');
    const pressed = await page.getByRole('button', { name: '25–34', exact: true }).first().getAttribute('aria-pressed');
    assert.equal(pressed, 'true', 'the saved choice is remembered');
    await page.context().close();
  });

  await scenario('a conversation that goes quiet stays open and shows a gentle prompt', async () => {
    // Earlier scenarios leave unanswered vents; close them so they do not take this listener.
    await sql`update chats set status = 'ended', ended_at = now() where status = 'active'`;
    const listener = await phone('quiet-listener');
    await becomeListener(listener);
    const venter = await phone('quiet-venter');
    await agree(venter);
    await venter.getByRole('button', { name: /I need to vent/ }).click();
    await venter.getByLabel('What is on your mind?').fill('Quiet check one.');
    await click(venter, 'I just want someone to listen');
    await click(venter, 'Connect me now');
    await see(venter, 'real person');
    await see(listener, 'Quiet check one.');
    await sql`update chats set last_message_at = now() - interval '5 hours', last_sender = 'venter'
              where opening = 'Quiet check one.'`;
    await venter.reload();
    await see(venter, 'has been quiet for');
    await click(venter, 'Keep waiting');
    assert.equal(await venter.getByText('has been quiet for').count(), 0);
    const [row] = await sql`select status from chats where opening = 'Quiet check one.'`;
    assert.equal(row.status, 'active', 'still open');
    await venter.context().close();
    await listener.context().close();
  });

  await scenario('talking again with the same person shows the earlier chat, and opens it', async () => {
    await sql`update chats set status = 'ended', ended_at = now() where status = 'active'`;
    const listener = await phone('again-listener');
    await becomeListener(listener);
    const venter = await phone('again-venter');
    await agree(venter);
    for (const opening of ['Earlier round about money.', 'Second round about money.']) {
      await venter.getByRole('button', { name: /I need to vent/ }).click();
      await venter.getByLabel('What is on your mind?').fill(opening);
      await click(venter, 'I just want someone to listen');
      await click(venter, 'Connect me now');
      await see(venter, 'real person');
      await see(listener, opening);
      if (opening.startsWith('Earlier')) {
        await click(venter, 'End');
        await click(venter, 'End conversation');
        await see(venter, 'Did you feel heard?');
        await click(venter, 'Back to start').catch(() => {});
        await see(listener, 'The other person ended the conversation');
        await click(listener, 'Back to start');
        await see(listener, 'What do you need right now?');
        await listener.getByRole('button', { name: /I am here to listen/ }).click();
        await click(listener, 'I am available');
        await see(listener, 'You are available');
        await venter.reload();
        await see(venter, 'What do you need right now?');
      }
    }
    await see(venter, 'before, on');
    await shot(venter, '30-earlier-chat');
    await click(venter, 'Read that conversation');
    await see(venter, 'Earlier round about money.');
    await click(venter, 'Back');
    await see(venter, 'Second round about money.');
    await venter.context().close();
    await listener.context().close();
  });

  await scenario('replying to a message shows which one was answered', async () => {
    await sql`update chats set status = 'ended', ended_at = now() where status = 'active'`;
    const listener = await phone('reply-listener');
    await becomeListener(listener);
    const venter = await phone('reply-venter');
    await agree(venter);
    await venter.getByRole('button', { name: /I need to vent/ }).click();
    await venter.getByLabel('What is on your mind?').fill('Reply check opening.');
    await click(venter, 'I just want someone to listen');
    await click(venter, 'Connect me now');
    await see(venter, 'real person');
    await see(listener, 'Reply check opening.');
    await say(listener, 'What happened at work today?');
    await say(listener, 'Take your time.');
    await see(venter, 'Take your time.');
    // The venter answers the first question, not the latest message.
    await venter.locator('.msg.them', { hasText: 'What happened at work today?' }).getByRole('button', { name: 'Reply to this' }).click();
    await see(venter, 'Replying to');
    await say(venter, 'My manager took credit for my work.');
    await see(listener, 'My manager took credit for my work.');
    const quote = listener.locator('.bubble', { hasText: 'My manager took credit' }).locator('.quote');
    await quote.waitFor({ timeout: 15000 });
    assert.match(await quote.innerText(), /You/);
    assert.match(await quote.innerText(), /What happened at work today\?/);
    await shot(listener, '31-reply-quote');
    await quote.click();
    assert.equal(await venter.locator('.replying').count(), 0, 'the reply bar is cleared after sending');
    await venter.context().close();
    await listener.context().close();
  });

  await scenario('share My Home, and the alerts switch', async () => {
    const page = await phone('share');
    await page.addInitScript(() => { Object.defineProperty(navigator, 'share', { value: undefined, configurable: true }); });
    await page.reload();
    await agree(page);
    await click(page, 'Share My Home');
    await see(page, 'More people means someone is free sooner');
    await see(page, 'Copy link');
    const href = await page.getByRole('link', { name: 'Share on Telegram' }).getAttribute('href');
    assert.match(href, /^https:\/\/t\.me\/share\/url\?url=/);
    assert.ok(!href.includes('yb_token'), 'no identity in the share link');
    await shot(page, '32-share');
    await click(page, 'Close');
    // Browser alerts are offered; a browser that refuses permission gets a clear message.
    await see(page, 'Alert me when someone needs to talk');
    await page.context().close();
  });

  await scenario('an alert opens a one-tap "can you listen?" screen that connects at once', async () => {
    await sql`update chats set status = 'ended', ended_at = now() where status = 'active'`;
    const venter = await phone('help-venter');
    await agree(venter);
    await venter.getByRole('button', { name: /I need to vent/ }).click();
    await venter.getByLabel('What is on your mind?').fill('Help screen check opening.');
    await click(venter, 'I would like advice');
    await click(venter, 'Connect me now');
    await see(venter, 'No one is free this second');
    const [chat] = await sql`select id from chats where opening = 'Help screen check opening.'`;

    const helper = await phone('help-helper');
    await agree(helper);
    await helper.goto(`${BASE}/?help=${chat.id}`);
    await see(helper, 'Can you listen right now?');
    await see(helper, 'They would like advice');
    await shot(helper, '33-help-request');
    await click(helper, 'Yes, I can listen');
    await see(helper, 'Help screen check opening.');
    await see(venter, 'real person');
    // A request that is no longer open is explained kindly.
    const late = await phone('help-late');
    await agree(late);
    await late.goto(`${BASE}/?help=${chat.id}`);
    await see(late, 'Someone else is already with them');
    for (const pg of [venter, helper, late]) await pg.context().close();
  });

} finally {
  await browser.close();
  try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already gone */ }
  await sql.end();
}

console.log(results.join('\n'));
if (pageErrors.length) console.log(`\nbrowser errors:\n${pageErrors.join('\n')}`);
const failed = results.some((r) => r.startsWith('FAIL')) || pageErrors.length > 0;
if (failed) console.log(`\nserver log tail:\n${serverLog.split('\n').slice(-15).join('\n')}`);
process.exit(failed ? 1 : 0);
