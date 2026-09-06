import { sha256, stableJson } from "../io.js";
import type { EvalSpec, RubricItem, TextCase } from "../types.js";
import { textPairwiseSchema, textRubricSchema, type TextSource } from "./contracts.js";

/** A case is independent of collection. Bind only whole input placeholders. */
export function textInstances(
  spec: EvalSpec,
  item: RubricItem,
): Array<{ item: RubricItem; case?: TextCase }> {
  if (!item.dataset) return [{ item }];
  const cases = spec.datasets?.[item.dataset];
  if (!cases) throw new Error(`${item.id} uses unknown dataset ${item.dataset}`);
  return cases.map((c) => {
    const bind = (source: TextSource): TextSource => {
      if (typeof source !== "string") return source;
      const match = /^\{\{inputs\.([A-Za-z][A-Za-z0-9_-]*)\}\}$/.exec(source);
      if (!match) {
        if (source.includes("{{"))
          throw new Error(`${item.id}: input bindings must occupy the entire path`);
        return source;
      }
      if (!Object.hasOwn(c.inputs, match[1]!))
        throw new Error(`${item.id}/${c.id}: missing input ${match[1]}`);
      return c.inputs[match[1]!]!;
    };
    const g = item.grader;
    const grader =
      g.type === "text-pairwise"
        ? textPairwiseSchema.parse({
            ...g,
            candidate: bind(g.candidate),
            references: g.references.map((r) => ({ file: bind(r.file) })),
            ...(g.styleTarget ? { styleTarget: { file: bind(g.styleTarget.file) } } : {}),
          })
        : g.type === "text-rubric"
          ? textRubricSchema.parse({
              ...g,
              inputs: Object.fromEntries(
                Object.entries(g.inputs).map(([name, input]) => [
                  name,
                  { ...input, file: bind(input.file) },
                ]),
              ),
            })
          : (() => {
              throw new Error(`${item.id}: datasets require direct text grading`);
            })();
    const { dataset: _, ...base } = item;
    return { item: { ...base, id: `${item.id}--${c.id}`, grader }, case: c };
  });
}

/** Hash resolved evaluator definitions; candidate content belongs to run identity. */
export function specMethodHash(spec: EvalSpec): string {
  const { sourceFile: _, datasets, rubric, ...area } = spec;
  return sha256(
    stableJson({
      ...area,
      datasets:
        datasets &&
        Object.fromEntries(
          Object.entries(datasets).map(([name, cases]) => [
            name,
            cases.map(({ inputs: _, ...c }) => c),
          ]),
        ),
      rubric: rubric.flatMap((item) =>
        textInstances(spec, item).map(({ item: bound }) => {
          const grader = bound.grader;
          return {
            ...bound,
            rubricId: item.id,
            dataset: item.dataset,
            grader:
              grader.type === "text-pairwise"
                ? { ...grader, candidate: "<candidate input>" }
                : grader.type === "text-rubric"
                  ? {
                      ...grader,
                      inputs: Object.fromEntries(
                        Object.entries(grader.inputs).map(([name, input]) => [
                          name,
                          input.role === "candidate"
                            ? { ...input, file: "<candidate input>" }
                            : input,
                        ]),
                      ),
                    }
                  : grader,
          };
        }),
      ),
    }),
  );
}
