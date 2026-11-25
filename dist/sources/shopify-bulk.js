import { fetchJson, HttpError } from '../http.js';
import { CliError } from '../errors.js';
import { shopifyQueryError, scopeDenied, SHOPIFY_VERSION } from './shopify.js';
// A store with years of orders is too big to page through: 3 million orders is 12,000 requests of 250, one
// after another, and the whole list in memory. A bulk operation asks Shopify to build the export on its side
// and hand back one file, with no rate limit cost per order. It can take minutes, so the operation id is saved
// and a later sync picks it up where this one stopped.
// Docs: https://shopify.dev/docs/api/usage/bulk-operations/queries (2026-01 and later poll with bulkOperation(id:)).
// The same fields as the paged query, and no personal field. The order id and customer id are hashed with the store's key before they are stored. customer { id } is an object, not a connection,
// so every line of the file is one order and there is no __parentId to follow.
export const BULK_ORDERS_QUERY = `{
  orders {
    edges {
      node {
        id
        createdAt
        updatedAt
        processedAt
        cancelledAt
        customer { id }
        currentTotalPriceSet { shopMoney { amount } }
        totalDiscountsSet { shopMoney { amount } }
      }
    }
  }
}`;
const RUN = `mutation($q: String!) {
  bulkOperationRunQuery(query: $q) {
    bulkOperation { id status }
    userErrors { field message code }
  }
}`;
const POLL = `query($id: ID!) {
  bulkOperation(id: $id) { id status errorCode objectCount url partialDataUrl createdAt completedAt }
}`;
// One GraphQL call with the store's token. The token only ever goes to the store's own admin address.
export function shopifyGql(store, token) {
    return async (query, variables) => {
        const body = await fetchJson(`https://${store}/admin/api/${SHOPIFY_VERSION}/graphql.json`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-shopify-access-token': token }, body: JSON.stringify({ query, variables }) }, 'Shopify bulk export request').catch((e) => {
            if (e instanceof HttpError && e.status === 403)
                throw scopeDenied(e.body);
            throw e;
        });
        if (body.errors)
            throw shopifyQueryError(body.errors);
        return body.data;
    };
}
export async function startOrdersExport(gql) {
    const data = await gql(RUN, { q: BULK_ORDERS_QUERY });
    const r = data?.bulkOperationRunQuery;
    const errors = r?.userErrors ?? [];
    if (errors.length || !r?.bulkOperation?.id) {
        const text = errors.map((e) => e.message ?? '').join(' ');
        if (/in progress|already/i.test(text)) {
            throw new CliError('Shopify is already running an export for this app.', 'Wait for it to finish, then run lifecycle sync again.', 'export_busy');
        }
        if (/access|scope|denied/i.test(text))
            throw scopeDenied(text);
        throw new CliError('Shopify would not start the order export.', 'lifecycle doctor', 'shopify_query');
    }
    return { id: r.bulkOperation.id, status: r.bulkOperation.status, errorCode: null, objectCount: 0, url: null, partialDataUrl: null, createdAt: null };
}
export async function pollExport(gql, id) {
    const data = await gql(POLL, { id });
    const op = data?.bulkOperation;
    if (!op)
        return null;
    return { id: op.id, status: op.status, errorCode: op.errorCode ?? null, objectCount: Number(op.objectCount ?? 0), url: op.url ?? null, partialDataUrl: op.partialDataUrl ?? null, createdAt: op.createdAt ?? null };
}
export const isDone = (s) => s === 'COMPLETED' || s === 'FAILED' || s === 'CANCELED' || s === 'EXPIRED';
// Polls until the export finishes or the time budget runs out, whichever comes first. Returns the last state seen.
export async function waitForExport(gql, id, budgetMs, opts = {}) {
    const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const now = opts.now ?? Date.now;
    const end = now() + budgetMs;
    let wait = 2000;
    for (;;) {
        const op = await pollExport(gql, id);
        if (!op || isDone(op.status) || now() + wait > end)
            return op;
        await sleep(wait);
        wait = Math.min(wait * 2, 30000);
    }
}
// ---- The export file, read as a stream into a compact buffer ----
// Each order becomes a few numbers, not an object: 3 million orders take about 80 MB here instead of about 1 GB
// as parsed objects. Customer ids are turned into small integers in memory and never leave this process.
// Cancelled orders are counted as pulled and then dropped, as aggregateOrders drops them.
export class CompactOrders {
    cutoff;
    state;
    pulled = 0;
    // Orders created at or before the cutoff, so they can be checked against Shopify's count for the same moment.
    pulledBefore = 0;
    size = 0;
    time = new Float64Array(1024);
    day = new Int32Array(1024);
    cust = new Int32Array(1024);
    net = new Float64Array(1024);
    disc = new Float64Array(1024);
    days = [];
    dayIndex = new Map();
    customers = new Map();
    earliest = null;
    // With a state buffer, every order (cancelled ones too) is also kept there under keyed hashes, for an incremental sync.
    constructor(cutoff = Infinity, state) {
        this.cutoff = cutoff;
        this.state = state;
    }
    grow() {
        const n = this.time.length * 2;
        const copy = (a, b) => (b.set(a), b);
        this.time = copy(this.time, new Float64Array(n));
        this.day = copy(this.day, new Int32Array(n));
        this.cust = copy(this.cust, new Int32Array(n));
        this.net = copy(this.net, new Float64Array(n));
        this.disc = copy(this.disc, new Float64Array(n));
    }
    add(o) {
        this.pulled++;
        this.state?.add(o);
        if (o.createdAt && Date.parse(o.createdAt) <= this.cutoff)
            this.pulledBefore++;
        if (o.cancelledAt)
            return;
        if (this.size === this.time.length)
            this.grow();
        const i = this.size++;
        const date = o.processedAt.slice(0, 10);
        if (this.earliest === null || date < this.earliest)
            this.earliest = date;
        let d = this.dayIndex.get(date);
        if (d === undefined) {
            d = this.days.length;
            this.days.push(date);
            this.dayIndex.set(date, d);
        }
        let c = -1;
        if (o.customer) {
            c = this.customers.get(o.customer.id) ?? -1;
            if (c === -1) {
                c = this.customers.size;
                this.customers.set(o.customer.id, c);
            }
        }
        this.time[i] = Date.parse(o.processedAt);
        this.day[i] = d;
        this.cust[i] = c;
        this.net[i] = Number(o.currentTotalPriceSet.shopMoney.amount);
        this.disc[i] = Number(o.totalDiscountsSet.shopMoney.amount);
    }
    // The same rules as aggregateOrders, in the same order of additions, so the totals match it to the cent.
    aggregate() {
        const order = new Uint32Array(this.size);
        for (let i = 0; i < this.size; i++)
            order[i] = i;
        const t = this.time;
        order.sort((a, b) => t[a] - t[b] || a - b);
        const firstMonth = new Int32Array(this.customers.size).fill(-1);
        const monthOf = (d) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1;
        const label = (m) => `${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}`;
        const money = (n) => Math.round(n * 100) / 100;
        const daily = new Map();
        const cohorts = new Map();
        for (const i of order) {
            const date = this.days[this.day[i]];
            const net = this.net[i];
            const discounts = this.disc[i];
            const c = this.cust[i];
            const isNew = c >= 0 && firstMonth[c] === -1;
            if (isNew)
                firstMonth[c] = monthOf(date);
            const d = daily.get(date) ?? { date, orders: 0, gross: 0, net: 0, discounts: 0, newOrders: 0, returningOrders: 0, guestOrders: 0 };
            d.orders++;
            d.net = money(d.net + net);
            d.gross = money(d.gross + net + discounts);
            d.discounts = money(d.discounts + discounts);
            if (isNew)
                d.newOrders++;
            else if (c >= 0)
                d.returningOrders++;
            else
                d.guestOrders++;
            daily.set(date, d);
            if (c >= 0) {
                const cm = firstMonth[c];
                const id = `${label(cm)}|${monthOf(date) - cm}`;
                const k = cohorts.get(id) ?? { customers: new Set(), orders: 0, revenue: 0 };
                k.customers.add(c);
                k.orders++;
                k.revenue = money(k.revenue + net);
                cohorts.set(id, k);
            }
        }
        return {
            daily: [...daily.values()],
            cohorts: [...cohorts].map(([id, k]) => {
                const [cohortMonth, months] = id.split('|');
                return { cohortMonth, monthsSince: Number(months), customers: k.customers.size, orders: k.orders, revenue: k.revenue };
            }),
        };
    }
}
// Reads the JSONL file line by line. The file is on Shopify's storage host behind a signed address, so no token
// is sent with it. A cut-off download throws, and the saved operation lets the next sync read the same file again.
export async function readExport(url, into, fetchImpl = fetch) {
    const res = await fetchImpl(url);
    if (!res.ok || !res.body) {
        // A signed address lasts a week. After that the file is gone and a new export is needed.
        const code = res.status === 403 || res.status === 404 || res.status === 410 ? 'export_expired' : 'export_download';
        throw new CliError(`Downloading the Shopify export failed with status ${res.status}.`, 'Run lifecycle sync again.', code);
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let rest = '';
    for (;;) {
        const { value, done } = await reader.read();
        if (done)
            break;
        rest += value;
        let nl = rest.indexOf('\n');
        let start = 0;
        while (nl !== -1) {
            const line = rest.slice(start, nl);
            if (line.trim())
                into.add(JSON.parse(line));
            start = nl + 1;
            nl = rest.indexOf('\n', start);
        }
        rest = rest.slice(start);
    }
    if (rest.trim())
        into.add(JSON.parse(rest));
    return into;
}
