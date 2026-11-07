# Win-back segment runbook

Goal: create one Klaviyo segment of past buyers who have gone quiet, timed from this brand's own repeat behavior.

1. Run `lifecycle sync --format json`, then `lifecycle reconcile --format json`.
2. Run `lifecycle segments propose winback --format json`. This creates a plan file and changes nothing.
3. Show the user the segment name, the lapsed window and the reason.
4. Stop and wait for the user to approve this exact plan. Their earlier approval of other work does not count.
5. Only after approval, run `lifecycle segments apply winback-plan.json --confirm --key-env NAME`. The key must be a separate one with Segments write access.
6. Tell the user a segment was created and that nothing was sent.

Rules:
- Never run step 5 on your own initiative.
- If the plan file was edited, the CLI refuses it. Propose it again, do not work around it.
- If asked to draft win-back emails, follow `../shared/editing-standard.md`, leave offers as [NEEDS OFFER], and deliver drafts only.

Done means: the segment exists in Klaviyo, or the user declined and nothing changed.
