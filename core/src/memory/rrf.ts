/**
 * Reciprocal rank fusion.
 * Score is the sum of `weight / (k + rank)` with rank starting at 1.
 * A list with weight 0 does not contribute. Ties break by id.
 */
export const RRF_K = 60;

export interface RankedList {
  weight: number;
  ids: readonly string[];
}

export interface FusedRank {
  id: string;
  score: number;
}

export function fuseRrf(
  lists: readonly RankedList[],
  k: number = RRF_K,
): FusedRank[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    if (list.weight === 0) {
      continue;
    }
    for (let index = 0; index < list.ids.length; index += 1) {
      const id = list.ids[index];
      if (id === undefined) {
        continue;
      }
      const rank = index + 1;
      scores.set(id, (scores.get(id) ?? 0) + list.weight / (k + rank));
    }
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort(
      (left, right) =>
        right.score - left.score || left.id.localeCompare(right.id),
    );
}
