// ════════════════════════════════════════════════════════════════════════════
//  Pilot LMS → Supabase: the morning pull
//
//  Runs the two saved Query Studio reports in Pilot (invoices and production)
//  for yesterday plus the days before it, ONE DAY PER REQUEST, and loads them
//  through the SAME database loaders the dashboard uses, in the same order.
//  Re-running is always safe: invoice lines already stored are skipped by
//  fingerprint, and production tasks already stored are updated, not added.
//
//  THIS REPO IS PUBLIC, SO ITS LOGS ARE PUBLIC. This script prints only dates,
//  counts and step names — never a name, an address, a figure or a row.
//
//  Needs (GitHub → Settings → Secrets and variables → Actions):
//    PILOT_API_KEY        a Pilot service-account key (read-only role)
//    AUTOMATION_EMAIL     the Supabase login made for this job
//    AUTOMATION_PASSWORD
//    SUPABASE_URL, SUPABASE_KEY   the publishable values the dashboard uses
//  Optional:
//    INVOICE_REPORT       saved report name in Pilot     (default "JG")
//    PRODUCTION_REPORT    saved report name in Pilot     (default "Per-Employee New")
//    DAYS_BACK            how many days, ending END_DATE (default 3)
//    END_DATE             last day to pull, YYYY-MM-DD   (default yesterday, Chicago time)
//    DRY_RUN=1            fetch and check only — load nothing
//    STATUS_FILE          where to write the counts-only run summary
//    PILOT_API_BASE       default https://api.pilotlms.com/api/v1
//  Node 20+, no dependencies.
// ════════════════════════════════════════════════════════════════════════════
import { writeFileSync } from 'node:fs';

const env = process.env;
const PILOT = (env.PILOT_API_BASE || 'https://api.pilotlms.com/api/v1').replace(/\/+$/, '');
const INVOICE_REPORT = env.INVOICE_REPORT || 'JG';
const PRODUCTION_REPORT = env.PRODUCTION_REPORT || 'Per-Employee New';
const DAYS_BACK = Math.max(1, Math.min(31, parseInt(env.DAYS_BACK || '3', 10) || 3));
const DRY_RUN = /^(1|true|yes)$/i.test(env.DRY_RUN || '');
const CHUNK = 2000;   // rows per staging request — the dashboard's size

// The invoice loader reads exactly these names (salesly_lab_bridge.sql). The
// reports spell some differently ("Remake_Percent"), so columns are matched
// ignoring case and anything the loader doesn't read is left out.
const INVOICE_COLS = ['Case_Number', 'Case_Status', 'Case_Received_Date', 'Days_On_Hold', 'On_Hold_Reason', 'Tooth_Number', 'Shade',
  'Dentist_Last_Name', 'Dentist_First_Name', 'Invoice_Date', 'Quantity', 'Unit_Price', 'phone', 'Net_Cost', 'Product_ID', 'Product_Name',
  'email', 'address', 'Scanner_Source', 'Transaction_Type', 'Remake', 'Product_Remake', 'Remake_Qty', 'Remake_Discount', 'Remake_percent',
  'Remake_Reason', 'Shipped', 'state', 'city', 'dd', 'pracname'];
// The production loader reads these (salesly_production_tasks.sql). "patient"
// is NOT among them: patient names are dropped here, before anything is sent.
const PRODUCTION_COLS = ['employee', 'attribution', 'workstation', 'department', 'scan_in_date', 'started_at', 'resolved_at', 'is_completed',
  'task_id', 'task_name', 'case_number', 'product_name', 'product_type', 'units', 'planned_minutes', 'subtask_id', 'subtask_name',
  'subtask_is_completed'];

const log = (...a) => console.log(...a);
const fail = msg => { throw new Error(msg); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── dates: Chicago calendar days ────────────────────────────────────────────
function chicagoToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}
function daysToPull() {
  const end = /^\d{4}-\d{2}-\d{2}$/.test(env.END_DATE || '') ? env.END_DATE : addDays(chicagoToday(), -1);
  return Array.from({ length: DAYS_BACK }, (_, i) => addDays(end, i - DAYS_BACK + 1));
}
// "2026-10-21", "2026-10-21T00:00:00" or "10/21/2026" → "2026-10-21"
function dayOf(v) {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return '';
}

// ── HTTP with retries (rate limits and brief outages) ───────────────────────
async function http(url, opts, what) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try { res = await fetch(url, opts); }
    catch (e) { if (attempt < 4) { await sleep(2000 * attempt); continue; } fail(`${what}: network error`); }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) { await sleep(3000 * attempt); continue; }
    const text = await res.text();
    let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (!res.ok) {
      // Error bodies can echo data back, so only the status and a code are
      // printed — except our own loaders' fixed messages, which carry no data.
      const msg = String((body && (body.message || body.msg || body.error_description)) || '');
      const KNOWN = [[/Admins only/i, "the job's Supabase login is not an admin — set its role to admin in the reps table"],
                     [/invalid_grant|Invalid login credentials/i, 'AUTOMATION_EMAIL / AUTOMATION_PASSWORD were not accepted'],
                     [/staging is empty|stage is empty/i, 'nothing reached the staging table']];
      const hit = KNOWN.find(([re]) => re.test(msg) || re.test(String(body && body.error || '')));
      const code = body && (body.code || body.error_code || body.error) ? ` (${String(body.code || body.error_code || body.error).slice(0, 40)})` : '';
      fail(`${what}: HTTP ${res.status}${code}${hit ? ' — ' + hit[1] : ''}`);
    }
    return body;
  }
}

// ── Pilot ───────────────────────────────────────────────────────────────────
const pilotHeaders = () => ({ 'X-Api-Key': env.PILOT_API_KEY, Accept: 'application/json' });
async function findReport(name) {
  const body = await http(`${PILOT}/insights?query=${encodeURIComponent(name)}&limit=100`, { headers: pilotHeaders() }, `finding report "${name}"`);
  const list = (body && Array.isArray(body.data)) ? body.data : [];
  const exact = list.filter(x => String(x.name || '').trim().toLowerCase() === name.trim().toLowerCase());
  if (exact.length === 1) return exact[0].id;
  if (!exact.length) fail(`report "${name}" not found in Pilot — check INVOICE_REPORT / PRODUCTION_REPORT and the service account's access`);
  fail(`${exact.length} reports in Pilot are named "${name}" — rename one so the name is unique`);
}
async function runReport(id, name, day) {
  const url = `${PILOT}/insights/${encodeURIComponent(id)}/data?dateFilter=${encodeURIComponent(day + 'rangeTo' + day)}`;
  const body = await http(url, { headers: pilotHeaders() }, `running "${name}" for ${day}`);
  if (!body) fail(`"${name}" for ${day}: empty response`);
  if (body.errorMessage) fail(`"${name}" for ${day}: Pilot could not run the report`);
  const data = body.sqlData || body.behaviorData;
  if (!data || !Array.isArray(data.columns)) fail(`"${name}" is not a table (SQL) report — the job needs the Query Studio table version`);
  // A run returns at most 5,000 rows. One day is normally a few hundred; if a
  // day ever overflows, stop rather than load a silently incomplete day.
  if (data.truncated) fail(`"${name}" for ${day} returned more than 5,000 rows — too many for one request`);
  const cols = data.columns.map(c => String(typeof c === 'object' && c ? (c.name ?? c.label ?? '') : c));
  return (data.rows || []).map(r => Object.fromEntries(cols.map((c, i) => [c, Array.isArray(r) ? r[i] : r[c]])));
}

// keep only the loader's columns, matched ignoring case; values as text
function shape(rows, wanted) {
  if (!rows.length) return { rows: [], missing: [] };
  const byLower = new Map(Object.keys(rows[0]).map(k => [k.trim().toLowerCase(), k]));
  const map = wanted.map(w => [w, byLower.get(w.toLowerCase())]);
  const missing = map.filter(([, src]) => !src).map(([w]) => w);
  return {
    rows: rows.map(r => Object.fromEntries(map.map(([w, src]) => [w, src == null || r[src] == null ? '' : String(r[src])]))),
    missing
  };
}

// ── Supabase (signed in as the job's own login) ─────────────────────────────
let token = null;
async function signIn() {
  const body = await http(`${env.SUPABASE_URL.replace(/\/+$/, '')}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: env.SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.AUTOMATION_EMAIL, password: env.AUTOMATION_PASSWORD })
  }, 'signing in to Supabase');
  if (!body || !body.access_token) fail('signing in to Supabase: no session returned');
  token = body.access_token;
}
async function rpc(name, args) {
  return http(`${env.SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args || {})
  }, `database step ${name}`);
}

// ── main ────────────────────────────────────────────────────────────────────
const status = { ran_at: new Date().toISOString(), ok: false, dry_run: DRY_RUN, days: [], invoices: {}, production: {} };
async function main() {
  const need = ['PILOT_API_KEY', 'AUTOMATION_EMAIL', 'AUTOMATION_PASSWORD', 'SUPABASE_URL', 'SUPABASE_KEY'].filter(k => !env[k]);
  if (need.length) fail('missing secrets: ' + need.join(', '));
  const days = daysToPull(); status.days = days;
  log(`Pilot pull for ${days[0]} → ${days[days.length - 1]} (${days.length} day${days.length === 1 ? '' : 's'})${DRY_RUN ? ' — DRY RUN, nothing will be loaded' : ''}`);

  const invId = await findReport(INVOICE_REPORT), prodId = await findReport(PRODUCTION_REPORT);
  log(`Found both reports in Pilot.`);

  // fetch, one day per request
  const inv = {}, prod = {};
  let invMissing = new Set(), prodMissing = new Set(), patientDropped = false;
  for (const day of days) {
    // every line the report returns is kept: each one comes back in exactly one
    // day's request, whichever date the report filters on
    const si = shape(await runReport(invId, INVOICE_REPORT, day), INVOICE_COLS);
    si.missing.forEach(m => invMissing.add(m)); inv[day] = si.rows;
    const rp = await runReport(prodId, PRODUCTION_REPORT, day);
    if (rp.length && Object.keys(rp[0]).some(k => /patient/i.test(k))) patientDropped = true;
    const sp = shape(rp, PRODUCTION_COLS);   // "patient" isn't a wanted column, so it never leaves this step
    sp.missing.forEach(m => prodMissing.add(m)); prod[day] = sp.rows;
    log(`  ${day}: ${inv[day].length} invoice lines · ${prod[day].length} production rows`);
  }
  if (patientDropped) log('Patient column removed from production rows before loading.');
  // missing optional columns are fine; missing key ones are not
  const invKey = ['Case_Number', 'Invoice_Date', 'Product_Name', 'Net_Cost', 'Dentist_Last_Name', 'pracname'].filter(c => invMissing.has(c));
  const prodKey = ['employee', 'task_id', 'scan_in_date', 'units'].filter(c => prodMissing.has(c));
  if (invKey.length) fail(`the invoice report is missing columns the loader needs: ${invKey.join(', ')}`);
  if (prodKey.length) fail(`the production report is missing columns the loader needs: ${prodKey.join(', ')}`);
  if (invMissing.size) log(`Note: invoice report has no ${[...invMissing].join(', ')} (left blank).`);

  if (DRY_RUN) { status.ok = true; status.invoices.fetched = days.reduce((t, d) => t + inv[d].length, 0);
                 status.production.fetched = days.reduce((t, d) => t + prod[d].length, 0); log('Dry run complete — nothing loaded.'); return; }

  await signIn();
  log('Signed in to Supabase.');

  // ── invoices: group the lines by their OWN invoice date and send only the
  //    days whose count differs from the database, exactly as the dashboard
  //    does; fingerprints discard any true repeats
  const dbDays = (await rpc('lab_day_counts')) || {};
  const byDay = {};
  days.forEach(d => inv[d].forEach(r => { const k = dayOf(r.Invoice_Date) || '(no date)'; (byDay[k] = byDay[k] || []).push(r); }));
  const send = [], sentDays = [], completeDays = [];
  for (const k of Object.keys(byDay).sort()) {
    const n = byDay[k].length, inDb = Number(dbDays[k] || 0);
    if (k !== '(no date)' && n === inDb) { completeDays.push(k); continue; }
    sentDays.push(k); send.push(...byDay[k]);
  }
  status.invoices = { fetched: days.reduce((t, d) => t + inv[d].length, 0), days_sent: sentDays.length, days_already_complete: completeDays.length, loaded: 0 };
  if (send.length) {
    await rpc('lab_stage_reset');
    for (let i = 0; i < send.length; i += CHUNK) await rpc('lab_stage_rows', { p_rows: send.slice(i, i + CHUNK) });
    let batch = null, loaded = 0;
    for (let guard = 0; guard < 200; guard++) {
      const ch = await rpc('lab_load_chunk', { p_batch: batch, p_source: `pilot-auto ${days[0]}..${days[days.length - 1]}`, p_limit: 20000 });
      batch = ch.batch_id; loaded += Number(ch.loaded || 0);
      if (ch.done) break;
    }
    status.invoices.loaded = loaded;
    log(`Invoices: ${send.length} lines sent for ${sentDays.length} day(s); ${loaded} new loaded (the rest were already stored).`);
  } else {
    log(`Invoices: nothing to send — ${completeDays.length} day(s) already complete in the database.`);
  }

  // ── production: always send; the loader updates tasks it already has
  const prows = days.flatMap(d => prod[d]);
  status.production = { fetched: prows.length, loaded: null };
  if (prows.length) {
    await rpc('ptask_stage_reset');
    for (let i = 0; i < prows.length; i += CHUNK) await rpc('ptask_stage_rows', { p_rows: prows.slice(i, i + CHUNK) });
    const res = await rpc('ptask_load', { p_source: `pilot-auto ${days[0]}..${days[days.length - 1]}` });
    const n = res && (res.rows ?? res.loaded ?? res.rows_loaded ?? res.touched);
    status.production.loaded = n ?? null;
    log(`Production: ${prows.length} rows sent; ${n ?? 'all'} task rows added or updated.`);
  } else {
    log('Production: no rows for these days.');
  }
  status.ok = true;
  log('Done.');
}

main().catch(e => {
  status.ok = false; status.error = String(e && e.message || e).slice(0, 200);
  console.error('FAILED: ' + status.error);
  process.exitCode = 1;
}).finally(() => {
  if (env.STATUS_FILE) { try { writeFileSync(env.STATUS_FILE, JSON.stringify(status, null, 2) + '\n'); } catch {} }
});
