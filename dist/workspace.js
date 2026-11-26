import { readRawConfig } from './config.js';
import { CliError } from './errors.js';
// A workspace is one business this CLI keeps numbers for: a Shopify store, a SaaS product,
// a B2B pipeline, one agency client, a creator business. Its type decides three things:
//
//   1. the reference source: the one system whose count the trust gate checks the others against
//   2. the metric pack: which verified metrics `metrics list` shows first
//   3. the wording in setup, checklists and demos
//
// An install made before 0.14.0 has no type in its config and reads as `shopify`, so it behaves
// exactly as it did. See docs/WORKSPACES.md for why each type has the reference it has.
export const WORKSPACE_TYPES = ['shopify', 'ecommerce', 'saas', 'b2b', 'agency', 'creator'];
// The sources a trust gate can check against. ga4 is a tracking tool, not a ledger, so a workspace
// that has nothing better gets checks against it with a line that says so. none means no checks
// against anything: the numbers carry a line saying each is its own tool's count.
export const REFERENCES = ['shopify', 'stripe', 'hubspot', 'ga4', 'none'];
export const TYPES = {
    shopify: {
        type: 'shopify', title: 'Shopify store', forWhom: 'A brand selling through a Shopify store.',
        reference: 'shopify', referenceWhy: 'Shopify orders are the record of what sold. Klaviyo, GA4 and Meta are checked against them.',
        sources: ['shopify', 'klaviyo', 'ga4', 'meta', 'stripe'],
    },
    ecommerce: {
        type: 'ecommerce', title: 'Other ecommerce', forWhom: 'A store on WooCommerce, BigCommerce or a Stripe checkout, with no Shopify.',
        reference: 'stripe', referenceWhy: 'Stripe charges are the record of what was paid. GA4 purchases and Meta\'s claimed purchases are checked against them. A store that takes payment outside Stripe has no ledger here yet: set workspace.reference to ga4 or none.',
        sources: ['stripe', 'ga4', 'meta', 'woocommerce', 'klaviyo'],
    },
    saas: {
        type: 'saas', title: 'SaaS or subscription', forWhom: 'A software or membership business that bills through Stripe.',
        reference: 'stripe', referenceWhy: 'Stripe holds the subscriptions and charges, so MRR, churn and new paying customers come from it, and ad platform claims are checked against it.',
        sources: ['stripe', 'ga4', 'meta', 'hubspot', 'posthog'],
    },
    b2b: {
        type: 'b2b', title: 'B2B or lead generation', forWhom: 'A team whose revenue runs through a CRM pipeline: leads, deals, closed won.',
        reference: 'hubspot', referenceWhy: 'The CRM holds the leads and deals. Its own counts are checked against what was pulled, and every pipeline number comes from it.',
        sources: ['hubspot', 'ga4', 'meta', 'pipedrive', 'stripe'],
    },
    agency: {
        type: 'agency', title: 'Agency client', forWhom: 'An agency keeping one workspace per client, each with that client\'s own source of truth.',
        reference: 'none', referenceWhy: 'Every client keeps its truth somewhere different. Set it per client with cosmic config set workspace.reference stripe, hubspot, shopify or ga4. Until then numbers carry a line saying they are unchecked.',
        sources: ['ga4', 'meta', 'stripe', 'hubspot', 'shopify'],
    },
    creator: {
        type: 'creator', title: 'Creator or media', forWhom: 'A creator, newsletter or media business selling memberships, products or sponsorships.',
        reference: 'stripe', referenceWhy: 'Stripe holds memberships and product sales when they run through it. Sponsorship and ad income usually live in a spreadsheet: bring it in with cosmic sources import.',
        sources: ['stripe', 'ga4', 'meta', 'mailchimp', 'klaviyo'],
    },
};
export const REFERENCE_NAME = { shopify: 'Shopify orders', stripe: 'Stripe', hubspot: 'HubSpot', ga4: 'GA4', none: 'nothing' };
export const isWorkspaceType = (v) => WORKSPACE_TYPES.includes(v);
export const isReference = (v) => REFERENCES.includes(v);
export function assertType(v) {
    const t = v.trim().toLowerCase();
    if (!isWorkspaceType(t))
        throw new CliError(`Unknown workspace type ${v}.`, `Use one of ${WORKSPACE_TYPES.join(', ')}. See cosmic docs workspaces`, 'bad_type');
    return t;
}
export function assertReference(v) {
    const r = v.trim().toLowerCase();
    if (!isReference(r))
        throw new CliError(`Unknown reference source ${v}.`, `Use one of ${REFERENCES.join(', ')}.`, 'bad_value');
    return r;
}
// Never throws: a missing or unreadable config is a Shopify workspace, which is what every
// install before 0.14.0 was.
export function readWorkspace(raw) {
    let config = {};
    try {
        config = raw ?? readRawConfig();
    }
    catch {
        config = {};
    }
    const t = String(config?.workspace?.type ?? 'shopify');
    const type = isWorkspaceType(t) ? t : 'shopify';
    const r = String(config?.workspace?.reference ?? '');
    const referenceSet = isReference(r);
    return { type, reference: referenceSet ? r : TYPES[type].reference, referenceSet, title: TYPES[type].title };
}
// "store" for a Shopify workspace, "workspace" for everything else. Used in sentences that
// read better with the right word, never in a JSON key.
export const noun = (w = readWorkspace()) => (w.type === 'shopify' ? 'store' : 'workspace');
