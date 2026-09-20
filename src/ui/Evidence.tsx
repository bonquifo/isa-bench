import type { EvidenceBadge, ResultEnvelope } from '../lanes/types.ts'
import { hasVerifiedAttestation, hasVerifiedSignature } from '../lanes/types.ts'
import { ResultEnvelopeSchema } from '@isa-sim/contracts'

const styles: Record<EvidenceBadge, string> = {
  'SIMULATED ANALYTICAL': 'border-cyan-300/50 text-cyan-200',
  'GENERATED CODE VALIDATION': 'border-lime-300/50 text-lime-200',
  'EXTERNAL SIMULATOR': 'border-violet-300/50 text-violet-200',
  'PHYSICALLY MEASURED': 'border-amber-300/50 text-amber-200',
  'CALIBRATED PREDICTION': 'border-sky-300/50 text-sky-200',
  'IMPORTED UNVERIFIED': 'border-orange-300/50 text-orange-200',
  SIGNED: 'border-emerald-300/50 text-emerald-200',
  ATTESTED: 'border-teal-300/50 text-teal-200',
}

export function EvidenceBadgeView({ badge }: { badge: EvidenceBadge }) {
  return <span className={`evidence-badge ${styles[badge]}`}>{badge}</span>
}

export function EnvelopeBadges({
  envelope,
  primary,
}: {
  envelope: unknown
  primary: EvidenceBadge
}) {
  const parsed = ResultEnvelopeSchema.safeParse(envelope)
  if (!parsed.success || evidenceBadge(parsed.data.experimentKind) !== primary) return null
  const valid = parsed.data as ResultEnvelope
  return (
    <span className="flex flex-wrap gap-2">
      <EvidenceBadgeView badge={primary} />
      {hasVerifiedSignature(valid) && <EvidenceBadgeView badge="SIGNED" />}
      {hasVerifiedAttestation(valid) && <EvidenceBadgeView badge="ATTESTED" />}
    </span>
  )
}

function evidenceBadge(kind: string): EvidenceBadge {
  if (kind === 'analytical-inorder' || kind === 'analytical-ooo') return 'SIMULATED ANALYTICAL'
  if (kind === 'toolchain-validation') return 'GENERATED CODE VALIDATION'
  if (kind === 'empirical-measurement') return 'PHYSICALLY MEASURED'
  if (kind === 'calibrated-prediction') return 'CALIBRATED PREDICTION'
  return 'EXTERNAL SIMULATOR'
}
