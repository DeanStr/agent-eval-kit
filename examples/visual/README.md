# Visual evaluation examples

The dashboard example demonstrates controlled browser capture and separate
baseline and aspirational comparisons. `aek init --kind visual` generates a
self-contained canvas/WebGL starter with capture, fidelity, and interface gates.

## Calibrate fidelity and interface clarity independently

From an installed package:

```sh
node node_modules/agent-eval-kit/examples/visual/calibrate.mjs ./visual-calibration --model YOUR_MODEL --effort high
```

The destination must be new. Preparation creates three authored SVG fixtures:
a readable control, a blurred environment with additional readable metrics,
and an unchanged sharp environment with unreadable interface text. AEK seals
each image through command collection, then `aek judge validate` compares two
independent criteria with six agent-authored reviewer labels. Labels stay outside
the project and never enter judge prompts. No browser or third-party pixels are
required. Real judging requires the configured Codex subscription.

Expected fidelity outcomes are pass/fail/pass; expected interface outcomes are
pass/pass/fail. Fidelity compares the declared environment crop, while interface
clarity examines the full candidate. Additional metrics must not rescue blurred
rendering, and strong rendering must not rescue unreadable text. Inspect the
images and labels before interpreting the results. This small, related development
family does not establish held-out accuracy or human approval.

Use `--prepare-only --provider mock` for offline preparation without model calls.
Mock judgments abstain and cannot establish calibration accuracy. Supply
`--fidelity-rubric FILE` and `--ui-rubric FILE` to test project-owned criteria over
the same controlled defects. These replace criterion text, retaining the explicit
crop and pass criteria. Add representative application captures for broader
calibration; synthetic fixtures alone cannot establish real-world judge accuracy.

Open `visual-calibration/comparison/validation-results.html` for reviewed pixels,
decisions, evidence coverage, false passes, false failures, and execution errors.
