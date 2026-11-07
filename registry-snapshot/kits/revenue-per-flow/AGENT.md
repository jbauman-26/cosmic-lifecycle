# Revenue per flow runbook

Goal: show which flows earn the most per person reached, alongside real Shopify revenue.

Before you start, run `lifecycle docs agents` and `lifecycle doctor --format json`. Klaviyo and Shopify must both be connected.

1. Run `lifecycle sync --format json`, then `lifecycle reconcile --format json`.
2. If `klaviyo_orders` failed, stop and tell the user Klaviyo and Shopify disagree. Do not rank flows on data that fails this check.
3. Run `lifecycle report revenue-per-flow --format json --html revenue-per-flow.html`.
4. Report the top and bottom flows, the share of Shopify net revenue, and the trust line word for word, in the shape of `files/ranking-summary.md`.
5. Follow `../shared/editing-standard.md`.

Rules:
- Say "attributed revenue" every time.
- A flow with few recipients can rank high by chance, so give the recipient count beside every figure.

## Verify
- [ ] `klaviyo_orders` passed, or you stopped and told the user it failed.
- [ ] The trust line is quoted word for word.
- [ ] Every flow in the table shows its recipient count.
- [ ] `revenue-per-flow.html` exists.
- [ ] The summary passed the editing standard at 16 of 20 or better.
