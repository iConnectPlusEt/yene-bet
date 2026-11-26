'use client';

import { useCallback, useEffect, useState } from 'react';

const KEY = 'yb_admin';

const pct = (v) => (v === null || v === undefined ? '–' : `${Math.round(v * 100)}%`);
const count = (v) => (v === null || v === undefined ? '–' : v.toLocaleString());
function wait(secs) {
  if (secs === null || secs === undefined) return '–';
  if (secs < 90) return `${secs} s`;
  if (secs < 5400) return `${Math.round(secs / 60)} min`;
  return `${(secs / 3600).toFixed(1)} h`;
}
const shortDay = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

function Stat({ value, label, note }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {note ? <div className="stat-note">{note}</div> : null}
    </div>
  );
}

/** A small bar chart. `values` may contain nulls (no record for that day). */
function Bars({ title, days, values, second, color = 'var(--accent)', labels = null }) {
  const max = Math.max(1, ...values.map((v) => v ?? 0));
  return (
    <figure className="chart">
      <figcaption>{title}</figcaption>
      <div className="bars" role="img" aria-label={title}>
        {values.map((v, i) => (
          <div key={days[i]} className="bar-col" title={`${labels ? `${labels[i]}:00` : shortDay(days[i])}: ${v ?? 'no record'}${second ? ` (${second[i]})` : ''}`}>
            <div className="bar-track">
              {v === null ? <div className="bar none" /> : <div className="bar" style={{ height: `${(v / max) * 100}%`, background: color }} />}
              {second && second[i] ? <div className="bar inner" style={{ height: `${(second[i] / max) * 100}%` }} /> : null}
            </div>
            <span>{labels ? labels[i] : Number(days[i].slice(8))}</span>
          </div>
        ))}
      </div>
    </figure>
  );
}

export default function StatsPage() {
  const [secret, setSecret] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (value) => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/stats', { headers: { Authorization: `Bearer ${value}` }, cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok) {
        setData(body);
        try { window.sessionStorage.setItem(KEY, value); } catch { /* fine without */ }
      } else {
        setData(null);
        try { window.sessionStorage.removeItem(KEY); } catch { /* fine without */ }
        setError(
          res.status === 429 ? 'Too many wrong tries. Please wait an hour.'
            : res.status === 503 ? 'The stats secret has not been set up on the server.'
              : res.status === 401 ? 'That is not the right secret.' : 'Could not load the numbers.',
        );
      }
    } catch {
      setError('Could not reach the server.');
    }
    setBusy(false);
  }, []);

  useEffect(() => {
    let saved = '';
    try { saved = window.sessionStorage.getItem(KEY) || ''; } catch { /* none */ }
    if (saved) load(saved);
  }, [load]);

  if (!data) {
    return (
      <main className="shell">
        <div className="brand"><span>My Home · stats</span></div>
        <h1>Private</h1>
        <p className="lede">Enter the secret to see how My Home is being used.</p>
        <form onSubmit={(e) => { e.preventDefault(); if (secret) load(secret); }} className="stack">
          <input
            className="field one-line"
            type="password"
            autoComplete="off"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="Secret"
            aria-label="Secret"
          />
          {error ? <p className="error">{error}</p> : null}
          <button type="submit" className="btn primary" disabled={busy || !secret}>{busy ? 'Checking…' : 'Open'}</button>
        </form>
      </main>
    );
  }

  const { people, conversations: c, supply, reach, quality, wall, safety, funnel = {}, waves = [], channels = {}, nudges, hours = [], listeners, replies, series } = data;
  const days = series.map((d) => d.day);
  const asOf = new Date(data.generatedAt).toLocaleString();
  const ratedPct = quality.ratings ? quality.yes / quality.ratings : null;

  return (
    <main className="shell wide">
      <div className="brand">
        <span>My Home · stats</span>
        <button type="button" onClick={() => load(secret || window.sessionStorage.getItem(KEY) || '')} disabled={busy}>Refresh</button>
      </div>
      <p className="small">As of {asOf}. Totals only; nobody&rsquo;s messages or names. {people.testExcluded ? `${people.testExcluded} test identities left out.` : ''}</p>

      <h2>People</h2>
      <div className="stat-grid">
        <Stat value={count(people.gotIn)} label="Joined" note="agreed to the rules" />
        <Stat value={count(people.active24h)} label="Active today" note="last 24 hours" />
        <Stat value={count(people.active7d)} label="Active this week" />
        <Stat value={count(people.active30d)} label="Active this month" />
        <Stat value={`${count(people.gotInTelegram)} / ${count(people.gotIn - people.gotInTelegram)}`} label="Telegram / website" note="of those who joined" />
        <Stat value={count(people.openedOnly)} label="Only looked" note="opened it, did not continue" />
      </div>
      <Bars title="Active people per day (recorded daily, from the day this page was added)" days={days} values={series.map((d) => d.active)} color="var(--calm)" />
      <Bars title="New people per day" days={days} values={series.map((d) => d.newPeople)} second={series.map((d) => d.newGotIn)} />
      <p className="small">Darker part: those who joined. Counted since {people.since ? new Date(people.since).toLocaleDateString() : '–'}.</p>

      <h2>Conversations</h2>
      <div className="stat-grid">
        <Stat value={count(c.total)} label="Conversations" note={`${count(c.total7d)} this week`} />
        <Stat value={pct(c.answerRate)} label="Reached a person" note={`${count(c.answered)} of ${count(c.total)}`} />
        <Stat value={pct(c.answerRate7d)} label="Reached a person, this week" note={`${count(c.answered7d)} of ${count(c.total7d)}`} />
        <Stat value={wait(c.waitMedianSecs)} label="Typical wait" note="median, until a person joined" />
        <Stat value={wait(c.waitP90Secs)} label="Slow waits" note="9 in 10 connected within this" />
        <Stat value={pct(c.connectedWithin60s)} label="Connected in a minute" note={`${count(c.waitsMeasured)} measured`} />
      </div>
      <Bars title="Conversations per day" days={days} values={series.map((d) => d.conversations)} second={series.map((d) => d.answered)} />
      <p className="small">Darker part: those that reached a person.</p>

      <h2>Listeners</h2>
      <div className="stat-grid">
        <Stat value={count(supply.availableNow)} label="Available now" />
        <Stat value={count(supply.waitingNow)} label="Waiting now" note="people wanting someone" />
        <Stat value={count(supply.inConversation)} label="In a conversation" />
        <Stat value={count(c.peopleWhoListened)} label="Have listened" note={`${count(c.peopleWhoVented)} have vented`} />
      </div>

      <h2>Telegram reach</h2>
      <div className="stat-grid">
        <Stat value={count(reach.reachable)} label="Can be asked" note="active, not stopped" />
        <Stat value={count(reach.requestsSent7d)} label="Requests this week" />
        <Stat value={count(reach.tappedListen7d)} label="Tapped “I can listen”" note="from those requests" />
        <Stat value={count(reach.blockedBot)} label="Blocked the bot" />
        <Stat value={count(reach.stoppedRequests)} label="Stopped the requests" />
      </div>

      <h2>Quality</h2>
      <div className="stat-grid">
        <Stat value={count(quality.ratings)} label="Ratings" note={quality.ratings ? `${pct(ratedPct)} felt heard` : 'none yet'} />
        <Stat value={`${count(quality.yes)} / ${count(quality.aLittle)} / ${count(quality.no)}`} label="Yes / a little / no" />
        <Stat value={count(wall.posts)} label="Shared stories now" note={`${count(wall.beenThere)} “I have been there”`} />
      </div>

      <h2>Where people leave</h2>
      <p className="small">Each step as a share of the one before. Preferences only exist for people who joined after that screen was added.</p>
      <FunnelTable funnel={funnel} />

      <h2>Request waves</h2>
      <p className="small">People asked to listen when someone is waiting, and how many said yes.</p>
      <WaveTable waves={waves} />

      <h2>Nudges</h2>
      <p className="small">A gentle message to people who joined on Telegram but never started. At most two each.</p>
      <div className="stat-grid">
        <Stat value={count(nudges?.sent)} label="Nudges sent" note={`to ${count(nudges?.people)} people`} />
        <Stat value={count(nudges?.started)} label="Then started" note="vented or listened after a nudge" />
        <Stat value={count(nudges?.stopped)} label="Said “not for me”" />
      </div>

      <h2>When people vent</h2>
      <p className="small">By hour of the day ({data.timezone}). The darker part is the vents that reached a real person.</p>
      <Bars
        title="Vents per hour"
        days={hours.map((h) => String(h.hour))}
        labels={hours.map((h) => String(h.hour))}
        values={hours.map((h) => h.vents)}
        second={hours.map((h) => h.answered)}
      />
      <BandTable hours={hours} />

      <h2>Listeners</h2>
      <p className="small">How the listening is spread. If a few people carry most of it, the service depends on them.</p>
      <div className="stat-grid">
        <Stat value={count(listeners?.helped)} label="Have listened" note="to at least one person" />
        <Stat value={listeners?.conversations ? pct(listeners.top1 / listeners.conversations) : '–'} label="Top listener's share" note={`${count(listeners?.top1)} of ${count(listeners?.conversations)} conversations`} />
        <Stat value={listeners?.conversations ? pct(listeners.top3 / listeners.conversations) : '–'} label="Top three's share" />
        <Stat value={count(listeners?.onlyOne)} label="Listened once" note={`${count(listeners?.threePlus)} listened 3 or more times`} />
        <Stat value={fmtSecs(replies?.medianSecs)} label="Median first reply" note={`90% within ${fmtSecs(replies?.p90Secs)}`} />
        <Stat value={count(replies?.neverReplied)} label="Never replied" note={`of ${count(replies?.connected)} connected`} />
      </div>

      <h2>Telegram and website</h2>
      <ChannelTable channels={channels} />

      <h2>Safety</h2>
      <div className="stat-grid">
        <Stat value={count(safety?.reports)} label="Reports" note={`${count(safety?.reports7d)} in the last 7 days`} />
        <Stat value={count(safety?.suspended)} label="Suspended" />
      </div>
    </main>
  );
}

const CHANNELS = [['telegram', 'Telegram'], ['web', 'Website']];
const fmtPct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '–');
const fmtSecs = (s) => (s === null || s === undefined ? '–' : s < 90 ? `${s} s` : `${Math.round(s / 60)} min`);

function FunnelTable({ funnel }) {
  const steps = [
    ['opened', 'Opened'],
    ['agreed', 'Agreed to the rules'],
    ['preferences', 'Finished preferences'],
    ['vented', 'Vented'],
    ['listened', 'Listened or offered to'],
    ['talked', 'Talked to a real person'],
  ];
  return (
    <div className="table-wrap">
      <table className="stats-table">
        <thead><tr><th />{CHANNELS.map(([k, l]) => <th key={k}>{l}</th>)}</tr></thead>
        <tbody>
          {steps.map(([key, label], i) => (
            <tr key={key}>
              <th scope="row">{label}</th>
              {CHANNELS.map(([k]) => {
                const f = funnel[k] || {};
                const prev = i === 0 ? null : f[steps[i - 1][0]];
                return <td key={k}>{count(f[key])}{i > 0 && key !== 'listened' && key !== 'talked' ? <span className="muted"> · {fmtPct(f[key] || 0, prev)}</span> : null}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WaveTable({ waves }) {
  if (!waves.length) return <p className="small">No requests sent yet.</p>;
  return (
    <div className="table-wrap">
      <table className="stats-table">
        <thead><tr><th>Wave</th><th>Sent</th><th>Yes</th><th>Not now</th><th>A week</th><th>Stop</th><th>No answer</th><th>Rate</th><th>Median</th></tr></thead>
        <tbody>
          {waves.map((w) => (
            <tr key={`${w.wave}-${w.channel}`}>
              <th scope="row">{w.wave} · {w.channel === 'web' ? 'website' : 'Telegram'}</th>
              <td>{count(w.sent)}</td>
              <td>{count(w.answered)}</td>
              <td>{count(w.notNow)}</td>
              <td>{count(w.week)}</td>
              <td>{count(w.stop)}</td>
              <td>{count(w.ignored)}</td>
              <td>{fmtPct(w.answered, w.sent)}</td>
              <td>{fmtSecs(w.medianSecs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ChannelTable({ channels }) {
  const rows = [
    ['Conversations', (c) => count(c.conversations)],
    ['Answered by a person', (c) => `${count(c.answered)} · ${fmtPct(c.answered, c.conversations)}`],
    ['Last 7 days', (c) => `${count(c.answered7d)} of ${count(c.conversations7d)}`],
    ['Median wait', (c) => fmtSecs(c.waitMedianSecs)],
    ['Slowest 10% wait', (c) => fmtSecs(c.waitP90Secs)],
  ];
  return (
    <div className="table-wrap">
      <table className="stats-table">
        <thead><tr><th />{CHANNELS.map(([k, l]) => <th key={k}>{l}</th>)}</tr></thead>
        <tbody>
          {rows.map(([label, fn]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              {CHANNELS.map(([k]) => <td key={k}>{channels[k] ? fn(channels[k]) : '–'}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Night, daytime and evening side by side: when are people asking, and when do they get someone?
function BandTable({ hours }) {
  const bands = [['Night (0–7)', 0, 7], ['Daytime (8–16)', 8, 16], ['Evening (17–23)', 17, 23]];
  return (
    <div className="table-wrap">
      <table className="stats-table">
        <thead><tr><th /><th>Vents</th><th>Reached a person</th><th>Rate</th></tr></thead>
        <tbody>
          {bands.map(([label, from, to]) => {
            const rows = hours.filter((h) => h.hour >= from && h.hour <= to);
            const vents = rows.reduce((a, h) => a + h.vents, 0);
            const answered = rows.reduce((a, h) => a + h.answered, 0);
            return (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td>{count(vents)}</td>
                <td>{count(answered)}</td>
                <td>{fmtPct(answered, vents)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
