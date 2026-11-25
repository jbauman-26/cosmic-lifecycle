"""Builds src/warehouse-catalog.ts from the tool research and the connector specs.

  connectors/research-2026-11-07.json   100 tools Shopify stores use, with evidence
  EXTRA (below)                         tools added later, outside that research
  connectors/specs/<slug>.json          a dlt rest_api spec, validated, per built connector

Run: python3 scripts/gen-warehouse-catalog.py
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
research = json.loads((ROOT / "connectors/research-2026-11-07.json").read_text())
specs = {p.stem: json.loads(p.read_text()) for p in sorted((ROOT / "connectors/specs").glob("*.json"))}

# Built into the CLI already, with reconcile checks.
NATIVE = {"klaviyo", "google-analytics-4", "stripe", "meta-ads-facebook-and-instagram", "google-ads", "tiktok-ads", "pinterest-ads"}
SHORT = {
    "meta-ads-facebook-and-instagram": "meta-ads",
    "amazon-seller-central-sp-api": "amazon-seller-central",
    "afterpay-cash-app-afterpay": "afterpay",
    "microsoft-advertising-bing-ads": "microsoft-ads",
    "boost-ai-search-filter": "boost-search",
    "zipify-one-click-upsell": "zipify-ocu",
    "avalara-avatax": "avalara",
    "awin-shareasale": "awin",
    "impact-com": "impact",
}
CATEGORY = {
    "email/SMS": "email-sms", "ads platforms": "ads", "analytics/attribution": "analytics",
    "reviews": "reviews", "subscriptions": "subscriptions", "helpdesk/support": "helpdesk",
    "payments/BNPL": "payments", "returns/exchanges": "returns", "upsell/checkout/CRO": "upsell-cro",
    "accounting": "accounting", "marketplaces": "marketplaces", "loyalty/referrals": "loyalty",
    "shipping/fulfillment/3PL": "shipping", "inventory/ops/ERP": "ops-erp",
    "search/merchandising": "search", "affiliate/influencer": "affiliate",
    "surveys/post-purchase": "surveys", "tax": "tax", "page builders": "page-builders",
    "product feeds": "product-feeds",
}

# Looked at closely and not built, with the reason a buyer should hear.
SKIPPED = {
    "postscript": "API keys only work on Postscript's enterprise plan; every other shop needs an integration partner's token, and the one list endpoint is subscribers (https://developers.postscript.io/docs/who-has-access-to-the-partner-api). CSV import meanwhile.",
    "attentive": "A merchant can make a custom app key, but the public API has no read endpoints for campaigns, messages, journeys or results; those leave Attentive by SFTP feed and webhook only (https://docs.attentive.com/docs/create-and-manage-custom-apps). CSV import meanwhile.",
    "okendo": "API is usable, but its relative next-page links need a custom pager in the runner. Planned. CSV import meanwhile.",
    "rebuy": "The public API is storefront only: product recommendations out, analytics events in. Nothing returns a merchant's own results (https://developers.rebuyengine.com/reference/rebuy-analytic-v2-endpoints/). CSV import meanwhile.",
    "northbeam": "Attribution data only leaves Northbeam through an export job: create, poll, then download a CSV or read a cloud bucket (https://docs.northbeam.io/docs/northbeam-api-data-exports-overview). That needs an export runner, not a REST spec. Planned.",
    "taxjar": "List endpoints return only IDs and skip transactions synced from Shopify, so a connector would mislead. CSV import instead.",
}

# Tools that are not in the research file. Each says plainly where it came from,
# so no usage number is invented for it.
EXTRA = [
    {
        "slug": "brevo", "name": "Brevo", "category": "email-sms",
        "why": "Not in the 100-tool research. Added in 0.12.0 from the Cosmic AI app's list of common email platforms. No install count on file.",
        "docs": "https://developers.brevo.com/",
    },
    {
        "slug": "google-search-console", "name": "Google Search Console", "category": "analytics",
        "why": "Not in the 100-tool research. Added in 0.12.0 because it costs almost nothing to add once Google sign-in exists. No usage data behind it.",
        "docs": "https://developers.google.com/webmaster-tools/v1/api_reference_index",
        "notes": "Planned as a built-in source, not a warehouse connector. Needs Google sign-in: the owner signs in with Google in the Cosmic AI app and picks a site. The CLI has no connector code for it yet. CSV import of daily clicks and impressions meanwhile.",
    },
    # 0.14.0: sources for workspaces that are not Shopify stores. Each "why" cites what marketers
    # said they connect; docs/WORKSPACES.md has the research behind the list.
    {
        "slug": "hubspot-records", "name": "HubSpot records (deals and contacts)", "category": "crm",
        "why": "Added in 0.14.0 for B2B workspaces: the CRM is where lead source and pipeline live, and B2B marketers say lead source reporting breaks there first. Source: https://www.reddit.com/r/b2bmarketing/comments/1xxn4g9/our_crm_says_most_of_our_leads_come_from_other/",
        "docs": "https://developers.hubspot.com/docs/api/crm/deals",
    },
    {
        "slug": "pipedrive", "name": "Pipedrive", "category": "crm",
        "why": "Added in 0.14.0 for B2B workspaces: a CRM dlt lists as a verified source (https://dlthub.com/docs/dlt-ecosystem/verified-sources/pipedrive). Agencies treat the CRM's lead source as the record. Source: https://www.reddit.com/r/PPC/comments/1oc0fu7/agencies_how_do_you_track_conversions/",
        "docs": "https://developers.pipedrive.com/docs/api/v1",
    },
    {
        "slug": "woocommerce", "name": "WooCommerce", "category": "store",
        "why": "Added in 0.14.0 for stores not on Shopify. Store owners on WooCommerce report GA4 purchases that do not match their orders. Source: https://www.reddit.com/r/GoogleAnalytics/comments/1voaecy/need_help_with_ga4_tracking_and_woocommerce/",
        "docs": "https://woocommerce.github.io/woocommerce-rest-api-docs/",
    },
    {
        "slug": "bigcommerce", "name": "BigCommerce", "category": "store",
        "why": "Added in 0.14.0 for stores not on Shopify. No usage count on file.",
        "docs": "https://developer.bigcommerce.com/docs/rest-management/orders",
    },
    {
        "slug": "customer-io", "name": "Customer.io", "category": "email-sms",
        "why": "Added in 0.14.0 for SaaS workspaces, as the lifecycle email tool many of them use instead of Klaviyo. No usage count on file.",
        "docs": "https://docs.customer.io/api/app/",
    },
    {
        "slug": "salesforce", "name": "Salesforce", "category": "crm",
        "why": "Added in 0.14.0 for B2B workspaces. dlt lists it as a verified source (https://dlthub.com/docs/dlt-ecosystem/verified-sources/salesforce).",
        "docs": "https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/",
        "notes": "Planned. Salesforce needs an OAuth connected app and SOQL queries, not a REST list spec, so it waits for the sign-in flow in the Cosmic AI app. CSV import of daily pipeline totals meanwhile.",
    },
    {
        "slug": "linkedin-ads", "name": "LinkedIn Ads", "category": "ads",
        "why": "Added in 0.14.0 for B2B workspaces, where LinkedIn is a common paid channel. No usage count on file.",
        "docs": "https://learn.microsoft.com/en-us/linkedin/marketing/",
        "notes": "Planned. The Marketing API needs an OAuth app that LinkedIn approves for advertising access, and Cosmic has not applied. CSV import of daily spend and clicks meanwhile.",
    },
    {
        "slug": "posthog", "name": "PostHog", "category": "product-analytics",
        "why": "Added in 0.14.0 for SaaS workspaces that track signups in product analytics. No usage count on file.",
        "docs": "https://posthog.com/docs/api",
        "notes": "Planned. Daily event counts come from PostHog's query endpoint as rows of arrays, which needs a small runner change; the events and persons lists carry person properties. CSV import of daily signups meanwhile.",
    },
    {
        "slug": "mixpanel", "name": "Mixpanel", "category": "product-analytics",
        "why": "Added in 0.14.0 for SaaS workspaces that track signups in product analytics. No usage count on file.",
        "docs": "https://developer.mixpanel.com/reference/overview",
        "notes": "Planned. Mixpanel's raw export streams one event per line, not a JSON list, and carries person properties. Its segmentation query fits better and needs a runner change. CSV import of daily signups meanwhile.",
    },
]

entries = []
for r in research:
    if r["slug"] in NATIVE:
        continue
    slug = SHORT.get(r["slug"], r["slug"])
    spec = specs.pop(slug, None)
    evidence = r["evidence"].strip().rstrip(".")
    why = f"#{r['rank']} of 100 tools Shopify stores use. {evidence}. Source: {r['evidence_url']}"
    docs = r.get("api_docs_url") or ""
    if not docs.startswith("https://"):
        docs = ""
    if spec:
        e = {
            "slug": slug, "name": spec.get("name", r["name"]), "category": CATEGORY[r["category"]],
            "readiness": "built", "why": why, "docs": spec.get("docs") or docs,
            "credentials": spec["credentials"], "params": spec.get("params", []), "config": spec["config"],
            "notes": (spec.get("notes") or "").strip(),
        }
        if spec.get("strip_fields"):
            e["stripFields"] = spec["strip_fields"]
    else:
        if r["api"] == "no":
            note = "No public data API. Bring daily totals in with lifecycle sources import."
        elif r["api"] == "partner":
            note = "API is partner-only or needs vendor approval. CSV import meanwhile."
        elif "oauth" in r["auth"].lower() and "key" not in r["auth"].lower():
            note = "Needs an OAuth sign-in flow, not built yet. CSV import meanwhile."
        else:
            note = "Public API; connector not written yet. Describe it with lifecycle warehouse add-api, or use CSV import."
        note = SKIPPED.get(slug, note)
        e = {
            "slug": slug, "name": r["name"], "category": CATEGORY[r["category"]], "readiness": "planned",
            "why": why, "docs": docs, "credentials": [], "params": [], "notes": note,
        }
    entries.append(e)

for x in EXTRA:
    spec = specs.pop(x["slug"], None)
    if spec:
        e = {
            "slug": x["slug"], "name": spec.get("name", x["name"]), "category": x["category"],
            "readiness": "built", "why": x["why"], "docs": spec.get("docs") or x["docs"],
            "credentials": spec["credentials"], "params": spec.get("params", []), "config": spec["config"],
            "notes": (spec.get("notes") or "").strip(),
        }
        if spec.get("strip_fields"):
            e["stripFields"] = spec["strip_fields"]
    else:
        e = {
            "slug": x["slug"], "name": x["name"], "category": x["category"], "readiness": "planned",
            "why": x["why"], "docs": x["docs"], "credentials": [], "params": [], "notes": x["notes"],
        }
    entries.append(e)

if specs:
    raise SystemExit(f"Specs with no research row: {sorted(specs)}")

body = json.dumps(entries, indent=2, ensure_ascii=False)
out = f"""// Generated by scripts/gen-warehouse-catalog.py from connectors/research-2026-11-07.json
// and connectors/specs/*.json. Edit those, then run the script. Do not edit by hand.
import type {{ WarehouseSource }} from './warehouse.js'

export const READINESS_LEGEND =
  'Readiness: native = built in with reconcile checks. tested = warehouse connector run on a real account. built = connector written from the vendor API docs, not yet run on a real account. planned = no connector yet; use lifecycle sources import meanwhile.'

export const WAREHOUSE_CATALOG: WarehouseSource[] = {body}
"""
(ROOT / "src/warehouse-catalog.ts").write_text(out)
built = sum(1 for e in entries if e["readiness"] == "built")
print(f"{len(entries)} sources: {built} built, {len(entries) - built} planned")
