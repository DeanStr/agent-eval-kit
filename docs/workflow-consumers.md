# Comparison workflow consumers

Tasks, data, instrumentation and acceptance criteria live in application-owned
`evals/` directories. AEK ships orchestration, measurement contracts and reports.
Both integrations install an immutable AEK npm archive verified against their
`tool.json` checksum; normal project commands replace manual source-checkout paths.
Generated `.agent-eval` projects, dependencies and observations stay local.

## Vacation creator kit

`evals/creator-kit-comparison/` consumes the current Vacation request contract and
hosted creator kit (source baseline `6ef56b4bf43cfeb29647502ef1bc3a48ce89a88c`,
kit `0.17.8`). Preparation stages generated hosted assets with rendered rule
partials and excludes source-only example payloads and evaluator fixtures.
Its independent task checks require Hobart and exactly three itinerary days in
addition to the real Zod request contract.

The default experiment uses AEK's real external Docker runner with explicit fixed
controls. A separate calibration definition replays named accepted/invalid
submissions; it has no fallback into live execution and makes no prompt-quality
claim. Application tests check contract failures, task mismatches, and separation
of candidate/evaluator files. The `review-validation-20261019/` output retains the
fresh calibration attempts, alongside the original `validation/` evidence.
No hosted API mutations or publications are needed. Actual live candidate-quality
trials require the caller's model runner controls and appropriate project criteria.

## Melbourne workload

`evals/aek-benchmark/` consumes Melbourne's actual portable SHA-256 and worker-pool
implementations (source baseline `9ce0a9a8a614a4669d263568248ac6a3fa7856b4`).
The reviewed observer runs a single selected role per fresh visit, with fixed
input sizes, allocation/warmup, sample count and copy budget. It preserves raw
returned digests even when they are wrong. The independent command grader checks
all observations against Node SHA-256 and the declared worker/mode requirements.
Runtime errors retain partial diagnostics and never become product scores.

The integration records actual browser/library/runtime and hardware identity,
verified source pins, raw application samples and completed MiB. Complete
collection and AEK elapsed durations remain separate from application timing.
A correctness gate must cite the declared retained raw file. Tests cover accepted,
incorrect, malformed and execution-error outcomes, including actual AEK grading.

Fresh review runs use `.agent-eval/aek-benchmark/review-validation-20261019/`.
The original paired-run evidence remains under `validation/`; its method differs
and is not comparable with the reviewed single-role protocol. These shared-host
CPU measurements validate the integration. They do not establish controlled-host
speedup, whole-scene startup, GPU/FPS improvement, or photographic acceptance.
Those application protocols still need their own evidence.
