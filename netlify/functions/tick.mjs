// Runs every minute on Netlify and nudges the app, which does the real work.
export default async () => {
  const base = (process.env.APP_URL || process.env.URL || '').replace(/\/$/, '');
  if (!base || !process.env.CRON_SECRET) return;
  try {
    await fetch(`${base}/api/cron/tick`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
      signal: AbortSignal.timeout(25000),
    });
  } catch (error) {
    console.error('[tick] failed', error?.message || error);
  }
};

export const config = { schedule: '* * * * *' };
