# Minimal browser action experiment

This branch is an evaluation candidate, not a release recommendation.
It is based on PR15 plus measurement-only evaluation accounting and verified-action fixes.
It keeps the persistent JavaScript runtime, raw CDP, page evaluation, screenshots, fetch,
checkpoint/file access and research tools unchanged.

Optional helpers are limited to state, find, goto, click, fill, native select, check, press,
waitForText and explicit expected-dialog handling. Names must match exactly after normalized
case, whitespace and accents; ambiguous names fail. Numeric IDs come from observed page state.
No helper calls a language model. The host model chooses the action.

Custom dropdowns, autocomplete selection, uploads, downloads, dragging, hover, table extraction
and search use existing raw primitives or host tools. This branch removes the helper-only
implementations and search endpoint integration. It is intentionally API-incompatible with
the experimental PR15 helper set. Default mode is unchanged.

Input dispatch and short settling are not task completion. Check/select verify the retained
control value. Fill checks the exact immediate value before optional Enter; later application
processing still needs an explicit condition. A failed action may be uncertain and is never
automatically replayed. A cell emits one compact state after helper mutations, subject to the
existing slow-snapshot guard and output limits; all original evidence must still be retained
by the host. Context compaction can lose useful meaning even when raw evidence is archived.

Confirm/prompt dialogs dismiss unless an exact one-action policy was explicitly set; alerts
are acknowledged. Iframe geometry rejects unsupported transforms and ancestor overlays.
Cross-origin frames and unusual widgets may require raw CDP or screenshots. This is no claim
of complete edge-case coverage.

Private evaluation: same tasks, model, priority tier, judge, browser provider and budgets as
the high-cap PR15 pilot. Preserve all attempts and judge outputs; never pool this adaptive
diagnostic subset into a representative benchmark claim. Cost figures are model estimates,
not invoices or total infrastructure cost.
