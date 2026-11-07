# Win-back segment runbook

Goal: create one Klaviyo segment of past buyers who have gone quiet, timed from this brand's own repeat behavior.

Before you start, run `lifecycle docs agents` and `lifecycle doctor --format json`. Klaviyo and Shopify must both be connected.

1. Run `lifecycle sync --format json`, then `lifecycle reconcile --format json`.
2. Run `lifecycle segments propose winback --format json`. This creates a plan file and changes nothing. `files/plan.example.json` shows its shape.
3. Show the user the segment name, the lapsed window and the reason.
4. Stop and wait for the user to approve this exact plan. Their earlier approval of other work does not count.
5. Only after approval, run `lifecycle segments apply winback-plan.json --confirm --key-env KLAVIYO_SEGMENTS_KEY`. The key must be a separate one with Segments write access.
6. Tell the user a segment was created and that nothing was sent.

Rules:
- Never run step 5 on your own initiative.
- If the plan file was edited, the CLI refuses it. Propose it again, do not work around it.
- If asked to draft win-back emails, follow `../shared/editing-standard.md`, leave offers as [NEEDS OFFER], and deliver drafts only.

## Verify
- [ ] The user approved this exact plan in this conversation before step 5.
- [ ] `segments apply` printed a segment id, or the user declined and nothing changed.
- [ ] You told the user nothing was sent.
- [ ] Any email drafts passed the editing standard at 16 of 20 or better and are marked as drafts.
