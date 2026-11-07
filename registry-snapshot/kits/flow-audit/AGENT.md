# Flow audit runbook

Goal: tell the user what to fix first in their Klaviyo flows, using evidence.

Before you start, run `lifecycle docs agents` and `lifecycle doctor --format json`. If Klaviyo is not connected, follow `lifecycle docs setup` with the user first.

1. Run `lifecycle sync --format json`.
2. Run `lifecycle reconcile --format json`. If a check failed, tell the user before any finding, and name the check.
3. Run `lifecycle audit flows --format json --html flow-audit.html`.
4. Read the findings. Missing-flow findings match on flow names, so ask the user before calling a flow missing.
5. Pick the three findings most likely to matter and explain why, using only numbers from the output or from `lifecycle query`.
6. Write the summary in the shape of `files/findings-summary.md`.
7. Follow `../shared/editing-standard.md` for everything you write.

Rules:
- Never claim a flow caused revenue. Klaviyo's revenue is attributed.
- If a trend has few recipients, say the sample is small.
- This kit changes nothing in Klaviyo.

## Verify
- [ ] `lifecycle reconcile --format json` ran, and every failed check is named in the summary.
- [ ] `flow-audit.html` exists.
- [ ] Every number in the summary appears in the audit output or a `lifecycle query` result.
- [ ] Any flow called missing was confirmed with the user.
- [ ] The summary passed the editing standard at 16 of 20 or better.
