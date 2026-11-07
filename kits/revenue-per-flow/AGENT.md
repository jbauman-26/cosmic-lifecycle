# Revenue per flow runbook

Goal: show which flows earn the most per person reached, alongside real Shopify revenue.

1. Run `lifecycle sync --format json`, then `lifecycle reconcile --format json`.
2. If `klaviyo_orders` failed, stop and tell the user Klaviyo and Shopify disagree. Do not rank flows on data that fails this check.
3. Run `lifecycle report revenue-per-flow --format json --html revenue-per-flow.html`.
4. Report the top and bottom flows, the share of Shopify net revenue, and the trust line word for word.
5. Follow `../shared/editing-standard.md`.

Rules:
- Say "attributed revenue" every time.
- A flow with few recipients can rank high by chance, so give the recipient count beside every figure.

Done means: a ranked table with recipient counts, the trust line and one recommended next step.
