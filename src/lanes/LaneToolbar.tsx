export function LaneToolbar({
  title,
  kicker,
  running,
  disabled,
  disabledReason,
  onRun,
  onCancel,
}: {
  title: string
  kicker: string
  running: boolean
  disabled?: boolean
  disabledReason?: string
  onRun: () => void
  onCancel?: () => void
}) {
  return (
    <header className="lane-toolbar">
      <div className="min-w-0">
        <p className="hud-kicker">{kicker}</p>
        <h2 className="font-display text-xl font-bold uppercase tracking-[0.14em]">{title}</h2>
        {disabled && disabledReason && <p className="mt-1 text-sm text-orange-200">{disabledReason}</p>}
      </div>
      <button
        type="button"
        className="jack-btn"
        disabled={!running && Boolean(disabled)}
        // The label has to track the action: while a run is in flight this
        // button cancels, and announcing it as "RUN MODEL" would be wrong.
        aria-label={running ? 'CANCEL RUN' : 'RUN MODEL'}
        onClick={running ? onCancel : onRun}
      >
        {running ? 'CANCEL RUN' : 'RUN MODEL'}
      </button>
    </header>
  )
}
