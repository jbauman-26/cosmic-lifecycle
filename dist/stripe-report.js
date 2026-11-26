import { monthTotals } from './sources/stripe.js';
// 0.20.1: reads Stripe's own report for the last finished months and keeps its totals, so `cosmic verdict` can hold
// Stripe charge KPIs against a count Stripe made itself (its balance ledger), not against the charges list the sync
// reads. The report is asked for once per sync; Stripe prepares it in the background, and a run that is not ready
// is picked up by the next sync.
export const REPORT_MONTHS = 3;
export const NO_PERMISSION = 'This key cannot run Stripe\'s reports, so Stripe charge KPIs stay unchecked. Add the read permission "Report runs and report types" to the restricted key. It is a read permission; nothing else changes.';
export const TEST_MODE = 'Stripe runs its own reports only for live keys, so the check against Stripe\'s own report is skipped for this test key.';
const monthStart = (y, m) => Date.UTC(y, m, 1) / 1000;
/** The last finished months, oldest first, as [YYYY-MM, start, end) in epoch seconds. */
export function finishedMonths(now, n = REPORT_MONTHS) {
    const d = new Date(now);
    return Array.from({ length: n }, (_, i) => {
        const k = n - i;
        const start = monthStart(d.getUTCFullYear(), d.getUTCMonth() - k);
        const end = monthStart(d.getUTCFullYear(), d.getUTCMonth() - k + 1);
        return { month: new Date(start * 1000).toISOString().slice(0, 7), start, end };
    });
}
export async function syncStripeReport(db, s, opts = {}) {
    if (s.mode === 'test')
        return { status: 'unavailable', detail: TEST_MODE };
    const avail = await s.activityAvailability();
    if (avail === null)
        return { status: 'unavailable', detail: NO_PERMISSION };
    const now = opts.now ?? Date.now();
    // Stripe accepts an interval inside its data range: after data_available_start, and ending at least a second
    // before data_available_end. A month that starts before Stripe's data does is left out rather than half read.
    const end = avail.end - 1;
    const months = finishedMonths(now).filter((m) => m.end <= end && m.start >= avail.start);
    if (!months.length)
        return { status: 'pending', detail: `Stripe's own report has data only to ${new Date(avail.end * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC, so last month is not in it yet.` };
    const names = months.map((m) => m.month);
    // Read once a day at most: a stored report for every month, taken within a day of Stripe's latest data, is enough.
    const stored = await db.query(`SELECT month, max(through_at) AS through FROM meta_stripe_report_month WHERE month = ANY($1) AND currency = '*' GROUP BY month`, [names]);
    if (stored.length === names.length && stored.every((r) => Date.parse(String(new Date(r.through).toISOString())) / 1000 >= end - 86400)) {
        return { status: 'ok', detail: `Stripe's own report for ${names.join(', ')} is already read.`, months: names };
    }
    const start = months[0].start;
    const pending = (await db.query(`SELECT run_id, interval_start, interval_end, started_at FROM meta_stripe_report_run ORDER BY started_at DESC LIMIT 1`))[0];
    // A stored run older than a day, or for other months, is dropped and asked for again.
    const resumed = Boolean(pending && Number(pending.interval_start) === start && now - Date.parse(new Date(pending.started_at).toISOString()) < 86400000);
    const through = new Date((resumed ? Number(pending.interval_end) : end) * 1000).toISOString();
    const drop = () => db.query(`DELETE FROM meta_stripe_report_run`);
    try {
        let run;
        if (resumed)
            run = await s.reportRun(String(pending.run_id));
        else {
            await drop();
            run = await s.startActivityRun(start, end);
            if (!run)
                return { status: 'unavailable', detail: NO_PERMISSION };
            await db.query(`INSERT INTO meta_stripe_report_run VALUES ($1, $2, $3, now())`, [run.id, start, end]);
        }
        const wait = opts.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
        const until = Date.now() + (opts.maxWaitMs ?? 20000);
        while (run.status === 'pending' && Date.now() < until) {
            await wait(opts.pollMs ?? 3000);
            run = await s.reportRun(run.id);
        }
        if (run.status === 'failed') {
            await drop();
            return { status: 'pending', detail: 'Stripe could not prepare its own report this time; the next sync asks again.' };
        }
        if (run.status !== 'succeeded' || !run.url)
            return { status: 'pending', detail: 'Stripe is still preparing its own report; the next sync reads it.' };
        const totals = monthTotals(await s.reportRows(run.url));
        const unplaced = totals.filter((t) => t.month === '?').reduce((n, t) => n + t.unplaced, 0);
        await db.transaction(async (tx) => {
            await tx.query(`DELETE FROM meta_stripe_report_month WHERE month = ANY($1)`, [names]);
            for (const t of totals.filter((x) => names.includes(x.month))) {
                await tx.query(`INSERT INTO meta_stripe_report_month (month, currency, charges, gross, refunds, through_at, fetched_at, unplaced) VALUES ($1, $2, $3, $4, $5, $6, now(), 0)`, [t.month, t.currency, t.charges, t.gross, t.refunds, through]);
            }
            // A month Stripe has no charges for is still a month its report covered: a marker row says so, and carries
            // any rows the report could not place in a month.
            for (const m of names)
                await tx.query(`INSERT INTO meta_stripe_report_month (month, currency, charges, gross, refunds, through_at, fetched_at, unplaced) VALUES ($1, '*', 0, 0, 0, $2, now(), $3) ON CONFLICT DO NOTHING`, [m, through, unplaced]);
            await tx.query(`DELETE FROM meta_stripe_report_run`);
        });
        return { status: 'ok', detail: `Read Stripe's own report for ${names.join(', ')}.`, months: names };
    }
    catch (e) {
        // A run that cannot be read is dropped, so the next sync starts a fresh one instead of retrying it forever.
        await drop();
        throw e;
    }
}
/**
 * The month's Stripe totals in this database against Stripe's own report: charge count and gross exactly, and net
 * (gross minus refunds against those charges) exactly when the report reaches the last sync.
 */
export async function stripeReportCheck(db, month, start, end) {
    const report = await db.query(`SELECT currency, charges, gross, refunds, through_at, unplaced FROM meta_stripe_report_month WHERE month = $1`, [month]);
    if (!report.length)
        return { status: 'skipped', detail: `Stripe's own report for ${month} has not been read yet. It needs a live key with the read permission "Report runs and report types", and a sync after the month ends.`, expected: null, actual: null, netChecked: false };
    const mine = await db.query(`SELECT currency, sum(charges) AS charges, sum(gross) AS gross, sum(net) AS net FROM fact_stripe_daily WHERE date >= $1 AND date < $2 GROUP BY currency`, [start, end]);
    const cents = (v) => Math.round(Number(v ?? 0) * 100);
    const through = new Date(report.find((r) => r.through_at).through_at).toISOString();
    const unplaced = report.reduce((n, r) => n + Number(r.unplaced ?? 0), 0);
    if (unplaced)
        return { status: 'fail', detail: `Stripe's own report has ${unplaced} charge or refund row${unplaced === 1 ? '' : 's'} with no charge date, so ${month} cannot be matched.`, expected: null, actual: null, netChecked: false };
    const currencies = [...new Set([...report.map((r) => String(r.currency)), ...mine.map((r) => String(r.currency))])].filter((c) => c !== '*');
    let netChecked = true;
    for (const c of currencies) {
        const r = report.find((x) => x.currency === c);
        const m = mine.find((x) => x.currency === c);
        const theirs = { charges: Number(r?.charges ?? 0), gross: cents(r?.gross), net: cents(r?.gross) + cents(r?.refunds) };
        const ours = { charges: Number(m?.charges ?? 0), gross: cents(m?.gross), net: cents(m?.net) };
        if (theirs.charges !== ours.charges) {
            const gap = Math.abs(theirs.charges - ours.charges);
            return { status: 'fail', detail: `${gap} charge${gap === 1 ? '' : 's'} ${ours.charges < theirs.charges ? 'missing' : 'extra'}: ${ours.charges} against ${theirs.charges} in Stripe's own report for ${month} (${c.toUpperCase()}).`, expected: theirs.charges, actual: ours.charges, netChecked: false };
        }
        if (theirs.gross !== ours.gross)
            return { status: 'fail', detail: `Gross ${c.toUpperCase()} ${(ours.gross / 100).toFixed(2)} against ${(theirs.gross / 100).toFixed(2)} in Stripe's own report for ${month}.`, expected: theirs.gross / 100, actual: ours.gross / 100, netChecked: false };
        if (theirs.net !== ours.net) {
            // Our net is as of the last sync; Stripe's report holds refunds only to its own end, which is always earlier.
            // Lower here can be refunds made in between, so net waits for a later report. Higher here cannot be timing.
            if (ours.net < theirs.net)
                netChecked = false;
            else
                return { status: 'fail', detail: `Net ${c.toUpperCase()} ${(ours.net / 100).toFixed(2)} against ${(theirs.net / 100).toFixed(2)} in Stripe's own report for ${month} (gross minus refunds against those charges).`, expected: theirs.net / 100, actual: ours.net / 100, netChecked: false };
        }
    }
    const total = currencies.reduce((n, c) => n + Number(report.find((x) => x.currency === c)?.charges ?? 0), 0);
    return { status: 'pass', detail: `${total} charge${total === 1 ? '' : 's'} and gross match Stripe's own report for ${month}${netChecked ? ', and so does net after refunds' : `; net is not compared yet, because refunds after ${through.slice(0, 16).replace('T', ' ')} UTC are not in the report`}.`, expected: total, actual: total, netChecked };
}
