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

const server = spawn('npx', ['next', 'start', '-p', String(PORT)], {
  cwd: root,
  env: { ...process.env, DATABASE_URL, ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', NEXT_PUBLIC_SUPABASE_URL: '' },
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
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`${label}: ${m.text()}`); });
  await page.goto(BASE);
  return page;
}
const shot = (page, name) => page.screenshot({ path: path.join(shots, `${name}.png`) });
const click = (page, name) => page.getByRole('button', { name, exact: true }).click();
const see = (page, text) => page.getByText(text, { exact: false }).first().waitFor({ timeout: 15000 });

async function agree(page) {
  await click(page, 'I am 18+ and I agree');
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
    await shot(venter, '05-vent-form');
    const t0 = Date.now();
    await click(venter, 'Connect me now');
    await see(venter, 'They are a real person, here to listen');
    const connectMs = Date.now() - t0;
    results.push(`     connected in ${connectMs} ms`);

    await see(listener, 'My boss blamed me for his mistake');
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

  await scenario('nobody free: AI listens, then a real person is offered and takes over', async () => {
    const venter = await phone('venter-2');
    await agree(venter);
    await venter.getByRole('button', { name: /I need to vent/ }).click();
    await venter.getByLabel('What is on your mind?').fill('I moved to a new city and I feel completely alone.');
    await click(venter, 'Connect me now');
    await see(venter, 'an AI listener is here with you');
    await venter.locator('.bubble.ai').first().waitFor({ timeout: 15000 });
    await say(venter, 'I have not told anyone how bad it is.');
    await venter.locator('.bubble.ai').nth(1).waitFor({ timeout: 15000 });
    await shot(venter, '11-ai-chat');

    const listener = await phone('listener-2');
    await becomeListener(listener, 'Loneliness');
    await see(venter, 'a real person, is free now');
    await shot(venter, '12-handoff-offer');
    await click(venter, 'Talk to them');
    await see(venter, 'has joined');
    await see(listener, 'I moved to a new city');
    assert.equal(await listener.getByText('I have not told anyone').count(), 0, 'listener must not see the AI conversation');
    assert.equal(await listener.locator('.bubble.ai').count(), 0);
    await say(listener, 'I moved last year too. It gets lighter. Tell me about it.');
    await see(venter, 'I moved last year too');
    await shot(venter, '13-after-handoff');
    await shot(listener, '14-listener-after-handoff');

    await say(venter, 'Some days I want to kill myself');
    await venter.locator('.help').waitFor({ timeout: 15000 });
    await see(listener, 'may be in danger');
    await shot(venter, '15-help-card');
    await listener.context().close();
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
    await click(venter, 'Connect me now');
    await see(venter, 'an AI listener is here with you');

    // This listener is connected at once, so there is no waiting screen.
    const listener = await phone('listener-away');
    await agree(listener);
    await listener.getByRole('button', { name: /I am here to listen/ }).click();
    await click(listener, 'I am available');
    await see(listener, 'Is anyone actually there?');
    await see(venter, 'a real person, has joined');
    await listener.context().close();
    await venter.getByText('They seem to have stepped away').waitFor({ timeout: 40000 });
    await shot(venter, '17-partner-away');
    await click(venter, 'End');
    await click(venter, 'End conversation');
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
    await click(page, 'Connect me now');
    await see(page, 'an AI listener is here with you');
    await page.close();
    const again = await context.newPage();
    await again.goto(BASE);
    await see(again, 'Exams are next week and I cannot focus.');
    await context.close();
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
