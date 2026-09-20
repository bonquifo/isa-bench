export type CertificateRole = 'admin' | 'runner' | 'none' | 'conflict'

export function certificateRole(
  fingerprint: string | null | undefined,
  adminFingerprints: readonly string[],
  runnerFingerprint?: string | null,
): CertificateRole {
  if (!fingerprint) return 'none'
  const normalized = fingerprint.replaceAll(':', '').toLowerCase()
  const admin = adminFingerprints.includes(normalized)
  const runner = runnerFingerprint?.replaceAll(':', '').toLowerCase() === normalized
  if (admin && runner) return 'conflict'
  if (admin) return 'admin'
  if (runner) return 'runner'
  return 'none'
}
