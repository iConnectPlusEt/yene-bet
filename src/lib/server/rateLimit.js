// Fixed-window rate limit kept in Postgres, so it holds across serverless
// instances and cold starts.
import { db } from './db.js';

/** Counts one hit. Returns true while the caller is within the limit. */
export async function allow(key, max, windowSecs) {
  const [row] = await db()`
    insert into rate_limits (key, window_start, count) values (${key}, now(), 1)
    on conflict (key) do update set
      count = case when rate_limits.window_start < now() - make_interval(secs => ${windowSecs})
                   then 1 else rate_limits.count + 1 end,
      window_start = case when rate_limits.window_start < now() - make_interval(secs => ${windowSecs})
                   then now() else rate_limits.window_start end
    returning count`;
  return row.count <= max;
}

export const LIMITS = {
  message: (personId) => allow(`msg:${personId}`, 40, 60),
  start: (personId) => allow(`start:${personId}`, 12, 600),
  session: (ipHash) => allow(`session:${ipHash}`, 30, 3600),
  post: (personId) => allow(`post:${personId}`, 5, 86400),
  invite: (personId) => allow(`invite:${personId}`, 10, 3600),
};
