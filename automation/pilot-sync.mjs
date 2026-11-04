// ════════════════════════════════════════════════════════════════════════════
//  Daily reports at 11 am Chicago — built by the dashboard itself
//
//  Opens the dashboard in a headless browser, signs in as the automation
//  account, loads the data from Supabase, and presses "Send now" on the Reports
//  tab — so the emails are exactly what the dashboard builds by hand. Reports
//  cover the last COMPLETE business day (the dashboard leaves out a day still in
//  progress). The workflow runs the Pilot pull just before this, so yesterday is
//  complete.
//
//  Never sends twice in a day: if reports for the same day were already stored
//  this morning (after 10:55), it stops. Recipients are the ones from the last
//  push made in the dashboard (falling back to REPORT_RECIPIENTS).
//
//  THE REPO IS PUBLIC: this prints dates and counts only — never addresses or
//  report contents.
//
//  Environment:
//    DASHBOARD_URL, AUTOMATION_EMAIL, AUTOMATION_PASSWORD   required
//    REPORT_RECIPIENTS   used only when no push has ever stored recipients
//    FORCE=1             run whatever the time, even if already sent today
//    DRY_RUN=1           build the reports, send nothing
// ════════════════════════════════════════════════════════════════════════════
import { chromium } from 'playwright';

const env = process.env;
const log = m => console.log(m);
const fail = m => { console.error('FAILED: ' + m); process.exit(1); };
const mask = t => String(t || '').replace(/[^\s,;<>()"']+@[^\s,;<>()"']+/g, '«address»');
const chicago = d => new Date((d || new Date()).toLocaleString('en-US', { timeZone: 'America/Chicago' }));
const ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const FORCE = env.FORCE === '1', DRY = env.DRY_RUN === '1';

// the business day before today, Chicago time (Friday on a Monday)
function previousBusinessDay(now) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  do d.setDate(d.getDate() - 1); while (d.getDay() === 0 || d.getDay() === 6);
  return ymd(d);
}

const now = env.TEST_NOW ? new Date(env.TEST_NOW) : chicago();   // TEST_NOW: tests only
const hhmm = now.getHours() + ':' + String(now.getMinutes()).padStart(2, '0');
// GitHub's clock is UTC and can start a run late: report time is 11:00–14:59 Chicago
if (!FORCE && (now.getHours() < 11 || now.getHours() >= 15)) { log(`It is ${hhmm} in Chicago — not report time (11 am). Nothing to do.`); process.exit(0); }
for (const k of ['DASHBOARD_URL', 'AUTOMATION_EMAIL', 'AUTOMATION_PASSWORD']) if (!env[k]) fail(`${k} is not set`);

const browser = await chromium.launch(env.CHROMIUM_PATH ? { executablePath: env.CHROMIUM_PATH } : {});
try {
  const ctx = await browser.newContext({ timezoneId: 'America/Chicago', viewport: { width: 1400, height: 900 } });
  if (env.TEST_INIT) await ctx.addInitScript({ path: env.TEST_INIT });       // tests only
  const page = await ctx.newPage();
  let pageErrors = 0; page.on('pageerror', () => { pageErrors++; });

  log(`${hhmm} Chicago — opening the dashboard…`);
  await page.goto(env.DASHBOARD_URL, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => typeof pgSignIn === 'function' && typeof rpPost === 'function' && typeof labPullAll === 'function', null, { timeout: 60000 });

  const signIn = await page.evaluate(async ({ e, p }) => { try { await pgSignIn(e, p); return 'ok'; } catch (x) { return String(x && x.message || x); } },
                                     { e: env.AUTOMATION_EMAIL, p: env.AUTOMATION_PASSWORD });
  if (signIn !== 'ok') fail('signing in: ' + mask(signIn));
  log('Signed in. Loading the data from Supabase…');

  const loaded = await page.evaluate(async () => { try { return await labPullAll({ diagnose: true }); } catch (x) { return String(x && x.message || x); } });
  if (loaded !== true) fail('loading the data: ' + mask(loaded));
  // APP is a top-level const in the dashboard — not a property of window
  await page.waitForFunction(() => typeof APP !== 'undefined' && APP.raw && APP.raw.length > 0 && !document.getElementById('progressOverlay').classList.contains('show'), null, { timeout: 300000 });
  await page.waitForTimeout(2000);

  const info = await page.evaluate(() => ({ lines: APP.raw.length, latest: isoDate(getMaxDate()), day: isoDate(rpReportDay()) }));
  const expected = previousBusinessDay(now);
  log(`Loaded ${info.lines.toLocaleString()} invoice lines · latest date in the data ${info.latest} · reporting on ${info.day}`);
  if (info.day !== expected) log(`  ⚠ The last complete day in the data is ${info.day}, not ${expected} — the reports will say so in their subject lines.`);
  const thin = await page.evaluate(() => { const x = rpIncompleteCheck(); return x ? { day: Math.round(x.day), typical: Math.round(x.typical) } : null; });
  if (thin) log(`  ⚠ ${info.day} looks incomplete: $${thin.day.toLocaleString()} invoiced vs about $${thin.typical.toLocaleString()} on a typical day — the reports carry a warning. Check the Pilot pull.`);

  // already sent today?
  const prev = await page.evaluate(async () => { const { data, error } = await pgClient().from('reports').select('key,as_of,saved_at,recipients'); return { rows: data || [], error: error && error.message }; });
  if (prev.error) fail('reading the reports table: ' + mask(prev.error));
  const today = ymd(now);
  const sentToday = prev.rows.some(r => r.as_of === info.day && r.saved_at && ymd(chicago(new Date(r.saved_at))) === today
                                      && (chicago(new Date(r.saved_at)).getHours() * 60 + chicago(new Date(r.saved_at)).getMinutes()) >= 10 * 60 + 55);
  if (sentToday && !FORCE) { log(`Reports for ${info.day} were already sent this morning — nothing to do.`); process.exit(0); }

  // recipients: from the last push (per report), else REPORT_RECIPIENTS
  const rcpt = {}; prev.rows.forEach(r => { if (r.recipients) rcpt[r.key] = r.recipients; });
  const fallback = env.REPORT_RECIPIENTS || '';
  if (!Object.keys(rcpt).length && !fallback) fail('no recipients — push the reports once from the dashboard (Reports tab), or set the REPORT_RECIPIENTS secret');
  log(`Recipients: from the last push for ${Object.keys(rcpt).length} report(s)${fallback ? ' (plus a default list)' : ''}.`);

  await page.evaluate(() => switchTab('reports'));
  await page.waitForFunction(() => document.getElementById('rpRcpt') && document.getElementById('rpPush'), null, { timeout: 60000 });
  await page.evaluate(({ rcpt, fallback }) => {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
    set('rpRcpt', fallback);
    ['doctors', 'products', 'status', 'visits', 'employees'].forEach(k => set('rpRcpt_' + k, rcpt[k] || ''));
  }, { rcpt, fallback });

  if (DRY) {
    const subjects = await page.evaluate(async () => (await rpBuildAll()).reports.map(r => r.subject));
    log(`Dry run — built ${subjects.length} reports, sent nothing:`); subjects.forEach(s => log('  • ' + s));
    process.exit(0);
  }

  log(`Building and sending the reports for ${info.day}…`);
  await page.evaluate(() => rpPost('sendNow'));
  await page.waitForFunction(() => { const l = document.getElementById('rpLog'); return l && /✓ Sent|✗/.test(l.textContent); }, null, { timeout: 300000 });
  const out = await page.evaluate(() => document.getElementById('rpLog').textContent);
  if (!/✓ Sent/.test(out)) fail('sending:\n' + mask(out).split('\n').filter(l => /✗|error|fail/i.test(l)).join('\n'));
  const routed = out.split('\n').filter(l => /^\s*•/.test(l)), skipped = routed.filter(l => /no recipient/i.test(l)).length, n = routed.length - skipped;
  log(`✓ Sent ${n} report${n === 1 ? '' : 's'} for ${info.day}${skipped ? ` (${skipped} with no recipients, skipped)` : ''}.${pageErrors ? ` (${pageErrors} page warning${pageErrors === 1 ? '' : 's'} along the way)` : ''}`);
} finally {
  await browser.close();
}
