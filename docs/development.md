# Development

These commands apply to a source checkout of this repository. See
[shared judging contracts](judging-contracts.md) for identity, evidence, image-access, and case-aggregation rules across grading modes.
See [internal boundaries](internal-boundaries.md) for run recovery, input provenance, browser interactions, and scoring responsibilities.

## Checks

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm smoke:browser
pnpm smoke:browser:full
pnpm test:reference
pnpm smoke:package
pnpm build
```

Code linting uses [Biome](https://biomejs.dev/) with its recommended preset. Run `pnpm lint:fix` to apply safe fixes. Run `pnpm format` to format code and `pnpm format:check` to verify formatting. Formatting uses two spaces and a 100-column line width; CI enforces it. Import organization is disabled. The configuration allows non-null assertions, string concatenation, explicit null guards, and assignments in loop conditions to preserve existing code conventions. Lint warnings fail CI. The `noFloatingPromises` and `noMisusedPromises` rules are explicitly enforced as errors.

TypeScript enforces strict mode, checked indexed access, exact optional properties, explicit return paths, switch fallthrough checks, explicit overrides, and unused-code checks. Omit absent optional fields instead of assigning `undefined`; validate required indexed values before using them.

The fast browser smoke covers the basic contract. The full regression fixture covers SPA click targets, custom dropdowns, rich-text editors, temporal inputs, iframes, open shadow DOM, modal scoping, overlays, nested upload controls, drag-and-drop, inner scroll containers, origin containment, synthesized labels, ref-budget collapse, and bounded screenshots.

The CI workflow runs these checks on Linux with Node 20.19, 22, and 24. Package smoke builds a tarball, installs production dependencies in a temporary consumer, and exercises the installed CLI and workspace MCP without TypeScript source or `tsx`.

## Reference checks and provider smoke

Reference checks contain working, broken, and missing cart-total implementations with separately specified expected outcomes. The default command uses deterministic graders and no model quota. To measure a real collector/judge pair or check a provider's browser and workspace integration:

```bash
pnpm test:reference --provider codex --judge claude --repetitions 3
pnpm smoke:provider --provider codex
pnpm smoke:provider --provider claude
pnpm smoke:provider --provider grok
```

These opt-in commands use the selected subscriptions and retain versioned, integrity-checked reports under `.agent-eval/reference/`. Each provider invocation is capped at 180 seconds and 20 turns/interactions. See [release validation](release-validation.md) for interpretation, known limits, and the provider verification record.

## Release packaging

`pnpm package:release` builds a versioned production tarball and SHA-256 checksum
under `.agent-eval/release/`; see [installing the built package](../README.md#built-package-distribution).
The release workflow tests the exact archive and publishes these artifacts as a
GitHub pre-release when a matching `v*` tag is pushed. The tag, `package.json`,
and `src/version.ts` versions must agree.
Adding the workflow does not publish a release or establish npm registry availability.
