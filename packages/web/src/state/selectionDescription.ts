export type CompositionCounts = { instances: number; pipes: number; shapes: number; leaderLines: number; images: number }

/**
 * "2 instances, 1 pipe" style summary of a selection's composition across
 * all five kinds — shared by the status bar and the properties panel's
 * group/loose-multi-select views, so a mixed selection is described
 * consistently everywhere instead of each place picking one category to
 * report and silently dropping the others.
 */
export function describeComposition(counts: CompositionCounts): string {
  return [
    counts.instances > 0 && `${counts.instances} instance${counts.instances === 1 ? '' : 's'}`,
    counts.pipes > 0 && `${counts.pipes} pipe${counts.pipes === 1 ? '' : 's'}`,
    counts.shapes > 0 && `${counts.shapes} shape${counts.shapes === 1 ? '' : 's'}`,
    counts.leaderLines > 0 && `${counts.leaderLines} leader line${counts.leaderLines === 1 ? '' : 's'}`,
    counts.images > 0 && `${counts.images} image${counts.images === 1 ? '' : 's'}`,
  ]
    .filter(Boolean)
    .join(', ')
}
