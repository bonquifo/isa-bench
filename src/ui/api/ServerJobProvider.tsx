import {
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { BackendClient } from '../backendClient.ts'
import { ServerJobManager, type ManagedServerJob } from './ServerJobManager.ts'
import { ServerJobContext } from './ServerJobContext.ts'

export function ServerJobProvider({
  client,
  children,
}: {
  client: BackendClient
  children: ReactNode
}) {
  const manager = useMemo(() => new ServerJobManager(client), [client])
  useEffect(() => {
    void manager.reconnectPersisted()
  }, [manager])
  return <ServerJobContext.Provider value={manager}>{children}</ServerJobContext.Provider>
}

export function ActiveServerJobs() {
  const manager = useContext(ServerJobContext)
  const [, render] = useState(0)
  useEffect(() => manager?.subscribe(() => render((value) => value + 1)), [manager])
  if (!manager) return null
  const jobs = manager.list().filter((entry) => entry.job)
  if (!jobs.length) return null
  return <section className="hud-panel mt-3 p-3" aria-label="Server jobs">
    <h2 className="hud-kicker">Server jobs</h2>
    <ul className="mt-2 space-y-1">
      {jobs.map((entry) => <JobRow key={entry.job!.id} entry={entry} cancel={() => manager.cancelLane(entry.lane)} acknowledge={() => manager.acknowledge(entry.job!.id)} />)}
    </ul>
  </section>
}

function JobRow({ entry, cancel, acknowledge }: { entry: ManagedServerJob; cancel: () => void; acknowledge: () => void }) {
  const terminal = entry.job && ['succeeded', 'failed', 'cancelled'].includes(entry.job.state)
  return <li className="flex flex-wrap items-center justify-between gap-2 font-mono text-xs">
    <span>{entry.lane} · {entry.job?.id} · {entry.job?.state} · {Math.round((entry.job?.progress ?? 0) * 100)}%</span>
    {entry.running
      ? <button className="hud-tab" type="button" onClick={cancel}>CANCEL</button>
      : terminal && <button className="hud-tab" type="button" onClick={acknowledge}>ACKNOWLEDGE</button>}
  </li>
}
