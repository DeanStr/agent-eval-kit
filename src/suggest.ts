/** Optimal string alignment distance: insertions, deletions, substitutions, and transpositions. */
function editDistance(left: string, right: string): number {
  const rows = left.length + 1;
  const columns = right.length + 1;
  const distance: number[][] = Array.from({ length: rows }, (_, row) =>
    Array.from({ length: columns }, (_, column) => (row === 0 ? column : column === 0 ? row : 0)),
  );
  for (let row = 1; row < rows; row++) {
    for (let column = 1; column < columns; column++) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      let best = Math.min(
        distance[row - 1]![column]! + 1,
        distance[row]![column - 1]! + 1,
        distance[row - 1]![column - 1]! + cost,
      );
      if (
        row > 1 &&
        column > 1 &&
        left[row - 1] === right[column - 2] &&
        left[row - 2] === right[column - 1]
      )
        best = Math.min(best, distance[row - 2]![column - 2]! + 1);
      distance[row]![column] = best;
    }
  }
  return distance[left.length]![right.length]!;
}

/** The closest candidate within a typo-sized distance, or undefined when nothing is close. */
export function closestMatch(input: string, candidates: Iterable<string>): string | undefined {
  const needle = input.toLowerCase();
  let best: { candidate: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = editDistance(needle, candidate.toLowerCase());
    if (!best || distance < best.distance) best = { candidate, distance };
  }
  if (!best) return undefined;
  const allowed = Math.max(1, Math.floor(Math.max(input.length, best.candidate.length) / 3));
  return best.candidate !== input && best.distance <= allowed ? best.candidate : undefined;
}

/** " Did you mean `run`?" or an empty string. */
export function didYouMean(
  input: string,
  candidates: Iterable<string>,
  format = (value: string) => `\`${value}\``,
): string {
  const match = closestMatch(input, candidates);
  return match === undefined ? "" : ` Did you mean ${format(match)}?`;
}
