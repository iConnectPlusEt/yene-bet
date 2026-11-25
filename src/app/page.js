'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { TOPICS, topicLabels } from '../lib/topics.js';
import { experienceLabels } from '../lib/experiences.js';
import { APP_NAME, RULES, HELP, AI_NAME } from '../lib/strings.js';

const TOKEN_KEY = 'yb_token';
const MATCH_TOPICS = TOPICS.filter((t) => t.key !== 'other');

const ERROR_TEXT = {
  rate_limited: 'You are going a little fast. Please wait a moment and try again.',
  suspended: 'This device has been suspended after reports from other people.',
  too_long: 'That is too long. Please shorten it or send it in parts.',
  empty: 'Please write something first.',
  in_chat: 'You are already in a conversation.',
  intent_needed: 'Please choose whether you would like advice or just want to be heard.',
  no_chat: 'That conversation has already ended.',
  no_offer: 'That person is no longer available.',
  network: 'Could not reach the server. Check your connection and try again.',
  contact: 'Please leave out names, numbers and links.',
  crisis: 'It sounds like you may be in danger. Please do not wait for replies to a post: go back and tap "I need to vent" to talk to someone now, or contact local emergency services.',
  busy: 'One of you is in a conversation right now. The invitation stays open, so try again in a little while.',
  not_found: 'That is no longer available.',
  own_post: 'That is your own post.',
};
// Whole-app counts, worded so that an empty room invites people in.
function presenceLine(p) {
  if (!p) return '';
  const listeners = p.listenersFree + p.listenersBusy;
  if (!listeners) return p.waiting ? `No listeners right now, and ${p.waiting} waiting to be heard. Could you listen?` : 'No listeners right now. Be the first.';
  const here = `${listeners} ${listeners === 1 ? 'person is' : 'people are'} here to listen`;
  return p.waiting ? `${here} · ${p.waiting} waiting to be heard` : here;
}
function waitingLine(p) {
  if (!p) return 'Looking for someone';
  const listeners = p.listenersFree + p.listenersBusy;
  if (!listeners) return 'No listeners online yet';
  if (!p.listenersFree) return `${p.listenersBusy} ${p.listenersBusy === 1 ? 'listener is' : 'listeners are'} online, in ${p.listenersBusy === 1 ? 'a conversation' : 'conversations'}`;
  return 'Connecting you…';
}

const errorText = (code) => ERROR_TEXT[code] || 'Something went wrong. Please try again.';

function readToken() {
  try { return window.localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function writeToken(token) {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch { /* private mode: the session lasts until the tab closes */ }
}

export default function Home() {
  const tokenRef = useRef(null);
  const chatIdRef = useRef(null);
  const lastIdRef = useRef(0);
  const syncingRef = useRef(false);
  const timerRef = useRef(null);
  const syncRef = useRef(() => {});
  const listenTopicsRef = useRef(null);            // set while this browser means to be listening
  const firstSyncRef = useRef(true);

  const [ready, setReady] = useState(false);
  const [server, setServer] = useState(null);      // latest answer from /api/sync
  const [messages, setMessages] = useState([]);    // messages of the chat on screen
  const [helpChat, setHelpChat] = useState(null);     // a chat someone's alert asked them to listen to
  const [view, setView] = useState('home');        // home | vent | pick | listen (before a chat exists)
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [thanks, setThanks] = useState([]);         // thank-you notes from people this listener helped

  const call = useCallback(async (path, { method = 'POST', body } = {}) => {
    try {
      const res = await fetch(path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(tokenRef.current ? { Authorization: `Bearer ${tokenRef.current}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
      });
      const data = await res.json().catch(() => ({}));
      return { status: res.status, ...data };
    } catch {
      return { ok: false, error: 'network', status: 0 };
    }
  }, []);

  const newSession = useCallback(async () => {
    const created = await call('/api/session');
    if (!created.ok) return false;
    tokenRef.current = created.token;
    writeToken(created.token);
    return true;
  }, [call]);

  const addMessages = useCallback((incoming) => {
    if (!incoming?.length) return;
    setMessages((prev) => {
      const byId = new Map(prev.map((m) => [m.id, m]));
      for (const m of incoming) byId.set(m.id, m);
      return [...byId.values()].sort((a, b) => a.id - b.id);
    });
  }, []);

  const sync = useCallback(async () => {
    if (syncingRef.current || !tokenRef.current) return;
    syncingRef.current = true;
    try {
      const params = new URLSearchParams({ after: String(lastIdRef.current) });
      if (chatIdRef.current) params.set('chat', chatIdRef.current);
      let state = await call(`/api/sync?${params}`, { method: 'GET' });
      if (state.status === 401) {
        // The stored identity is unknown (for example the database was reset).
        if (await newSession()) state = await call('/api/sync?after=0', { method: 'GET' });
      }
      if (!state.ok) return;

      if (state.screen === 'chat') {
        if (state.chat.id !== chatIdRef.current) {
          chatIdRef.current = state.chat.id;
          lastIdRef.current = 0;
          setMessages(state.messages);
        } else {
          addMessages(state.messages);
        }
        const newest = state.messages.at(-1)?.id;
        if (newest) lastIdRef.current = Math.max(lastIdRef.current, newest);
        if (document.hidden && state.messages.some((m) => m.from !== 'me')) document.title = `New message · ${APP_NAME}`;
      }
      // Browsers pause background tabs, which drops a waiting listener from
      // the pool. If that happened, quietly rejoin.
      // (Only what this page was told to do counts: a reply that was already
      // on its way when the person tapped "Stop" must not switch it back on.)
      if (state.screen === 'listening' && firstSyncRef.current) listenTopicsRef.current = state.listening.topics;
      else if (state.screen === 'chat') listenTopicsRef.current = null;
      else if (state.screen === 'home' && listenTopicsRef.current && state.rulesAccepted && !state.suspended) {
        const rejoined = await call('/api/listen', { body: {} });
        if (rejoined.ok) state = await call('/api/sync?after=0', { method: 'GET' });
        else listenTopicsRef.current = null;
        if (!state.ok) return;
      }
      firstSyncRef.current = false;
      if (state.thanks?.length) setThanks((prev) => [...prev, ...state.thanks]);
      setServer(state);
      setReady(true);
    } finally {
      syncingRef.current = false;
    }
  }, [call, newSession, addMessages]);
  syncRef.current = sync;

  // Opened from an alert ("someone needs to be heard"): remember which request, then clean the address.
  useEffect(() => {
    try {
      const id = new URLSearchParams(window.location.search).get('help');
      if (id && /^[0-9a-f-]{36}$/i.test(id)) {
        setHelpChat(id);
        window.history.replaceState(null, '', window.location.pathname);
      }
    } catch { /* an unusual browser: the alert still opens the site */ }
  }, []);

  // Start: reuse this browser's anonymous identity or create one.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      tokenRef.current = readToken();
      if (!tokenRef.current && !(await newSession())) {
        if (!cancelled) { setError(errorText('network')); setReady(true); }
        return;
      }
      if (!cancelled) await syncRef.current();
    })();
    return () => { cancelled = true; };
  }, [newSession]);

  // Keep the screen current. Fast while matching or chatting, slow when idle.
  const screen = server?.screen || 'home';
  const live = screen !== 'home' || view === 'pick';
  useEffect(() => {
    if (!ready) return undefined;
    const tick = async () => {
      await syncRef.current();
      timerRef.current = setTimeout(tick, live ? 1500 : 6000);
    };
    timerRef.current = setTimeout(tick, live ? 1500 : 6000);
    const onVisible = () => { if (!document.hidden) { document.title = `${APP_NAME} · someone to vent to`; syncRef.current(); } };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearTimeout(timerRef.current); document.removeEventListener('visibilitychange', onVisible); };
  }, [ready, live]);

  // Optional instant delivery: when Supabase is configured the server pokes
  // this browser and it refreshes at once instead of waiting for the next poll.
  const pokeKey = server?.pokeKey;
  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key || !pokeKey) return undefined;
    let client;
    let cancelled = false;
    import('@supabase/supabase-js').then(({ createClient }) => {
      if (cancelled) return;
      client = createClient(url, key, { auth: { persistSession: false } });
      client.channel(`p:${pokeKey}`).on('broadcast', { event: 'poke' }, () => syncRef.current()).subscribe();
    }).catch(() => {});
    return () => { cancelled = true; client?.removeAllChannels(); };
  }, [pokeKey]);

  const act = useCallback(async (path, options, onOk) => {
    setBusy(true);
    setError('');
    const result = await call(path, options);
    setBusy(false);
    if (!result.ok && !result.warn) { setError(errorText(result.error)); return result; }
    if (onOk) onOk(result);
    await syncRef.current();
    return result;
  }, [call]);

  const leaveChat = useCallback(() => {
    chatIdRef.current = null;
    lastIdRef.current = 0;
    setMessages([]);
    setView('home');
    setServer((s) => (s ? { ...s, screen: 'home', chat: null } : s));
    syncRef.current();
  }, []);

  if (!ready) return <main className="shell"><Brand /><p className="lede" style={{ marginTop: 40 }}>One moment…</p></main>;

  if (screen === 'chat' && server.chat) {
    return (
      <Chat
        chat={server.chat}
        presence={server.presence}
        bot={server.bot}
        notifyLinked={server.notifyLinked}
        server={server}
        messages={messages}
        helpline={server.helpline}
        call={call}
        act={act}
        addMessages={addMessages}
        onLeave={leaveChat}
        error={error}
        setError={setError}
      />
    );
  }

  return (
    <main className="shell">
      {server?.suspended ? (
        <><Brand /><h1>This device is suspended</h1><p className="lede">{ERROR_TEXT.suspended}</p></>
      ) : !server?.rulesAccepted ? (
        <Rules busy={busy} onAgree={() => act('/api/rules')} error={error} />
      ) : !server?.prefsSeen || view === 'prefs' ? (
        <Prefs
          first={!server?.prefsSeen}
          initial={server?.prefs}
          busy={busy}
          error={error}
          onBack={() => setView('home')}
          onSkip={() => act('/api/prefs', { body: { skip: true } }, () => setView('home'))}
          onSave={(prefs) => act('/api/prefs', { body: prefs }, () => setView('home'))}
        />
      ) : helpChat && screen === 'home' ? (
        <HelpRequest
          chatId={helpChat}
          call={call}
          onDone={() => { setHelpChat(null); setView('home'); syncRef.current(); }}
        />
      ) : screen === 'listening' ? (
        <Waiting listening={server.listening} presence={server.presence} bot={server.bot} notifyLinked={server.notifyLinked} server={server} call={call} busy={busy} onStop={() => { listenTopicsRef.current = null; act('/api/listen', { method: 'DELETE' }, () => setView('home')); }} />
      ) : view === 'vent' || view === 'pick' ? (
        <Vent view={view} setView={setView} call={call} act={act} busy={busy} error={error} setError={setError} />
      ) : view === 'history' ? (
        <History call={call} onBack={() => setView('home')} />
      ) : view === 'wall' ? (
        <Wall call={call} onBack={() => setView('home')} />
      ) : view === 'listen' ? (
        <ListenForm
          profile={server?.profile}
          busy={busy}
          error={error}
          onBack={() => setView('home')}
          onStart={(topics, story) => { listenTopicsRef.current = topics; act('/api/listen', { body: { topics, story } }); }}
        />
      ) : (
        <Start
          onPrefs={() => { setError(''); setView('prefs'); }}
          invites={server?.invites || []}
          connections={server?.connections || []}
          act={act}
          call={call}
          onWall={() => { setError(''); setView('wall'); }}
          onHistory={() => { setError(''); setView('history'); }}
          presence={server?.presence}
          bot={server?.bot}
          server={server}
          thanks={thanks}
          onDismissThanks={() => setThanks([])}
          onVent={() => { setError(''); setView('vent'); }}
          onListen={() => { setError(''); setView('listen'); }}
          error={error}
        />
      )}
    </main>
  );
}

function Brand({ onBack, backLabel = 'Back' }) {
  return (
    <div className="brand">
      <span>{APP_NAME}</span>
      {onBack ? <button type="button" onClick={onBack}>{backLabel}</button> : null}
    </div>
  );
}

function Rules({ onAgree, busy, error }) {
  return (
    <>
      <Brand />
      <h1>A place to say it out loud.</h1>
      <p className="lede">Vent to someone who is free right now and has been through something similar. No names, no accounts.</p>
      <h2>Before you start</h2>
      <ul className="rules">{RULES.map((rule) => <li key={rule}>{rule}</li>)}</ul>
      {error ? <p className="error">{error}</p> : null}
      <div className="grow" />
      <button type="button" className="btn primary" disabled={busy} onClick={onAgree}>I am 18+ and I agree</button>
    </>
  );
}

function Start({ onVent, onListen, onWall, onHistory, onPrefs, presence, error, bot, server, thanks = [], onDismissThanks, invites, connections, act, call }) {
  const [reaching, setReaching] = useState(null);   // connection being invited
  const [line, setLine] = useState('');
  const [sent, setSent] = useState('');
  const [problem, setProblem] = useState('');

  const invite = async () => {
    setProblem('');
    const result = await call('/api/invites', { body: { connectionId: reaching.id, text: line } });
    if (!result.ok) { setProblem(errorText(result.error)); return; }
    setSent(`Invitation sent to ${reaching.alias}. You will be connected when they accept.`);
    setReaching(null);
    setLine('');
  };

  return (
    <>
      <Brand />
      <h1>What do you need right now?</h1>
      <p className="lede">Everyone here is anonymous. You can end a conversation at any time.</p>
      {presence ? <p className="presence"><i aria-hidden="true" />{presenceLine(presence)}</p> : null}
      {error ? <p className="error">{error}</p> : null}
      {thanks.length ? (
        <div className="banner" style={{ margin: '0 0 16px' }}>
          {thanks.map((t) => <p key={t.id} style={{ whiteSpace: 'pre-wrap' }}>{t.text}</p>)}
          <button type="button" className="btn" style={{ padding: '8px 12px', fontSize: 15 }} onClick={onDismissThanks}>Close</button>
        </div>
      ) : null}
      {invites.map((inv) => (
        <div key={inv.id} className="banner" style={{ margin: '0 0 16px' }}>
          <p>
            <strong>{inv.from}</strong>{' '}
            {inv.kind === 'post' ? 'shared a story you related to and would like to talk with you.' : 'would like to talk with you again.'}
          </p>
          <p className="small" style={{ whiteSpace: 'pre-wrap' }}>&ldquo;{inv.text.length > 160 ? `${inv.text.slice(0, 160)}…` : inv.text}&rdquo;</p>
          <div className="row">
            <button type="button" className="btn primary" onClick={() => act('/api/invites/respond', { body: { inviteId: inv.id, accept: true } })}>Talk now</button>
            <button type="button" className="btn" onClick={() => act('/api/invites/respond', { body: { inviteId: inv.id, accept: false } })}>Not now</button>
          </div>
        </div>
      ))}
      <div className="stack">
        <button type="button" className="choice primary" onClick={onVent}>
          <strong>I need to vent</strong>
          <span>Get connected to someone in seconds.</span>
        </button>
        <button type="button" className="choice" onClick={onListen}>
          <strong>I am here to listen</strong>
          <span>Be there for someone who needs it.</span>
        </button>
        <button type="button" className="choice" onClick={onWall}>
          <strong>Shared stories</strong>
          <span>Read what others are going through, or share your own.</span>
        </button>
        <button type="button" className="btn quiet" onClick={onHistory}>Your conversations</button>
        <button type="button" className="btn quiet" onClick={onPrefs}>Preferences</button>
        <PushAlerts server={server} call={call} act={act} />
        <ShareApp />
      </div>
      {connections.length ? (
        <>
          <h2>People you would talk to again</h2>
          {sent ? <p className="small">{sent}</p> : null}
          <div className="stack">
            {connections.map((c) => (
              <div key={c.id} className="card person">
                <span className="avatar">{c.alias[0]}</span>
                <span className="name" style={{ flex: 1 }}>{c.alias}</span>
                <button type="button" className="chip" onClick={() => { setReaching(c); setSent(''); setProblem(''); }}>Invite</button>
              </div>
            ))}
          </div>
        </>
      ) : null}
      {reaching ? (
        <div className="sheet" role="dialog" aria-modal="true" onClick={() => setReaching(null)}>
          <div className="stack" onClick={(e) => e.stopPropagation()}>
            <h2>Invite {reaching.alias} to talk</h2>
            <textarea
              className="field"
              style={{ minHeight: 90 }}
              value={line}
              maxLength={600}
              autoFocus
              placeholder="What is going on? A line or two."
              aria-label="What is going on?"
              onChange={(e) => setLine(e.target.value)}
            />
            {problem ? <p className="error">{problem}</p> : null}
            <button type="button" className="btn primary" disabled={!line.trim()} onClick={invite}>Send invitation</button>
            <button type="button" className="btn quiet" onClick={() => setReaching(null)}>Cancel</button>
          </div>
        </div>
      ) : null}
      <div className="grow" />
      {bot ? (
        <p className="small center">Prefer Telegram? <a href={`https://t.me/${bot}`} style={{ color: 'inherit' }}>Open @{bot}</a></p>
      ) : null}
    </>
  );
}

function TopicChips({ selected, onToggle }) {
  return (
    <div className="chips">
      {MATCH_TOPICS.map((t) => (
        <button key={t.key} type="button" className="chip" aria-pressed={selected.includes(t.key)} onClick={() => onToggle(t.key)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

const toggle = (list, key) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);

function Vent({ view, setView, call, act, busy, error, setError }) {
  const [text, setText] = useState('');
  const [topics, setTopics] = useState([]);
  const [found, setFound] = useState(null);
  const [looking, setLooking] = useState(false);
  const [intent, setIntent] = useState(null); // 'advice' | 'listen': they must choose
  const empty = !text.trim() || !intent;

  const start = (pick) => act('/api/vent', { body: { text, topics, pick, intent } });

  const choose = async () => {
    setLooking(true);
    setError('');
    const result = await call('/api/candidates', { body: { text, topics } });
    setLooking(false);
    if (!result.ok) { setError(errorText(result.error)); return; }
    setFound(result.candidates);
    setView('pick');
  };

  if (view === 'pick') {
    return (
      <>
        <Brand onBack={() => setView('vent')} />
        <h1>{found?.length ? 'Who would you like to talk to?' : 'Nobody is free this second'}</h1>
        <p className="lede">
          {found?.length
            ? 'These people are available right now.'
            : 'An AI listener can start with you now, and a real person will be offered as soon as one is free.'}
        </p>
        {error ? <p className="error">{error}</p> : null}
        <div className="stack">
          {(found || []).map((c) => (
            <button key={c.id} type="button" className="card person" disabled={busy} onClick={() => start(c.id)}>
              <span className="avatar">{c.alias[0]}</span>
              <span>
                <span className="name">{c.alias}</span>
                <br />
                <span className="meta">
                  {c.sharedExperiences?.length
                    ? `Has been through ${experienceLabels(c.sharedExperiences)}`
                    : c.topics.length ? `Relates to ${topicLabels(c.topics).toLowerCase()}` : 'Open to anything'}
                  {c.helped ? ` · helped ${c.helped} ${c.helped === 1 ? 'person' : 'people'}` : ''}
                </span>
              </span>
            </button>
          ))}
          <button type="button" className="btn primary" disabled={busy} onClick={() => start(null)}>
            {found?.length ? 'Just connect me now' : 'Start now'}
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <Brand onBack={() => setView('home')} />
      <h1>What is on your mind?</h1>
      <p className="lede">A line or two is enough. It helps find someone who can relate.</p>
      <textarea
        className="field"
        value={text}
        maxLength={2000}
        autoFocus
        placeholder="Say it however it comes out…"
        aria-label="What is on your mind?"
        onChange={(e) => setText(e.target.value)}
      />
      <p className="small" style={{ margin: '14px 0 0' }}>What would help most right now?</p>
      <div className="chips" role="group" aria-label="What would help most">
        <button type="button" className="chip" aria-pressed={intent === 'advice'} onClick={() => setIntent('advice')}>I would like advice</button>
        <button type="button" className="chip" aria-pressed={intent === 'listen'} onClick={() => setIntent('listen')}>I just want someone to listen</button>
      </div>
      <p className="small" style={{ margin: '14px 0 0' }}>Is it about any of these? (optional)</p>
      <TopicChips selected={topics} onToggle={(key) => setTopics((t) => toggle(t, key))} />
      {error ? <p className="error">{error}</p> : null}
      <div className="stack">
        <button type="button" className="btn primary" disabled={busy || looking || empty} onClick={() => start(null)}>
          {busy ? 'Connecting…' : 'Connect me now'}
        </button>
        <button type="button" className="btn quiet" disabled={busy || looking || empty} onClick={choose}>
          Let me choose who
        </button>
      </div>
    </>
  );
}

function ListenForm({ profile, onStart, onBack, busy, error }) {
  const [topics, setTopics] = useState(profile?.topics || []);
  const [story, setStory] = useState(profile?.story || '');
  return (
    <>
      <Brand onBack={onBack} />
      <h1>Thank you for being here.</h1>
      <p className="lede">People are matched with someone who has been through the same thing. What have you been through?</p>
      <textarea
        className="field"
        style={{ minHeight: 96 }}
        value={story}
        maxLength={600}
        placeholder="For example: I lost my father two years ago, and I moved abroad alone for work."
        aria-label="What have you been through?"
        onChange={(e) => setStory(e.target.value)}
      />
      <p className="small" style={{ margin: '8px 0 0' }}>
        Optional, and never shown to anyone. It is only used to find people you can relate to
        {profile?.experiences?.length ? <>. Right now: {experienceLabels(profile.experiences)}</> : null}.
      </p>
      <TopicChips selected={topics} onToggle={(key) => setTopics((t) => toggle(t, key))} />
      <p className="small">You do not need to fix anything. Listen, be kind, and end the conversation if it is not right for you.</p>
      {error ? <p className="error">{error}</p> : null}
      <div className="grow" />
      <button type="button" className="btn primary" disabled={busy} onClick={() => onStart(topics, story)}>I am available</button>
    </>
  );
}

function Waiting({ listening, onStop, busy, bot, presence, notifyLinked, call, server }) {
  return (
    <>
      <Brand />
      <div className="pulse" aria-hidden="true"><i /><i /><i /></div>
      <h1 className="center">You are available</h1>
      {presence?.waiting ? (
        <p className="small center">{presence.waiting} {presence.waiting === 1 ? 'person is' : 'people are'} waiting to be heard right now.</p>
      ) : null}
      <p className="lede center">
        Keep this page open. You will be connected the moment someone needs you
        {listening?.alias ? <>, as <strong>{listening.alias}</strong></> : null}.
      </p>
      {listening?.experiences?.length ? (
        <p className="small center">First in line for people going through: {experienceLabels(listening.experiences)}</p>
      ) : listening?.topics?.length ? (
        <p className="small center">Listening for: {topicLabels(listening.topics).toLowerCase()}</p>
      ) : null}
      <div className="grow" />
      <PushAlerts server={server} call={call} />
      <NotifyLink bot={bot} linked={notifyLinked} call={call} />
      {bot ? (
        <p className="small center">
          This page only keeps you available while it is open. To be available for 24 hours, even with this closed, open{' '}
          <a href={`https://t.me/${bot}`} target="_blank" rel="noreferrer noopener" style={{ color: 'inherit' }}>@{bot}</a>{' '}
          on Telegram and tap &ldquo;I am here to listen&rdquo;.
        </p>
      ) : null}
      <button type="button" className="btn" disabled={busy} onClick={onStop}>Stop listening</button>
    </>
  );
}

function Chat({ chat, presence, bot, notifyLinked, server, messages, helpline, call, act, addMessages, onLeave, error, setError }) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [confirmContact, setConfirmContact] = useState(false);
  const [menu, setMenu] = useState(false);
  const [heard, setHeard] = useState(null);
  const [note, setNote] = useState('');
  const [rated, setRated] = useState(false);
  const logRef = useRef(null);
  const inputRef = useRef(null);
  const ended = chat.status === 'ended';
  const isAi = chat.mode === 'ai';
  const isWaiting = chat.mode === 'waiting';   // nobody yet, and nothing replying
  const noPerson = isAi || isWaiting;
  const name = isWaiting ? (ended ? 'Nobody was free' : 'Looking for someone') : isAi ? AI_NAME : chat.partner || 'Someone';
  const [showWall, setShowWall] = useState(false);
  const [showEarlier, setShowEarlier] = useState(false);
  const [posted, setPosted] = useState('');
  const [keepWaiting, setKeepWaiting] = useState(false);
  const [replyTo, setReplyTo] = useState(null); // the message being answered: { id, from, body }
  const quietHours = Math.floor((chat.quietSecs || 0) / 3600);
  const opening = messages.find((m) => m.from === 'me' && m.kind === 'text')?.body || '';

  const postToWall = async () => {
    setError('');
    const result = await call('/api/wall', { body: { body: opening.slice(0, 600) } });
    if (result.ok) setPosted('Posted to Shared stories. You will see who has been there too.');
    else setError(errorText(result.error));
  };

  useLayoutEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, chat.typing, chat.offer]);

  const send = async (confirm = false) => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError('');
    const result = await call('/api/chat/message', { body: { body, confirm, replyTo: replyTo?.id || null } });
    setSending(false);
    if (result.warn === 'contact') { setConfirmContact(true); return; }
    setConfirmContact(false);
    if (!result.ok) { setError(errorText(result.error)); return; }
    addMessages([{ id: result.id, from: 'me', kind: 'text', body, reply: replyTo ? { id: replyTo.id, from: replyTo.from, body: replyTo.body.slice(0, 140) } : null }]);
    setReplyTo(null);
    // Clear only what was sent: anything typed while it was on its way stays.
    setDraft((current) => (current.trim() === body ? '' : current));
    inputRef.current?.focus();
  };

  const sendFeedback = async () => {
    setError('');
    const result = await call('/api/chat/feedback', { body: { heard, note: heard > 0 ? note : '' } });
    if (result.ok) setRated(true);
    else setError(result.error === 'contact_in_note' ? 'Please leave names, numbers and links out of the note.' : errorText(result.error));
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
  };

  return (
    <main className="chat">
      <header className="chat-head">
        {isWaiting && !ended
          ? <span className="avatar seeking" aria-hidden="true"><i /></span>
          : <span className={`avatar${isAi ? ' ai' : ''}`}>{isAi ? 'AI' : isWaiting ? '·' : name[0]}</span>}
        <div className="who">
          <div className="name">{name}</div>
          <div className="meta">
            {isWaiting ? (ended ? 'Your words are saved in Your conversations' : waitingLine(presence)) : isAi ? (chat.searching ? 'An AI · looking for someone who has been through this' : 'An AI, not a person') : chat.partnerAway && !ended ? 'They seem to have stepped away' : chat.role === 'venter' ? 'A real person, here to listen' : `Going through ${chat.experiences?.length ? experienceLabels(chat.experiences) : topicLabels(chat.topics).toLowerCase()}${chat.intent ? ` · ${chat.intent === 'advice' ? 'would like advice' : 'just wants to be heard'}` : ''}`}
          </div>
        </div>
        {ended ? null : <button type="button" onClick={() => setMenu(true)}>End</button>}
      </header>

      {chat.previous ? (
        <p className="earlier small">
          You talked with <strong>{chat.previous.with}</strong> before, on{' '}
          {new Date(chat.previous.endedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}.{' '}
          <button type="button" className="linklike" onClick={() => setShowEarlier(true)}>Read that conversation</button>
        </p>
      ) : null}

      <div className="log" ref={logRef} aria-live="polite">
        {messages.map((m) =>
          m.kind === 'help' ? (
            <div key={m.id} className="help">
              <strong>{HELP.title}</strong>
              {HELP.body}{' '}
              {helpline ? <><br /><br />{helpline}<br /></> : null}
              <a href={HELP.link} target="_blank" rel="noreferrer noopener">{HELP.linkLabel}</a>
            </div>
          ) : m.from === 'system' ? (
            <div key={m.id} className="note">{m.body}</div>
          ) : (
            <div key={m.id} id={`msg-${m.id}`} className={`msg ${m.from}`}>
              <div className={`bubble ${m.from}`}>
                <QuotedMessage reply={m.reply} name={name} />
                {m.body}
              </div>
              {ended ? null : (
                <button type="button" className="reply-btn" aria-label="Reply to this"
                  onClick={() => { setReplyTo({ id: m.id, from: m.from, body: m.body }); inputRef.current?.focus(); }}>
                  Reply
                </button>
              )}
            </div>
          ),
        )}
        {chat.typing && !ended ? <div className="dots" aria-label={`${AI_NAME} is writing`}><i /><i /><i /></div> : null}
      </div>

      {error ? <p className="error" style={{ margin: '0 16px 8px' }}>{error}</p> : null}

      {isWaiting && !ended ? (
        <div className="banner quietly stack">
          {chat.asked > 0 ? (
            <p className="small center">
              We have asked {chat.asked} {chat.asked === 1 ? 'person' : 'people'} to listen. You will be connected the moment one says yes.
            </p>
          ) : null}
          <NotifyLink bot={bot} linked={notifyLinked} call={call} />
          <PushAlerts server={server} call={call} />
          <button type="button" className="btn" onClick={() => setShowWall(true)}>Read shared stories while you wait</button>
        </div>
      ) : null}

      {chat.mode === 'human' && !ended && bot && !notifyLinked ? (
        <div className="banner quietly"><NotifyLink bot={bot} linked={notifyLinked} call={call} /></div>
      ) : null}

      {chat.endRequest === 'them' && !ended ? (
        <div className="banner">
          <p>{name} would like to finish. Are you done too, or do you want to wait? The conversation stays open until you decide.</p>
          <div className="row">
            <button type="button" className="btn" onClick={() => act('/api/chat/end', { body: { keep: true } })}>Keep talking</button>
            <button type="button" className="btn primary" onClick={() => act('/api/chat/end')}>I am done too</button>
          </div>
        </div>
      ) : null}

      {chat.endRequest === 'me' && !ended ? (
        <div className="banner">
          <p>You asked to finish. It stays open until {name} agrees, so there is no hurry.</p>
          <div className="row">
            <button type="button" className="btn" onClick={() => act('/api/chat/end', { body: { keep: true } })}>Keep talking</button>
          </div>
        </div>
      ) : null}

      {quietHours >= 3 && !ended && !keepWaiting && !chat.endRequest ? (
        <div className="banner">
          <p>
            {name} has been quiet for {quietHours} hours. You can keep waiting, or end this and talk to someone new. It stays
            open until you decide.
          </p>
          <div className="row">
            <button type="button" className="btn" onClick={() => setKeepWaiting(true)}>Keep waiting</button>
            <button type="button" className="btn primary" onClick={() => act('/api/chat/end')}>End and start new</button>
          </div>
        </div>
      ) : null}

      {showEarlier && chat.previous ? (
        <div className="sheet tall" role="dialog" aria-modal="true">
          <div><History call={call} startId={chat.previous.id} onBack={() => setShowEarlier(false)} /></div>
        </div>
      ) : null}

      {showWall ? (
        <div className="sheet tall" role="dialog" aria-modal="true">
          <div><Wall call={call} onBack={() => setShowWall(false)} backLabel="Back to waiting" /></div>
        </div>
      ) : null}

      {chat.offer && !ended ? (
        <div className="banner">
          <p><strong>{chat.offer.alias}</strong>, a real person, is free now. They would see your first message, not your chat with the AI.</p>
          <div className="row">
            <button type="button" className="btn primary" onClick={() => act('/api/chat/handoff', { body: { accept: true } })}>Talk to them</button>
            <button type="button" className="btn" onClick={() => act('/api/chat/handoff', { body: { accept: false } })}>Stay with AI</button>
          </div>
        </div>
      ) : null}

      {confirmContact ? (
        <div className="banner warn">
          <p>That looks like it contains contact details. Sharing them ends your anonymity.</p>
          <div className="row">
            <button type="button" className="btn" onClick={() => setConfirmContact(false)}>Edit message</button>
            <button type="button" className="btn" onClick={() => send(true)}>Send anyway</button>
          </div>
        </div>
      ) : null}

      {ended && chat.canRate && !rated ? (
        <div className="ended stack">
          <strong>Did you feel heard?</strong>
          <div className="row">
            {[['Yes', 2], ['A little', 1], ['No', 0]].map(([label, value]) => (
              <button key={value} type="button" className="btn" aria-pressed={heard === value} onClick={() => setHeard(value)}>{label}</button>
            ))}
          </div>
          {heard > 0 ? (
            <textarea
              className="field"
              style={{ minHeight: 70 }}
              value={note}
              maxLength={300}
              placeholder="Leave them a short thank-you (optional)"
              aria-label="Thank-you note"
              onChange={(e) => setNote(e.target.value)}
            />
          ) : null}
          <AgainButton chat={chat} act={act} />
          <button type="button" className="btn primary" disabled={heard === null} onClick={sendFeedback}>Send</button>
          <button type="button" className="btn quiet" onClick={onLeave}>Skip</button>
        </div>
      ) : ended ? (
        <div className="ended stack">
          {rated ? <p className="small center">Thank you. That helps the next person find the right listener.</p> : null}
          <AgainButton chat={chat} act={act} />
          {isWaiting && chat.role === 'venter' && opening ? (
            posted
              ? <p className="small center">{posted}</p>
              : (
                <>
                  <p className="small center">Nobody was free this time. Your words do not have to go unheard:</p>
                  <button type="button" className="btn" onClick={postToWall}>Post this to Shared stories</button>
                </>
              )
          ) : null}
          <button type="button" className="btn primary" onClick={onLeave}>Back to start</button>
          {noPerson ? null : (
            <button type="button" className="btn quiet" onClick={() => act('/api/chat/report', { body: { reason: 'after chat' } }, onLeave)}>
              Report this person
            </button>
          )}
        </div>
      ) : (
        <form className="composer" onSubmit={(e) => { e.preventDefault(); send(); }}>
          {replyTo ? (
            <div className="replying">
              <span>Replying to {replyTo.from === 'me' ? 'yourself' : name}: {replyTo.body.length > 80 ? `${replyTo.body.slice(0, 80)}…` : replyTo.body}</span>
              <button type="button" aria-label="Cancel reply" onClick={() => setReplyTo(null)}>✕</button>
            </div>
          ) : null}
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            maxLength={2000}
            placeholder="Write a message"
            aria-label="Message"
            onChange={(e) => { setDraft(e.target.value); setConfirmContact(false); }}
            onKeyDown={onKeyDown}
          />
          <button type="submit" disabled={sending || !draft.trim()}>Send</button>
        </form>
      )}

      {menu ? (
        <div className="sheet" role="dialog" aria-modal="true" onClick={() => setMenu(false)}>
          <div className="stack" onClick={(e) => e.stopPropagation()}>
            <h2>{noPerson ? 'End this conversation?' : 'Finish this conversation?'}</h2>
            {noPerson ? null : <p className="small">{name} will be asked. It stays open until they agree, however long that takes.</p>}
            <button type="button" className="btn primary" onClick={() => { setMenu(false); act('/api/chat/end'); }}>{noPerson ? 'End conversation' : 'Ask to finish'}</button>
            {noPerson ? null : (
              <button type="button" className="btn" onClick={() => { setMenu(false); act('/api/chat/report', { body: { reason: 'during chat' } }); }}>
                Report and block this person
              </button>
            )}
            <button type="button" className="btn quiet" onClick={() => setMenu(false)}>Keep talking</button>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function AgainButton({ chat, act }) {
  const again = chat.again;
  if (!again?.canKeep) return null;
  if (again.mutual) return <p className="small center">You both said you would talk again. You can invite them from the start screen.</p>;
  if (again.kept) return <p className="small center">Noted. If they say the same, you will be able to reach each other again.</p>;
  return <button type="button" className="btn" onClick={() => act('/api/chat/again')}>I would talk to them again</button>;
}

function Wall({ call, onBack, backLabel }) {
  const [posts, setPosts] = useState(null);
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await call('/api/wall', { method: 'GET' });
    if (result.ok) setPosts(result.posts);
    else setProblem(errorText(result.error));
  }, [call]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 8000);
    return () => clearInterval(timer);
  }, [load]);

  const run = async (path, options) => {
    setBusy(true);
    setProblem('');
    const result = await call(path, options);
    setBusy(false);
    if (!result.ok) { setProblem(errorText(result.error)); return false; }
    await load();
    return true;
  };

  const share = async () => { if (await run('/api/wall', { body: { body: draft } })) setDraft(''); };

  return (
    <>
      <Brand onBack={onBack} backLabel={backLabel} />
      <h1>Shared stories</h1>
      <p className="lede">Anonymous, and gone after a week. If you have been through the same, say so.</p>
      <textarea
        className="field"
        style={{ minHeight: 90 }}
        value={draft}
        maxLength={600}
        placeholder="Share what you are going through…"
        aria-label="Share what you are going through"
        onChange={(e) => setDraft(e.target.value)}
      />
      {problem ? <p className="error">{problem}</p> : null}
      <button type="button" className="btn primary" style={{ margin: '10px 0 24px' }} disabled={busy || !draft.trim()} onClick={share}>Share anonymously</button>

      {posts === null ? <p className="small">Loading…</p> : null}
      {posts?.length === 0 ? <p className="small">Nothing here yet. Yours could be the first.</p> : null}
      <div className="stack">
        {(posts || []).map((post) => (
          <article key={post.id} className="card post">
            <div className="post-head">
              <span className="avatar">{post.alias[0]}</span>
              <span>
                <span className="name">{post.mine ? 'You' : post.alias}</span>
                {post.experiences.length ? <span className="meta"> · {experienceLabels(post.experiences)}</span> : null}
              </span>
            </div>
            <p className="post-body">{post.body}</p>
            {post.mine ? (
              <>
                <p className="small">
                  {post.relateCount === 0 ? 'Nobody has answered yet.' : `${post.relateCount} ${post.relateCount === 1 ? 'person has' : 'people have'} been there too.`}
                </p>
                {post.relaters.map((r) => (
                  <div key={r.id} className="person" style={{ marginTop: 8 }}>
                    <span className="avatar">{r.alias[0]}</span>
                    <span className="name" style={{ flex: 1 }}>{r.alias}</span>
                    {r.invited
                      ? <span className="small">Invited</span>
                      : <button type="button" className="chip" disabled={busy} onClick={() => run('/api/invites', { body: { relateId: r.id } })}>Invite to talk</button>}
                  </div>
                ))}
                <button type="button" className="btn quiet" style={{ padding: '8px 0 0', textAlign: 'left' }} disabled={busy} onClick={() => run(`/api/wall?id=${post.id}`, { method: 'DELETE' })}>Remove my post</button>
              </>
            ) : (
              <div className="row" style={{ alignItems: 'center' }}>
                <button type="button" className="chip" aria-pressed={post.iRelated} disabled={busy || post.iRelated} onClick={() => run('/api/wall/relate', { body: { postId: post.id } })}>
                  {post.iRelated ? 'You have been there' : 'I have been there'}
                </button>
                <span className="small" style={{ flex: 1 }}>{post.relateCount ? `${post.relateCount} so far` : ''}{post.shared ? ' · close to your story' : ''}</span>
                <button type="button" className="btn quiet" style={{ width: 'auto', padding: 4, fontSize: 13 }} disabled={busy} onClick={() => run('/api/wall/report', { body: { postId: post.id } })}>Report</button>
              </div>
            )}
          </article>
        ))}
      </div>
    </>
  );
}

function History({ call, onBack, startId = null }) {
  const [list, setList] = useState(null);
  const [open, setOpen] = useState(null);       // one conversation in full
  const [problem, setProblem] = useState('');

  const load = useCallback(async () => {
    const result = await call('/api/history', { method: 'GET' });
    if (result.ok) setList(result.conversations);
    else setProblem(errorText(result.error));
  }, [call]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (startId) view(startId); }, [startId]); // eslint-disable-line react-hooks/exhaustive-deps

  const view = async (id) => {
    setProblem('');
    const result = await call(`/api/history?id=${id}`, { method: 'GET' });
    if (result.ok) setOpen(result);
    else setProblem(errorText(result.error));
  };
  const remove = async (query) => {
    setProblem('');
    const result = await call(`/api/history?${query}`, { method: 'DELETE' });
    if (!result.ok) { setProblem(errorText(result.error)); return; }
    setOpen(null);
    await load();
  };
  const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const title = (c) => (c.answered ? `${c.role === 'venter' ? 'You talked with' : 'You listened to'} ${c.with}` : 'A vent nobody was free for');

  if (open) {
    return (
      <>
        <Brand onBack={() => (startId ? onBack() : setOpen(null))} />
        <h2>{title(open.chat)}</h2>
        <p className="small">{day(open.chat.endedAt)} · only you can see this</p>
        <div className="log past">
          {open.messages.filter((m) => m.kind !== 'help').map((m) =>
            m.from === 'system'
              ? <div key={m.id} className="note">{m.body}</div>
              : <div key={m.id} className={`bubble ${m.from}`}><QuotedMessage reply={m.reply} name={open.chat.with || 'Them'} />{m.body}</div>)}
        </div>
        {problem ? <p className="error">{problem}</p> : null}
        <button type="button" className="btn" style={{ marginTop: 16 }} onClick={() => remove(`id=${open.chat.id}`)}>Remove from my conversations</button>
      </>
    );
  }

  return (
    <>
      <Brand onBack={onBack} />
      <h1>Your conversations</h1>
      <p className="lede">Kept for 30 days on this device&rsquo;s anonymous identity, then deleted. Only you can see them.</p>
      {problem ? <p className="error">{problem}</p> : null}
      {list === null ? <p className="small">Loading…</p> : null}
      {list?.length === 0 ? <p className="small">Nothing here yet.</p> : null}
      <div className="stack">
        {(list || []).map((c) => (
          <button key={c.id} type="button" className="card past-item" onClick={() => view(c.id)}>
            <span className="name">{title(c)}</span>
            <span className="meta"> · {day(c.endedAt)}</span>
            <span className="excerpt">{c.opening}</span>
          </button>
        ))}
      </div>
      {list?.length ? (
        <button type="button" className="btn quiet" style={{ marginTop: 16 }} onClick={() => remove('all=1')}>Remove all</button>
      ) : null}
    </>
  );
}

// A one-tap link that ties this visitor to Telegram for notifications only.
function NotifyLink({ bot, linked, call }) {
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  if (!bot) return null;
  if (linked) return <p className="small center">Telegram notifications are on. Send /unlink to the bot to stop them.</p>;

  const connect = async () => {
    setBusy(true);
    setProblem('');
    // Open the tab straight away (phones block pop-ups opened after a wait), then point it at Telegram.
    const tab = window.open('', '_blank');
    const result = await call('/api/link', { body: {} });
    setBusy(false);
    if (result.ok) {
      if (tab) tab.location.href = result.url;
      else window.location.href = result.url;
    } else {
      if (tab) tab.close();
      setProblem(errorText(result.error));
    }
  };

  return (
    <div className="notify-link">
      <button type="button" className="btn" disabled={busy} onClick={connect}>Get notified on Telegram</button>
      <p className="small center">When someone replies or joins, I will message you there. Nothing you write is ever sent. Nobody else sees it.</p>
      {problem ? <p className="error">{problem}</p> : null}
    </div>
  );
}

const AGE_BANDS = ['18-24', '25-34', '35-44', '45+'];
const GENDER_CHOICES = [['woman', 'Woman'], ['man', 'Man'], ['private', 'Prefer not to say']];
const LANGUAGE_CHOICES = [['en', 'English'], ['am', 'አማርኛ'], ['other', 'Other']];
const WANT_GENDER_CHOICES = [[null, 'Anyone'], ['same', 'Same as me'], ['woman', 'Women'], ['man', 'Men']];

/** Optional, skippable. The one big button says Skip until something is chosen, then Save. */
function Prefs({ first, initial, busy, error, onSave, onSkip, onBack }) {
  const [ageBand, setAgeBand] = useState(initial?.ageBand || null);
  const [gender, setGender] = useState(initial?.gender || null);
  const [language, setLanguage] = useState(initial?.language || null);
  const [wantsAge, setWantsAge] = useState(initial?.wantsAge || []);
  const [wantsGender, setWantsGender] = useState(initial?.wantsGender || null);
  const anything = Boolean(ageBand || gender || language || wantsAge.length || wantsGender);
  const toggleOne = (current, set, value) => set(current === value ? null : value);

  return (
    <>
      <Brand onBack={first ? undefined : onBack} />
      <h1>{first ? 'Make matches better' : 'Preferences'}</h1>
      <p className="lede">Optional. It only changes who you are offered first. Nobody else ever sees it, and nobody waits longer because of it.</p>

      <h2 style={{ fontSize: 19 }}>About you</h2>
      <p className="small">Age range</p>
      <div className="chips">
        {AGE_BANDS.map((b) => <button key={b} type="button" className="chip" aria-pressed={ageBand === b} onClick={() => toggleOne(ageBand, setAgeBand, b)}>{b.replace('-', '–')}</button>)}
      </div>
      <p className="small">Gender</p>
      <div className="chips">
        {GENDER_CHOICES.map(([k, label]) => <button key={k} type="button" className="chip" aria-pressed={gender === k} onClick={() => toggleOne(gender, setGender, k)}>{label}</button>)}
      </div>
      <p className="small">Language</p>
      <div className="chips">
        {LANGUAGE_CHOICES.map(([k, label]) => <button key={k} type="button" className="chip" aria-pressed={language === k} onClick={() => toggleOne(language, setLanguage, k)}>{label}</button>)}
      </div>

      <h2 style={{ fontSize: 19 }}>Who would you like to talk to?</h2>
      <p className="small">Age range (none chosen means anyone)</p>
      <div className="chips">
        {AGE_BANDS.map((b) => (
          <button key={b} type="button" className="chip" aria-pressed={wantsAge.includes(b)}
            onClick={() => setWantsAge((list) => (list.includes(b) ? list.filter((x) => x !== b) : [...list, b]))}>{b.replace('-', '–')}</button>
        ))}
      </div>
      <p className="small">Gender</p>
      <div className="chips">
        {WANT_GENDER_CHOICES.map(([k, label]) => <button key={String(k)} type="button" className="chip" aria-pressed={wantsGender === k} onClick={() => setWantsGender(k)}>{label}</button>)}
      </div>

      {error ? <p className="error">{error}</p> : null}
      <div className="grow" />
      <div className="stack">
        {anything ? (
          <button type="button" className="btn primary" disabled={busy} onClick={() => onSave({ ageBand, gender, language, wantsAge, wantsGender })}>Save</button>
        ) : (
          <button type="button" className="btn primary" disabled={busy} onClick={first ? onSkip : () => onSave({})}>{first ? 'Skip for now' : 'Save (no preferences)'}</button>
        )}
        {first && anything ? <button type="button" className="btn quiet" disabled={busy} onClick={onSkip}>Skip for now</button> : null}
      </div>
    </>
  );
}

// The message a reply answers, shown above it. Tapping it jumps to the original.
function QuotedMessage({ reply, name }) {
  if (!reply) return null;
  const who = reply.from === 'me' ? 'You' : reply.from === 'ai' ? AI_NAME : name;
  const jump = () => {
    const el = document.getElementById(`msg-${reply.id}`);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1200);
    }
  };
  return (
    <button type="button" className="quote" onClick={jump} aria-label={`In reply to ${who}: ${reply.body}`}>
      <strong>{who}</strong>
      <span>{reply.body}</span>
    </button>
  );
}

const b64ToBytes = (b64) => {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

// Browser alerts for website visitors: "someone needs to be heard", replies, and joins.
// Never carries what anyone wrote.
function PushAlerts({ server, call, act }) {
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [supported, setSupported] = useState(true);
  useEffect(() => {
    setSupported('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window);
  }, []);
  if (!server?.pushSupported) return null;

  const refresh = () => (act ? act('/api/push', { method: 'GET' }) : null);

  const turnOn = async () => {
    setBusy(true);
    setProblem('');
    try {
      if (Notification.permission === 'denied') throw new Error('denied');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('denied');
      const registration = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const sub = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(server.pushKey) });
      const result = await call('/api/push', { body: { subscription: sub.toJSON() } });
      if (!result.ok) throw new Error('save');
      await refresh();
    } catch (e) {
      setProblem(e.message === 'denied'
        ? 'Alerts are blocked for this site. Allow notifications in your browser settings, then try again.'
        : 'Could not turn alerts on here. Please try again.');
    }
    setBusy(false);
  };

  const turnOff = async () => {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration('/sw.js');
      const sub = await reg?.pushManager.getSubscription();
      await call('/api/push', { method: 'DELETE', body: { endpoint: sub?.endpoint } });
      await sub?.unsubscribe();
      await refresh();
    } catch { /* the server copy is removed either way */ }
    setBusy(false);
  };

  if (!supported) {
    return <p className="small center">To get alerts on an iPhone, add My Home to your Home Screen first (Share, then Add to Home Screen).</p>;
  }
  if (server.pushOn) {
    return (
      <div className="notify-link">
        <p className="small center">Alerts are on: you will be told when someone needs a listener. Nothing anyone writes is ever sent.</p>
        <button type="button" className="btn quiet" disabled={busy} onClick={turnOff}>Turn alerts off</button>
      </div>
    );
  }
  return (
    <div className="notify-link">
      <button type="button" className="btn" disabled={busy} onClick={turnOn}>Alert me when someone needs to talk</button>
      <p className="small center">A notification on this device, even when this page is closed. You can turn it off any time.</p>
      {problem ? <p className="error">{problem}</p> : null}
    </div>
  );
}

// Opened from an alert: say what is being asked, and let them answer with one tap.
function HelpRequest({ chatId, call, onDone }) {
  const [info, setInfo] = useState(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    call(`/api/ping?chat=${chatId}`, { method: 'GET' }).then((r) => { if (live) setInfo(r.ok ? r : { open: false }); });
    return () => { live = false; };
  }, [call, chatId]);

  const answer = async (accept) => {
    setBusy(true);
    const result = await call('/api/ping', { body: { chat: chatId, accept } });
    setBusy(false);
    if (!result.ok && accept) {
      setInfo({ open: false });
      return;
    }
    onDone();
  };

  if (!info) return <><Brand /><p className="small center">One moment…</p></>;
  if (!info.open) {
    return (
      <>
        <Brand />
        <h1>Thank you</h1>
        <p className="lede">Someone else is already with them, or they are no longer waiting. You did not miss anything you could have done.</p>
        <div className="grow" />
        <button type="button" className="btn primary" onClick={onDone}>Continue</button>
      </>
    );
  }
  return (
    <>
      <Brand />
      <h1>Can you listen right now?</h1>
      <p className="lede">{info.text}</p>
      <p className="small">You will be connected straight away and stay anonymous. You can end it any time.</p>
      {problem ? <p className="error">{problem}</p> : null}
      <div className="grow" />
      <div className="stack">
        <button type="button" className="btn primary" disabled={busy} onClick={() => answer(true)}>Yes, I can listen</button>
        <button type="button" className="btn quiet" disabled={busy} onClick={() => answer(false)}>Not now</button>
      </div>
    </>
  );
}

// Share the app: the phone's share sheet where there is one, otherwise a few simple options.
function ShareApp() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = 'My Home: a place to say it out loud, or to listen. Anonymous, no accounts.';
  const url = typeof window === 'undefined' ? '' : window.location.origin;

  const share = async () => {
    if (typeof navigator !== 'undefined' && navigator.share) {
      try { await navigator.share({ title: 'My Home', text, url }); return; } catch (e) { if (e?.name === 'AbortError') return; }
    }
    setOpen(true);
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(`${text} ${url}`); setCopied(true); setTimeout(() => setCopied(false), 2500); } catch { /* the link is shown below */ }
  };
  const enc = encodeURIComponent;
  return (
    <>
      <button type="button" className="btn quiet" onClick={share}>Share My Home</button>
      {open ? (
        <div className="sheet" role="dialog" aria-modal="true" aria-label="Share My Home" onClick={() => setOpen(false)}>
          <div className="stack" onClick={(e) => e.stopPropagation()}>
            <h2>Share My Home</h2>
            <p className="small">More people means someone is free sooner. Nothing about you is shared.</p>
            <button type="button" className="btn primary" onClick={copy}>{copied ? 'Copied' : 'Copy link'}</button>
            <a className="btn" href={`https://t.me/share/url?url=${enc(url)}&text=${enc(text)}`} target="_blank" rel="noreferrer noopener">Share on Telegram</a>
            <a className="btn" href={`https://wa.me/?text=${enc(`${text} ${url}`)}`} target="_blank" rel="noreferrer noopener">Share on WhatsApp</a>
            <p className="small center" style={{ wordBreak: 'break-all' }}>{url}</p>
            <button type="button" className="btn quiet" onClick={() => setOpen(false)}>Close</button>
          </div>
        </div>
      ) : null}
    </>
  );
}
