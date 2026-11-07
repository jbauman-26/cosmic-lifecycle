import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { fetchJson } from './http.js';
import { CliError } from './errors.js';
const REVISION = '2026-10-15';
const Plan = z.object({
    kind: z.literal('klaviyo-segment'),
    name: z.string().min(3),
    reason: z.string(),
    lapsedAfterDays: z.number().int().min(14).max(730),
    metricId: z.string(),
    listId: z.string().optional(),
    checksum: z.string(),
});
const checksum = (p) => createHash('sha256').update(JSON.stringify(p)).digest('hex').slice(0, 16);
// Uses the brand's own repeat timing where there is enough of it: the point
// where most repeat purchases have already happened.
export async function suggestLapsedDays(db) {
    const rows = await db.query(`SELECT months_since, sum(orders) AS orders FROM fact_cohort_monthly WHERE months_since > 0 GROUP BY 1 ORDER BY 1`);
    const total = rows.reduce((s, r) => s + Number(r.orders), 0);
    if (total < 20)
        return { days: 120, basis: `Default of 120 days, because only ${total} repeat orders are stored.` };
    let seen = 0;
    for (const r of rows) {
        seen += Number(r.orders);
        if (seen / total >= 0.75) {
            const days = Math.min(365, Math.max(45, (Number(r.months_since) + 1) * 30));
            return { days, basis: `75% of ${total} repeat orders happen within ${r.months_since} months of the first order.` };
        }
    }
    return { days: 120, basis: 'Default of 120 days.' };
}
export function buildPlan(input) {
    const body = {
        kind: 'klaviyo-segment',
        name: input.name ?? `Win-back: no order in ${input.lapsedAfterDays} days`,
        reason: input.basis,
        lapsedAfterDays: input.lapsedAfterDays,
        metricId: input.metricId,
    };
    return { ...body, checksum: checksum(body) };
}
export function segmentBody(plan) {
    const placed = (operator, value, timeframe) => ({
        type: 'profile-metric', metric_id: plan.metricId,
        measurement: 'count', measurement_filter: { type: 'numeric', operator, value },
        timeframe_filter: timeframe, metric_filters: null,
    });
    // Klaviyo segments cannot reference other segments, so consent stays inline.
    return {
        data: {
            type: 'segment',
            attributes: {
                name: plan.name,
                is_starred: false,
                definition: {
                    condition_groups: [
                        { conditions: [placed('greater-than', 0, { type: 'date', operator: 'alltime' })] },
                        { conditions: [placed('equals', 0, { type: 'date', operator: 'in-the-last', quantity: plan.lapsedAfterDays, unit: 'day' })] },
                        { conditions: [{ type: 'profile-marketing-consent', consent: { channel: 'email', can_receive_marketing: true, consent_status: { subscription: 'subscribed', filters: null } } }] },
                    ],
                },
            },
        },
    };
}
export function writePlan(path, plan) {
    writeFileSync(path, JSON.stringify(plan, null, 2) + '\n');
}
export function readPlan(path) {
    let raw;
    try {
        raw = JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        throw new CliError(`Could not read plan file ${path}.`, 'lifecycle segments propose winback', 'bad_plan');
    }
    const plan = Plan.parse(raw);
    const { checksum: given, ...rest } = plan;
    if (checksum(rest) !== given)
        throw new CliError('This plan was changed after it was written.', 'lifecycle segments propose winback', 'plan_changed');
    return plan;
}
// The only write in the product. It creates a segment and nothing else, and it
// needs both a reviewed plan and an explicit confirm.
export async function applyPlan(plan, key, opts) {
    if (!opts.confirm)
        throw new CliError('Nothing was created. Review the plan, then add --confirm.', 'lifecycle segments apply PLAN_FILE --confirm', 'not_confirmed');
    const body = await fetchJson('https://a.klaviyo.com/api/segments', {
        method: 'POST',
        headers: { Authorization: `Klaviyo-API-Key ${key}`, revision: REVISION, accept: 'application/vnd.api+json', 'content-type': 'application/vnd.api+json' },
        body: JSON.stringify(segmentBody(plan)),
    }, 'Klaviyo segment create', { retries: 2 });
    return { segmentId: body.data?.id, name: plan.name };
}
