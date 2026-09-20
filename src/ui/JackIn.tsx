import { ISA_META, type IsaId } from '../engine/types.ts'
import type { JackProgress } from '../engine/compare.ts'

const NODES: IsaId[] = ['riscv', 'arm', 'x86', 'mips', 'power', 'sparc', 'wasm', 'mos']

export function JackIn({ progress }: { progress: JackProgress }) {
  const pct = Math.max(0, Math.min(100, Math.round(progress.ratio * 100)))
  const circ = 2 * Math.PI * 52
  const dash = circ * (1 - progress.ratio)
  const lit = Math.round(progress.ratio * NODES.length)

  return (
    <div className="jack-inline" role="status" aria-live="polite">
      <div className="jack-meter">
        <svg viewBox="0 0 180 180" className="jack-svg" aria-hidden="true">
          <defs>
            <linearGradient id="jack-grad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#00f0ff" />
              <stop offset="50%" stopColor="#ff2bd6" />
              <stop offset="100%" stopColor="#c8ff3d" />
            </linearGradient>
          </defs>
          <polygon
            points="90,18 150,48 150,118 90,148 30,118 30,48"
            fill="none"
            stroke="rgba(0,240,255,0.25)"
            strokeWidth="1"
          />
          <polygon
            points="90,38 132,60 132,108 90,130 48,108 48,60"
            fill={`rgba(0,240,255,${0.04 + progress.ratio * 0.14})`}
            stroke="#ff2bd6"
            strokeOpacity="0.55"
          />
          <circle
            className="jack-spin"
            cx="90"
            cy="90"
            r="68"
            fill="none"
            stroke="rgba(255,43,214,0.22)"
            strokeWidth="1"
            strokeDasharray="6 10"
          />
          <circle
            className="jack-spin-rev"
            cx="90"
            cy="90"
            r="60"
            fill="none"
            stroke="rgba(0,240,255,0.28)"
            strokeWidth="1"
            strokeDasharray="3 8"
          />
          <circle
            cx="90"
            cy="90"
            r="52"
            fill="none"
            stroke="url(#jack-grad)"
            strokeWidth="6"
            strokeLinecap="square"
            strokeDasharray={circ}
            strokeDashoffset={dash}
            transform="rotate(-90 90 90)"
          />
          {NODES.map((id, i) => {
            const a = (i / NODES.length) * 2 * Math.PI - Math.PI / 2
            const x = 90 + Math.cos(a) * 78
            const y = 90 + Math.sin(a) * 78
            const on = i < lit
            return (
              <circle
                key={id}
                cx={x}
                cy={y}
                r={on ? 4.5 : 3}
                fill={on ? ISA_META[id].color : '#1a1024'}
                stroke={ISA_META[id].color}
                strokeWidth="1"
                opacity={on ? 1 : 0.35}
              />
            )
          })}
          <text
            x="90"
            y="86"
            textAnchor="middle"
            fill="#e8f6ff"
            fontFamily="Oxanium, sans-serif"
            fontSize="22"
            fontWeight="700"
          >
            {pct}
          </text>
          <text
            x="90"
            y="104"
            textAnchor="middle"
            fill="#00f0ff"
            fontFamily="Share Tech Mono, monospace"
            fontSize="8"
            letterSpacing="2"
          >
            PCT
          </text>
        </svg>
      </div>
      <div className="jack-inline-copy">
        <div className="hud-kicker">MODEL RUN · PIPELINE</div>
        <div className="jack-phase">{progress.phase}</div>
        <div className="jack-detail">{progress.detail}</div>
        <div className="jack-bar">
          <div className="jack-bar-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="jack-nodes">
          {NODES.map((id, i) => (
            <span
              key={id}
              style={{
                color: i < lit ? ISA_META[id].color : 'rgba(255,255,255,0.25)',
                textShadow: i < lit ? `0 0 8px ${ISA_META[id].color}` : undefined,
              }}
            >
              {ISA_META[id].short}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
