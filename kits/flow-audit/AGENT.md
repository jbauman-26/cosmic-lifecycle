# Flow audit runbook

Goal: tell the user what to fix first in their Klaviyo flows, using evidence.

1. Run `lifecycle sync --format json`.
2. Run `lifecycle reconcile --format json`. If a check failed, tell the user before any finding, and name the check.
3. Run `lifecycle audit flows --format json --html flow-audit.html`.
4. Read the findings. Missing-flow findings match on flow names, so ask the user before calling a flow missing.
5. Pick the three findings most likely to matter and explain why, using only numbers from the output or from `lifecycle query`.
6. Follow `../shared/editing-standard.md` for everything you write.

Rules:
- Never claim a flow caused revenue. Klaviyo's revenue is attributed.
- If a trend has few recipients, say the sample is small.
- This kit changes nothing in Klaviyo.

Done means: the user has a ranked list, the HTML file, and the status of every reconcile check.
