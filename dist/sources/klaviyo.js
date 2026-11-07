import { fetchJson, HttpError } from '../http.js';
// Verified on 2026-11-06 against a real flow send: the daily series request and
// response parse as written here. Revenue attribution has not yet been seen on
// a real conversion, and that limit is stated in the README.
export const reportsVerified = true;
const REVISION = '2026-10-15';
const BASE = 'https://a.klaviyo.com/api';
const STATS = ['recipients', 'opens_unique', 'clicks_unique', 'conversion_uniques', 'conversion_value', 'unsubscribes', 'spam_complaints', 'bounced'];
export class Klaviyo {
    wait;
    headers;
    constructor(key, wait) {
        this.wait = wait;
        this.headers = { Authorization: `Klaviyo-API-Key ${key}`, revision: REVISION, accept: 'application/vnd.api+json', 'content-type': 'application/vnd.api+json' };
    }
    async pages(path, label) {
        const out = [];
        let url = `${BASE}/${path}`;
        while (url) {
            const body = await fetchJson(url, { headers: this.headers }, label, { wait: this.wait });
            out.push(...(body.data ?? []));
            url = body.links?.next ?? null;
        }
        return out;
    }
    async account() {
        const body = await fetchJson(`${BASE}/accounts`, { headers: this.headers }, 'Klaviyo account check', { wait: this.wait });
        const a = body.data?.[0];
        return { id: a?.id, name: a?.attributes?.contact_information?.organization_name };
    }
    async flows() {
        return (await this.pages('flows', 'Klaviyo flows')).map((f) => ({
            flowId: f.id, name: f.attributes.name, status: f.attributes.status, triggerType: f.attributes.trigger_type ?? null,
            archived: Boolean(f.attributes.archived), createdAt: f.attributes.created ?? null, updatedAt: f.attributes.updated ?? null,
        }));
    }
    async campaigns() {
        return (await this.pages('campaigns', 'Klaviyo campaigns')).map((c) => ({
            campaignId: c.id, name: c.attributes.name, status: c.attributes.status, sendTime: c.attributes.send_time ?? null, archived: Boolean(c.attributes.archived),
        }));
    }
    async segments() {
        return (await this.pages('segments', 'Klaviyo segments')).map((s) => ({
            segmentId: s.id, name: s.attributes.name, isActive: Boolean(s.attributes.is_active), createdAt: s.attributes.created ?? null,
        }));
    }
    async placedOrderMetricId() {
        if (process.env.LIFECYCLE_KLAVIYO_ORDER_METRIC)
            return process.env.LIFECYCLE_KLAVIYO_ORDER_METRIC;
        const metrics = await this.pages('metrics', 'Klaviyo metrics');
        const shopify = metrics.find((m) => m.attributes?.name === 'Placed Order' && m.attributes?.integration?.name === 'Shopify');
        return (shopify ?? metrics.find((m) => m.attributes?.name === 'Placed Order'))?.id ?? null;
    }
    // One daily series grouped by flow message stays well inside the limit of
    // 2 calls a minute and 225 a day.
    // Klaviyo refuses a daily report longer than 60 days, so longer windows are
    // split, with a pause that respects the limit of 2 report calls a minute.
    async flowSeries(metricId, start, end) {
        const rows = [];
        const windows = dailyWindows(start, end);
        for (const [i, w] of windows.entries()) {
            if (i > 0)
                await (this.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(31000);
            rows.push(...(await this.flowSeriesWindow(metricId, w.start, w.end)));
        }
        return rows;
    }
    async flowSeriesWindow(metricId, start, end) {
        const body = await fetchJson(`${BASE}/flow-series-reports`, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify({
                data: {
                    type: 'flow-series-report',
                    attributes: { statistics: STATS, timeframe: { start, end }, interval: 'daily', conversion_metric_id: metricId, group_by: ['flow_id', 'flow_message_id', 'send_channel'] },
                },
            }),
        }, 'Klaviyo flow report', { wait: this.wait });
        return parseFlowSeries(body);
    }
    // Klaviyo's own total for each flow, used to prove the daily rows add up.
    async flowTotals(metricId, start, end) {
        const body = await fetchJson(`${BASE}/flow-values-reports`, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify({
                data: {
                    type: 'flow-values-report',
                    attributes: { statistics: ['recipients', 'conversion_value'], timeframe: { start, end }, conversion_metric_id: metricId, group_by: ['flow_id', 'flow_message_id', 'send_channel'] },
                },
            }),
        }, 'Klaviyo flow totals', { wait: this.wait });
        return parseFlowValues(body);
    }
    async placedOrdersDaily(metricId, start, end) {
        const body = await fetchJson(`${BASE}/metric-aggregates`, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify({
                data: {
                    type: 'metric-aggregate',
                    attributes: {
                        metric_id: metricId, measurements: ['count', 'sum_value'], interval: 'day', timezone: 'UTC',
                        filter: [`greater-or-equal(datetime,${start})`, `less-than(datetime,${end})`],
                    },
                },
            }),
        }, 'Klaviyo placed orders', { wait: this.wait });
        return parseMetricAggregate(body);
    }
}
const DAY = 86400000;
export function dailyWindows(start, end, maxDays = 60) {
    const out = [];
    const stop = new Date(end).getTime();
    for (let t = new Date(start).getTime(); t < stop; t += maxDays * DAY) {
        out.push({ start: new Date(t).toISOString(), end: new Date(Math.min(t + maxDays * DAY, stop)).toISOString() });
    }
    return out;
}
export function parseMetricAggregate(body) {
    const attrs = body?.data?.attributes;
    const dates = attrs?.dates ?? [];
    const m = attrs?.data?.[0]?.measurements ?? {};
    return dates
        .map((d, i) => ({ date: d.slice(0, 10), orders: Number(m.count?.[i] ?? 0), value: Number(m.sum_value?.[i] ?? 0) }))
        .filter((r) => r.orders || r.value);
}
export function parseFlowValues(body) {
    // Klaviyo requires grouping by message, so totals are summed back to the flow.
    const totals = new Map();
    for (const r of body?.data?.attributes?.results ?? []) {
        const flowId = r.groupings?.flow_id;
        const t = totals.get(flowId) ?? { flowId, recipients: 0, revenue: 0 };
        t.recipients += Number(r.statistics?.recipients ?? 0);
        t.revenue += Number(r.statistics?.conversion_value ?? 0);
        totals.set(flowId, t);
    }
    return [...totals.values()];
}
export function parseFlowSeries(body) {
    const attrs = body?.data?.attributes;
    const dates = attrs?.date_times ?? [];
    const rows = [];
    for (const r of attrs?.results ?? []) {
        const s = r.statistics ?? {};
        const at = (name, i) => Number(s[name]?.[i] ?? 0);
        dates.forEach((d, i) => {
            const row = {
                flowId: r.groupings?.flow_id, flowMessageId: r.groupings?.flow_message_id, channel: r.groupings?.send_channel, date: d.slice(0, 10),
                recipients: at('recipients', i), opensUnique: at('opens_unique', i), clicksUnique: at('clicks_unique', i), conversions: at('conversion_uniques', i),
                revenue: at('conversion_value', i), unsubscribes: at('unsubscribes', i), spamComplaints: at('spam_complaints', i), bounces: at('bounced', i),
            };
            // Skip empty days so a quiet flow does not fill the table with zeros.
            if (row.recipients || row.opensUnique || row.clicksUnique || row.conversions || row.revenue)
                rows.push(row);
        });
    }
    return rows;
}
// A 400 on an account with no sends is expected, and should not fail the sync.
export const isNoReportData = (e) => e instanceof HttpError && e.status === 400 && /does not support querying/i.test(e.body);
