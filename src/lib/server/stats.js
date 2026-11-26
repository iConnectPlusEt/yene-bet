// Totals about how the app is being used. Numbers only: nothing in here reads
// message text, aliases or anything that could identify a person, and the
// identities used for testing (people.is_test) are left out of every count.
import { db } from './db.js';

const DAYS = 14;
const tz = () => process.env.STATS_TZ || 'Africa/Addis_Ababa';
const num = (v) => (v === null || v === undefined ? null : Math.round(Number(v)));

export async function getStats() {
  const sql = db();
  const zone = tz();

  const [people] = await sql`
    select
      count(*) filter (where not is_test)::int as total,
      count(*) filter (where not is_test and channel = 'telegram')::int as telegram,
      count(*) filter (where not is_test and channel = 'web')::int as web,
      count(*) filter (where not is_test and rules_accepted_at is not null)::int as got_in,
      count(*) filter (where not is_test and rules_accepted_at is not null and channel = 'telegram')::int as got_in_telegram,
      count(*) filter (where not is_test and rules_accepted_at is not null and last_seen_at > now() - interval '24 hours')::int as active_24h,
      count(*) filter (where not is_test and rules_accepted_at is not null and last_seen_at > now() - interval '7 days')::int as active_7d,
      count(*) filter (where not is_test and rules_accepted_at is not null and last_seen_at > now() - interval '30 days')::int as active_30d,
      count(*) filter (where is_test)::int as test_excluded,
      min(created_at) filter (where not is_test) as first_seen
    from people`;

  const [conv] = await sql`
    select
      count(*)::int as total,
      count(*) filter (where c.listener_id is not null)::int as answered,
      count(*) filter (where c.created_at > now() - interval '7 days')::int as total_7d,
      count(*) filter (where c.created_at > now() - interval '7 days' and c.listener_id is not null)::int as answered_7d,
      count(distinct c.venter_id)::int as people_who_vented,
      count(distinct c.listener_id)::int as people_who_listened,
      count(*) filter (where c.connected_at is not null)::int as waits_measured,
      count(*) filter (where c.connected_at is not null and c.connected_at - c.created_at <= interval '60 seconds')::int as within_60s,
      percentile_cont(0.5) within group (order by extract(epoch from c.connected_at - c.created_at)) filter (where c.connected_at is not null) as wait_median,
      percentile_cont(0.9) within group (order by extract(epoch from c.connected_at - c.created_at)) filter (where c.connected_at is not null) as wait_p90,
      max(extract(epoch from c.connected_at - c.created_at)) filter (where c.connected_at is not null) as wait_max
    from chats c
    join people v on v.id = c.venter_id
    left join people l on l.id = c.listener_id
    where not v.is_test and (l.id is null or not l.is_test)`;

  const [supply] = await sql`
    select
      (select count(*) from listeners l join people p on p.id = l.person_id
        where not p.is_test and l.status = 'free' and l.expires_at > now())::int as available,
      (select count(*) from listeners l join people p on p.id = l.person_id
        where not p.is_test and l.status = 'busy')::int as in_conversation,
      (select count(*) from chats c join people v on v.id = c.venter_id
        where not v.is_test and c.status = 'active' and c.mode = 'ai' and c.wants_human)::int as waiting`;

  const [reach] = await sql`
    select
      count(*) filter (where channel = 'telegram' and rules_accepted_at is not null and unreachable_at is null
                         and notify_requests and last_seen_at > now() - interval '30 days')::int as reachable,
      count(*) filter (where channel = 'telegram' and unreachable_at is not null)::int as blocked_bot,
      count(*) filter (where channel = 'telegram' and not notify_requests)::int as stopped_requests
    from people where not is_test`;
  const [pings] = await sql`
    select count(*)::int as sent_7d, count(*) filter (where g.answered)::int as tapped_7d
    from pings g join people p on p.id = g.person_id
    where not p.is_test and g.created_at > now() - interval '7 days'`;

  const [quality] = await sql`
    select count(*)::int as ratings,
           count(*) filter (where f.heard = 2)::int as yes,
           count(*) filter (where f.heard = 1)::int as a_little,
           count(*) filter (where f.heard = 0)::int as no
    from feedback f join people p on p.id = f.listener_id where not p.is_test`;
  // Safety: how many people reported someone, and how many have been suspended. Numbers only.
  const [safety] = await sql`
    select (select count(*) from reports r join people p on p.id = r.reported_id where not p.is_test)::int as reports,
           (select count(*) from reports r join people p on p.id = r.reported_id
             where not p.is_test and r.created_at > now() - interval '7 days')::int as reports_7d,
           (select count(*) from people where suspended_at is not null and not is_test)::int as suspended`;
  // Where people leave, per channel: opened, agreed to the rules, passed the preferences
  // screen, vented, offered to listen, and ended up talking to a real person.
  const funnelRows = await sql`
    select p.channel,
      count(*)::int as opened,
      count(*) filter (where p.rules_accepted_at is not null)::int as agreed,
      count(*) filter (where p.prefs_seen_at is not null)::int as prefs,
      count(*) filter (where exists (select 1 from chats c where c.venter_id = p.id))::int as vented,
      count(*) filter (where p.listens_count > 0
                         or exists (select 1 from listener_profiles lp where lp.person_id = p.id)
                         or exists (select 1 from chats c where c.listener_id = p.id))::int as listened,
      count(*) filter (where exists (select 1 from chats c where c.listener_id is not null
                                       and (c.venter_id = p.id or c.listener_id = p.id)))::int as talked
    from people p where not p.is_test group by p.channel`;

  // How each request wave does: asked, answered, and how fast.
  const waveRows = await sql`
    select g.wave, g.channel,
      count(*)::int as sent,
      count(*) filter (where g.answered)::int as answered,
      count(*) filter (where g.response = 'not_now')::int as not_now,
      count(*) filter (where g.response = 'week')::int as week,
      count(*) filter (where g.response = 'stop')::int as stop,
      count(*) filter (where g.response is null and not g.answered)::int as ignored,
      count(*) filter (where g.created_at > now() - interval '7 days')::int as sent_7d,
      count(*) filter (where g.created_at > now() - interval '7 days' and g.answered)::int as answered_7d,
      percentile_cont(0.5) within group (order by extract(epoch from g.answered_at - g.created_at))
        filter (where g.answered and g.answered_at is not null) as median_secs
    from pings g join people p on p.id = g.person_id
    where not p.is_test group by g.wave, g.channel order by g.wave, g.channel`;

  // Nudges to people who joined but never started: sent, how many then started, how many said "not for me".
  const [nudges] = await sql`
    select coalesce(sum(p.nudge_count), 0)::int as sent,
           count(*) filter (where p.nudge_count > 0)::int as people,
           count(*) filter (where p.nudge_count > 0 and exists (
             select 1 from chats c where (c.venter_id = p.id or c.listener_id = p.id) and c.created_at > p.nudged_at))::int as started,
           count(*) filter (where p.nudge_stopped)::int as stopped
    from people p where not p.is_test and p.channel = 'telegram'`;

  // Telegram versus website, by where the person who vented came from.
  const channelRows = await sql`
    select v.channel,
      count(*)::int as total,
      count(*) filter (where c.listener_id is not null)::int as answered,
      count(*) filter (where c.created_at > now() - interval '7 days')::int as total_7d,
      count(*) filter (where c.created_at > now() - interval '7 days' and c.listener_id is not null)::int as answered_7d,
      percentile_cont(0.5) within group (order by extract(epoch from c.connected_at - c.created_at)) filter (where c.connected_at is not null) as wait_median,
      percentile_cont(0.9) within group (order by extract(epoch from c.connected_at - c.created_at)) filter (where c.connected_at is not null) as wait_p90
    from chats c
    join people v on v.id = c.venter_id
    left join people l on l.id = c.listener_id
    where not v.is_test and (l.id is null or not l.is_test)
    group by v.channel`;
  const [wall] = await sql`
    select (select count(*) from posts q join people a on a.id = q.author_id where not a.is_test and not q.hidden)::int as posts,
           (select count(*) from post_relates r join posts q on q.id = r.post_id join people a on a.id = q.author_id
             where not a.is_test)::int as been_there`;

  const series = await sql`
    with days as (select ((now() at time zone ${zone})::date - g) as day from generate_series(0, ${DAYS - 1}) g)
    select to_char(d.day, 'YYYY-MM-DD') as day,
      (select count(*) from people p where not p.is_test and (p.created_at at time zone ${zone})::date = d.day)::int as new_people,
      (select count(*) from people p where not p.is_test and p.rules_accepted_at is not null
         and (p.created_at at time zone ${zone})::date = d.day)::int as new_got_in,
      (select count(*) from chats c join people v on v.id = c.venter_id
         where not v.is_test and (c.created_at at time zone ${zone})::date = d.day)::int as conversations,
      (select count(*) from chats c join people v on v.id = c.venter_id
         where not v.is_test and c.listener_id is not null and (c.created_at at time zone ${zone})::date = d.day)::int as answered,
      (select s.active_24h from daily_stats s where s.day = d.day) as active
    from days d order by d.day`;

  return {
    generatedAt: new Date().toISOString(),
    timezone: zone,
    people: {
      total: people.total,
      gotIn: people.got_in,
      openedOnly: people.total - people.got_in,
      telegram: people.telegram,
      web: people.web,
      gotInTelegram: people.got_in_telegram,
      active24h: people.active_24h,
      active7d: people.active_7d,
      active30d: people.active_30d,
      testExcluded: people.test_excluded,
      since: people.first_seen,
    },
    conversations: {
      total: conv.total,
      answered: conv.answered,
      answerRate: conv.total ? conv.answered / conv.total : null,
      total7d: conv.total_7d,
      answered7d: conv.answered_7d,
      answerRate7d: conv.total_7d ? conv.answered_7d / conv.total_7d : null,
      peopleWhoVented: conv.people_who_vented,
      peopleWhoListened: conv.people_who_listened,
      waitsMeasured: conv.waits_measured,
      connectedWithin60s: conv.waits_measured ? conv.within_60s / conv.waits_measured : null,
      waitMedianSecs: num(conv.wait_median),
      waitP90Secs: num(conv.wait_p90),
      waitMaxSecs: num(conv.wait_max),
    },
    supply: { availableNow: supply.available, inConversation: supply.in_conversation, waitingNow: supply.waiting },
    reach: {
      reachable: reach.reachable,
      blockedBot: reach.blocked_bot,
      stoppedRequests: reach.stopped_requests,
      requestsSent7d: pings.sent_7d,
      tappedListen7d: pings.tapped_7d,
    },
    quality: { ratings: quality.ratings, yes: quality.yes, aLittle: quality.a_little, no: quality.no },
    safety: { reports: safety.reports, reports7d: safety.reports_7d, suspended: safety.suspended },
    funnel: Object.fromEntries(funnelRows.map((r) => [r.channel, {
      opened: r.opened, agreed: r.agreed, preferences: r.prefs, vented: r.vented, listened: r.listened, talked: r.talked,
    }])),
    waves: waveRows.map((r) => ({
      wave: r.wave, channel: r.channel, sent: r.sent, answered: r.answered,
      notNow: r.not_now, week: r.week, stop: r.stop, ignored: r.ignored,
      sent7d: r.sent_7d, answered7d: r.answered_7d, medianSecs: num(r.median_secs),
    })),
    nudges: { sent: nudges.sent, people: nudges.people, started: nudges.started, stopped: nudges.stopped },
    channels: Object.fromEntries(channelRows.map((r) => [r.channel, {
      conversations: r.total, answered: r.answered, answerRate: r.total ? r.answered / r.total : null,
      conversations7d: r.total_7d, answered7d: r.answered_7d,
      waitMedianSecs: num(r.wait_median), waitP90Secs: num(r.wait_p90),
    }])),
    wall: { posts: wall.posts, beenThere: wall.been_there },
    series: series.map((d) => ({
      day: d.day,
      newPeople: d.new_people,
      newGotIn: d.new_got_in,
      conversations: d.conversations,
      answered: d.answered,
      active: d.active === null ? null : Number(d.active),
    })),
  };
}

/** Record today's figures (called by the one-minute background job). */
export async function recordDaily() {
  const zone = tz();
  await db()`
    insert into daily_stats (day, active_24h, people_total, got_in, telegram_reachable)
    select (now() at time zone ${zone})::date,
           count(*) filter (where rules_accepted_at is not null and last_seen_at > now() - interval '24 hours'),
           count(*),
           count(*) filter (where rules_accepted_at is not null),
           count(*) filter (where channel = 'telegram' and rules_accepted_at is not null and unreachable_at is null
                              and notify_requests and last_seen_at > now() - interval '30 days')
    from people where not is_test
    on conflict (day) do update
      set active_24h = excluded.active_24h, people_total = excluded.people_total,
          got_in = excluded.got_in, telegram_reachable = excluded.telegram_reachable, updated_at = now()`;
}
