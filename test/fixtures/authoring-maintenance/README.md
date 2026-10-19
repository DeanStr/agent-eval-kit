# Maintenance fixture

The test starts with the existing authoring cart map and records an initial Git
baseline plus a good/defect calibration pair. The update introduces a documented
discount API outside the map, breaks the collection procedure's source lookup,
and regresses quantity multiplication. The changes remain uncommitted so a HEAD
alone is insufficient. A retained earlier discovery task must carry forward.

Expected review findings: DISCOUNT is a new coverage gap, the source lookup is a
collection execution error, and QUANTITY is a product regression after collection
is repaired. The quantity expectation and ID must not change. Current-interface
survey also finds a previously unmapped receipts question outside the diff.

The test archives incompatible trials, updates the collector/checker to observe
the new API, and recalibrates all checks with fresh good/defect runs. The review
note references the template, revision, dirty patches, runs, method identities,
and outstanding discovery/intent. This validates the workflow's artifact and
execution distinctions; it does not measure an author's interviewing quality.
