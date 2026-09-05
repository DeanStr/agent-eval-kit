# Project guidelines

- This project is in early pre-release. Backward compatibility is not required; prefer clear designs over legacy support or migration layers.
- Avoid unnecessary fallbacks. Fail fast with actionable errors when inputs, contracts, or execution are invalid, rather than silently substituting defaults or hiding failures.
- Keep valid uncertainty distinct from execution errors: blocked scenarios and insufficient evidence should reduce coverage, not become fabricated scores.
- Keep changes focused and verify them with relevant tests.
