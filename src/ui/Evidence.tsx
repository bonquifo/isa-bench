/**
 * Every result this app produces comes from one of the two deterministic
 * timing models, so there is a single badge. It exists to keep modeled output
 * visibly labelled as modeled rather than measured.
 */
export function EvidenceBadgeView({ badge = 'SIMULATED ANALYTICAL' }: { badge?: 'SIMULATED ANALYTICAL' }) {
  return <span className="evidence-badge border-cyan-300/50 text-cyan-200">{badge}</span>
}
