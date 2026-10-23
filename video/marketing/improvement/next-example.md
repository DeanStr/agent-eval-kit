# The dispatch workflow as the after

The first dashboard film establishes real, bounded improvement, but its endpoint
is too modest. Its overview rubric asks for a total, a leading region and readable
hierarchy; passing that rubric does not establish an excellent product. The user's
review rejects that endpoint as a strong marketing demonstration.

## Endpoint: a delivery exception workspace

The audience should see someone make a consequential decision: identify a shipment
that will miss its window, understand why, compare feasible recovery options, then
reassign it without overloading a driver or breaking a handling requirement.

The working prototype is `docs/marketing/dispatch/`. It uses a new, explicitly
synthetic dispatch fixture. Human feedback directed it; the old three-region
dashboard scores do not apply to it. Instead, `dispatch/suite.yaml` turns the
targets below into five frozen criteria, and an AEK improvement session scores the
prototype and guides further coding-agent revisions. The film's after is the
evaluated final revision; `workflow.mjs` seals that session with its browser
captures in `workflow.json`.

## Product quality targets

- **Decision quality:** the initial view makes the urgent exception, its cause,
  deadline and consequence discoverable together; recovery choices explain ETA,
  spare capacity and handling constraints before confirmation.
- **Working task:** selecting a shipment, filtering, searching, inspecting drivers,
  comparing options, confirming, undoing and reloading all have real stateful
  behavior. A screenshot with decorative controls is insufficient.
- **Data integrity:** all totals derive from fixture records; assignment changes
  preserve every shipment, respect capacity and cold-chain constraints, update all
  related views, and survive reload. An invalid assignment is a failed gate.
- **Usability:** keyboard operation, focus return, explicit confirmation, an empty
  result state and a narrow-screen workflow work end to end. A responsive width
  measurement alone is insufficient.
- **Craft:** coherent typography, useful density, purposeful map/queue/detail
  relationships, restrained color and thoughtful state changes. Adding cards or
  enlarging a metric is insufficient. Review the actual completed task and compare
  complete product screens, not merely the presence of prescribed elements.

## Scored session

Criteria were frozen before the baseline. DATA, TASK and PHONE are deterministic
browser checks; DECISION and CRAFT are fresh Codex judgments (three to five votes).
The PHONE thresholds (no nested queue scrolling, 12px text, 40px controls) were
written after a code review noted the nested phone queue, so treat them as
agent-authored standards rather than independent findings.

| Evaluated revision | Data | Task | Phone | Decision | Craft | Score |
| --- | --- | --- | --- | --- | --- | --- |
| Human-directed prototype | Pass | Pass | Fail | Pass | Partial | 70% |
| Phone queue and option text | Pass | Pass | Pass | Pass | Partial | 90% |
| Type scale, contrast and map labels | Pass | Pass | Pass | Pass | Pass | 100% |
| Fresh repeat of the final revision | Pass | Pass | Pass | Pass | Pass | 100% |

All four evaluations have complete coverage and one evaluator fingerprint. The
session is `.agent-eval/marketing-video/dispatch-bLOsT1/`.
