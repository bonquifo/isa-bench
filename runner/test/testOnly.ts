// This file is outside src/, excluded from build, and absent from package exports.
export const syntheticBundleHeader = (jobId: string, runnerId: string) => ({
  kind: 'header' as const,
  schemaVersion: '1' as const,
  jobId,
  runnerId,
  testOnly: true as const,
  createdAt: '2026-01-01T00:00:00.000Z',
})
