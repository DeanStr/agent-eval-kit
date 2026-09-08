# Persistent project map

The canonical editable record is `<project>/.aek-authoring/plan.json`. It is JSON,
not an executable spec. `aek author init` creates a valid empty map without needing
an eval config. Run `aek author validate --project <root> --json` after edits.
All fields reject unknown keys. IDs must be unique ignoring case within their
collection and use letters, digits, underscores, or hyphens. References use exact IDs.

This illustrative map is clarified but has no executable check yet:

```json
{
  "version": 1,
  "scope": {
    "mode": "project",
    "description": "Evaluate the agreed storefront release workflows",
    "reviewedBy": "product owner (conversation 2026-09-08)"
  },
  "config": "evalkit.yaml",
  "discovery": {
    "sources": [{"kind": "document", "ref": "README.md: storefront workflows"}],
    "remaining": ["Review checkout, account recovery, exports, and notifications"]
  },
  "areas": [{
    "id": "cart",
    "title": "Cart",
    "sources": [{"kind": "document", "ref": "docs/cart.md"}]
  }],
  "decisions": [{
    "id": "D-RELOAD",
    "question": "Must cart quantities survive a browser reload?",
    "dependsOn": [],
    "resolution": {
      "answer": "Yes, for anonymous and authenticated buyers.",
      "source": {"kind": "user", "ref": "Product owner, answer 2 in authoring session"}
    }
  }],
  "requirements": [{
    "id": "CART-PERSIST",
    "area": "cart",
    "statement": "A buyer retains cart quantity and subtotal after reload.",
    "sources": [{"kind": "user", "ref": "Product owner, answer 2"}],
    "priority": "critical",
    "decisionIds": ["D-RELOAD"],
    "dependsOn": [],
    "acceptance": "Two 5.00 items remain quantity two with subtotal 10.00 after reload, for each buyer role.",
    "evidence": "Before/after screenshots and the recorded reload; case results for both roles.",
    "preparation": "Seed the 5.00 fixture product, empty both carts, and capture the buyer session.",
    "confirmedBy": "product owner (answer 2)",
    "checks": [],
    "trials": []
  }]
}
```

Use real sources and actual review identities, never this example's approvals.
A document reference is an authoritative requirement only when its role is clear.
A code-derived observation belongs under `inference` until its expected behavior
is confirmed. `resolution.source.kind: inference` is invalid: suggestions cannot
settle decisions. Keep an unresolved decision by omitting `resolution` entirely.
Record prerequisite IDs in `dependsOn`; cycles, unknown dependencies, and resolving
a decision before its prerequisite are errors.

## Fields and transitions

- `scope`: `mode` is `project` or `feature`; `description` names the destination.
  Omit `reviewedBy` until the user reviewed the inventory. Clear it when scope
  materially changes and obtain a new review.
- `config`: optional path to one AEK config inside the project; required once
  checks are linked. It can select several named suites through individual checks.
  Use one map per independent project root/config; a monorepo can have several maps.
- `discovery.sources`: inspected sources. `remaining`: areas or questions still
  needing discovery. Empty is an explicit assertion that the agreed survey is done.
- `areas`: discovered product areas with sources. An area must have requirements
  (including reviewed exclusions) before readiness can be true.
- `decisions`: open questions or sourced answers; resolved answers can come from
  the user or an authoritative document. Keep them when a session ends.
- `requirements`: each has an area, statement, sources, `priority` (`critical`,
  `normal`, `low`, `undecided`), `decisionIds`, requirement `dependsOn`, `checks`,
  and `trials`. Acceptance, evidence, preparation, and `confirmedBy` are optional
  during discovery and required before linking a check. Use explicit "None needed"
  for genuinely unnecessary preparation; don't omit an unknown preparation need.
- `exclusion`: `{ "reviewer": "...", "reason": "..." }` records a deliberate
  exclusion. Excluded requirements cannot retain active checks or trials. Do not
  exclude something merely because its environment or implementation is missing.
- `checks`: `{ "area": "cart", "rubric": "CART-01", "suite": "release" }`.
  Omit `suite` to use the config's default. IDs must exist and the rubric must be
  applicable. Multiple links can cover different acceptance clauses or suites.
  Link shared checks to multiple requirements only if the observed criterion
  actually supports each requirement; the validator cannot establish semantic fit.
- `trials`: `{ "kind": "good" | "defect", "run": ".agent-eval/runs/ID",
  "rationale": "why this target is known good, or what intentional defect it contains" }`.
  Paths resolve from the map's project root; explicit absolute paths are accepted.
  Use scored runs, not collections or promoted snapshots. All trial directories
  must remain available. Keep exact evaluator settings in config for pilots;
  one-off provider overrides can make a trial incompatible with that config.

Do not handwrite a stage or coverage percentage. The CLI derives:

| Stage | Meaning |
| --- | --- |
| discovered | The acceptance contract or a decision remains unresolved. |
| clarified | Expectations, evidence, preparation, priority, and confirmation are recorded. |
| configured | All linked checks resolve in valid evaluation inputs. |
| exercised | Every linked check has at least one fully observed decisive recorded result. |
| calibrated | Every linked check has a recorded good pass and a defect fail, with the same evaluator fingerprint and different target identities. |
| excluded | A reviewer and rationale explicitly remove this requirement from scope. |

These are authoring stages, not product verdicts. A tested product failure can
be `exercised`. `calibrated` does not mean every case or failure mode was tested.
Mock model judging cannot establish exercise or calibration. An automatic
abstention or partial evidence does not establish a fully observed check.
Malformed/tampered runs, unknown bindings, and changed evaluator methods fail
validation with actionable errors rather than silently reducing the counts.

`ready` requires a reviewed scope, completed discovery, no open decisions or empty
areas, at least one included requirement, and active checks for every included
requirement and its prerequisites. It means ready to pilot the inventory. It does
not require a passing product, prove calibration, or measure the whole product's
coverage. Unmapped rubrics are reported for review; existing checks are preserved.

Use human review of the map-to-rubric mapping to catch weakened wording, missing
case variants, incorrect sources, and checker expectations derived from the target.
The editable map records human assertions; it is not a signed approval ledger.
Store supplementary notes/history in `.aek-authoring/`, with references from the
map; leave credentials and raw private run evidence in their existing locations.
