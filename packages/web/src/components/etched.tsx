import { useId, useLayoutEffect, useRef, useState, type ElementType, type HTMLAttributes, type ReactNode } from 'react'
import { TRANSITIONS, type TransitionAction } from '../hooks/useServerTransition'
import type { Server } from '../lib/api'
import { STATUS_LABELS, STEP_LABELS, STEP_ORDER } from '../lib/format'

/**
 * The etched parts (#174) — ported from the Rocky Surf design system's `handoff/etched.tsx`.
 *
 * Each takes its FORM from the logo, which is an engraving: the beam as swept arcs, water as
 * repeated strokes, rock as angular hatched mass, the moon as a hatched disc. All line work is
 * 0.9px in `currentColor`, and density — never fill — carries value, which is how the source
 * illustration carries tone.
 *
 * Two rules the design depends on, from `.claude/skills/rockysurf-design/SKILL.md`:
 *
 *  - **Caps label a field; they never carry a sentence.** The step labels below are cut in
 *    caps; the notice under a step (#129) is prose and is explicitly opted back out.
 *  - **A level needs its ceiling named beside it.** `Waterline` belongs on the spend cap and
 *    nowhere else; `Tally` exists because uptime has no ceiling and cannot honestly be a gauge.
 *
 * What changed in the port, and why:
 *
 *  - `Lamp` reads `STATUS_LABELS` and `TRANSITIONS` rather than carrying a third copy of the
 *    words — `lib/format` exists so two screens cannot disagree about what a status is called.
 *  - `Beacon` MEASURES its rows instead of assuming 30px each: the #129 notice sits under the
 *    active step and makes that row taller, and a beam drawn against fixed rows would cross the
 *    wrong labels the moment one row grew. It also takes `failed` (the create feed marks the
 *    step a bootstrap died on) and `notice`.
 *  - `Moon` uses `useId` for its mask, not `Math.random` — the same "never Math.random" rule
 *    `PackIcon`'s monogram follows, and a stable id is what a snapshot needs.
 *  - `Plate` takes `as` and forwards attributes, so it can BE the `.server-card` article and
 *    keep `data-status` where the stylesheet and the tests already read it.
 *
 * <EtchedDefs /> MUST BE MOUNTED ONCE per page (it is, in AppShell). Without it the strokes
 * still draw and only the hatch fills are missing.
 */

/** The page's one hatch pattern pair. Mounted once, in AppShell. */
export function EtchedDefs() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <defs>
        <pattern id="rs-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="5" stroke="currentColor" strokeWidth="0.9" />
        </pattern>
        <pattern id="rs-hatch-cross" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="5" stroke="currentColor" strokeWidth="0.9" />
          <line x1="0" y1="0" x2="5" y2="0" stroke="currentColor" strokeWidth="0.6" />
        </pattern>
      </defs>
    </svg>
  )
}

/* ── Lamp ──────────────────────────────────────────────────────────────────────────────
   Status as the lighthouse's own light. Replaces StatusBadge.

   A lit lamp throws swept arcs; a stopped one throws none; a failed one is a lens with the
   beam cut. The five product meanings survive in the colour: green acts, red refuses, the beam
   is "happening now". `data-status` IS STILL THE ROW'S OWN STATUS whatever the label reads, and
   `data-transition` still carries an unconfirmed stop/start — the same contract StatusBadge
   made, so nothing reading the DOM has to change. */

/** Legible on the night ground; the skin's own tints of the product's status colours. */
const LAMP_TONE = { green: '#7ee08f', beam: '#e8c37a', red: '#f8837d', ash: '#8a8494' }

const LAMP: Record<Server['status'], { arcs: number; tone: string; dash?: string; pulse?: boolean; cut?: boolean }> = {
  running: { arcs: 3, tone: LAMP_TONE.green },
  provisioning: { arcs: 2, tone: LAMP_TONE.beam, dash: '3 3', pulse: true },
  requested: { arcs: 1, tone: LAMP_TONE.beam, dash: '2 4', pulse: true },
  stopped: { arcs: 0, tone: LAMP_TONE.ash },
  failed: { arcs: 0, tone: LAMP_TONE.red, cut: true },
  terminated: { arcs: 0, tone: LAMP_TONE.ash, cut: true },
}

/** A stop or start the provider has accepted and not finished: two dashed arcs, pulsing. */
const LAMP_TRANSITION = { arcs: 2, tone: LAMP_TONE.beam, dash: '3 3', pulse: true }

export function Lamp({
  status,
  transition,
  children,
}: {
  status: Server['status']
  transition?: TransitionAction | null
  /** Overrides the label. The default is the product's own vocabulary. */
  children?: ReactNode
}) {
  const s = transition ? LAMP_TRANSITION : LAMP[status]
  const label = transition ? TRANSITIONS[transition].label : STATUS_LABELS[status]
  return (
    <span
      className="lamp"
      data-status={status}
      {...(transition ? { 'data-transition': transition } : {})}
      style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', color: s.tone }}
    >
      <svg width="30" height="18" viewBox="0 0 30 18" aria-hidden="true" style={{ overflow: 'visible', flexShrink: 0 }}>
        <circle cx="5" cy="9" r="3.4" fill={s.arcs > 0 ? 'url(#rs-hatch)' : 'none'} stroke="currentColor" strokeWidth="0.9" />
        {[0, 1, 2].map((i) => {
          const r = 4 + i * 2.6
          return (
            <path
              key={i}
              d={`M ${10 + i * 6} ${9 - r} A ${r} ${r} 0 0 1 ${10 + i * 6} ${9 + r}`}
              fill="none"
              stroke="currentColor"
              strokeWidth="0.9"
              strokeDasharray={s.dash}
              opacity={i < s.arcs ? 1 - i * 0.22 : 0.13}
              style={s.pulse && i === s.arcs - 1 ? { animation: 'rs-pulse 1.5s ease-in-out infinite' } : undefined}
            />
          )
        })}
        {'cut' in s && s.cut ? <line x1="1" y1="15" x2="13" y2="3" stroke="currentColor" strokeWidth="1.1" /> : null}
      </svg>
      <span style={{ fontSize: '0.64rem', fontWeight: 700, letterSpacing: '0.13em', textTransform: 'uppercase' }}>
        {children ?? label}
      </span>
    </span>
  )
}

/* ── Tally ─────────────────────────────────────────────────────────────────────────────
   Duration as tally strokes, one per hour, crossed at each fifth.

   Uptime has NO CEILING, so it cannot be a gauge: a bar or a curve implies an axis that does
   not exist. A tally counts, which is what "2h 14m" does. Sits BESIDE the value, never instead
   of it. Past `max` hours the count stops growing — the number beside it is still the fact. */
export function Tally({ hours, max = 18 }: { hours: number; max?: number }) {
  const whole = Math.min(Math.floor(hours), max)
  const part = hours - Math.floor(hours)
  const groups: number[] = []
  for (let i = 0; i < whole; i += 5) groups.push(Math.min(5, whole - i))
  const groupW = (n: number) => n * 4 + 6
  const width = Math.max(groups.reduce((a, n) => a + groupW(n), 0) + (part > 0.08 ? 7 : 0) + 2, 12)
  let x = 1
  return (
    <svg className="tally" width={width} height="16" viewBox={`0 0 ${width} 16`} aria-hidden="true">
      {groups.map((n, gi) => {
        const start = x
        x += groupW(n)
        return (
          <g key={gi}>
            {Array.from({ length: n }, (_, i) => (
              <line key={i} x1={start + i * 4} y1="2" x2={start + i * 4} y2="13" stroke="currentColor" strokeWidth="1.1" />
            ))}
            {n === 5 ? (
              <line x1={start - 1.5} y1="12.5" x2={start + 17.5} y2="2.5" stroke="currentColor" strokeWidth="1.1" />
            ) : null}
          </g>
        )
      })}
      {part > 0.08 ? <line x1={x} y1="6" x2={x} y2="13" stroke="currentColor" strokeWidth="1.1" opacity="0.55" /> : null}
      {whole === 0 && part <= 0.08 ? (
        <line x1="1" y1="9" x2="9" y2="9" stroke="currentColor" strokeWidth="1.1" opacity="0.3" />
      ) : null}
    </svg>
  )
}

/* ── Waterline ─────────────────────────────────────────────────────────────────────────
   A level against a ceiling. ONLY for a quantity whose ceiling is named beside it, which in
   this product is spend against the cap. On a server card there is no room to state the cap,
   so the cost stays a plain number there; a level without its ceiling is decoration. */
export function Waterline({ fraction, width = 92 }: { fraction: number; width?: number }) {
  const f = Math.max(0, Math.min(1, fraction))
  const w = width * f
  return (
    <svg width={width} height="18" viewBox={`0 0 ${width} 18`} aria-hidden="true" style={{ display: 'block' }}>
      <rect x="0" y="3" width={width} height="9" fill="none" stroke="currentColor" strokeWidth="0.9" opacity="0.32" />
      {w > 1 ? <rect x="0.5" y="3.5" width={Math.max(0, w - 1)} height="8" fill="url(#rs-hatch)" opacity="0.85" /> : null}
      {w > 6 ? <path d={`M ${w} 3 q -2 2.4 -4 0 q -2 -2.4 -4 0`} fill="none" stroke="currentColor" strokeWidth="1.1" /> : null}
      {[0, 0.25, 0.5, 0.75, 1].map((t) => (
        <line
          key={t}
          x1={t * width}
          y1="13"
          x2={t * width}
          y2={t === 0 || t === 1 ? 18 : 16}
          stroke="currentColor"
          strokeWidth="0.9"
          opacity="0.45"
        />
      ))}
    </svg>
  )
}

/* ── Moon ──────────────────────────────────────────────────────────────────────────────
   A fraction as a lunar phase. Built as a mask rather than one clever path: the right limb is
   always lit, and the terminator ellipse either eats into it (crescent, below half) or reaches
   across it (gibbous, above), so the disc never reads as a pie slice. */
export function Moon({ fraction, size = 46 }: { fraction: number; size?: number }) {
  const f = Math.max(0, Math.min(1, fraction))
  const r = size / 2 - 2
  const c = size / 2
  const rx = Math.abs(1 - 2 * f) * r
  const id = useId()
  const maskId = `rs-moon${id.replace(/[^a-zA-Z0-9_-]/g, '')}`
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" style={{ display: 'block' }}>
      <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={size} height={size}>
        <circle cx={c} cy={c} r={r} fill="#fff" />
        <rect x="0" y="0" width={c} height={size} fill="#000" />
        <ellipse cx={c} cy={c} rx={rx} ry={r} fill={f <= 0.5 ? '#000' : '#fff'} />
      </mask>
      <circle cx={c} cy={c} r={r} fill="none" stroke="currentColor" strokeWidth="0.9" opacity="0.45" />
      <g mask={`url(#${maskId})`}>
        <circle cx={c} cy={c} r={r} fill="url(#rs-hatch-cross)" />
        <circle cx={c} cy={c} r={r} fill="none" stroke="currentColor" strokeWidth="0.9" />
      </g>
    </svg>
  )
}

/* ── Beacon ────────────────────────────────────────────────────────────────────────────
   The provisioning timeline as the beam itself. Replaces the `.step-list` rail.

   Steps and labels come from `lib/format`, not from a third copy of the list; the create feed
   passes its own wordier labels through `labels`. An unrecognised `current` leaves the beam
   unlit rather than resetting it — the same rule the rail followed. The list still emits
   `.step-list`, `.step`, `.step-<state>`, `data-state` and `aria-current`, so the tests that
   read the timeline read this one unchanged. */

/** Row height before a notice makes one taller; also the jsdom fallback, which cannot measure. */
const BEACON_ROW = 30
const BEACON_SVG_W = 120
const BEACON_LABEL_LEFT = 132

export function Beacon({
  current,
  steps = STEP_ORDER,
  labels = STEP_LABELS,
  failed = false,
  notice,
}: {
  current?: string
  steps?: readonly string[]
  labels?: Record<string, string>
  /** The bootstrap died on `current`: that row reads failed and the beam stops there. */
  failed?: boolean
  /** One line of prose under the active step while it waits or has gone quiet (#129, #205). */
  notice?: string | null
}) {
  const reached = current ? steps.indexOf(current) : -1
  const frame = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLOListElement>(null)
  const [geometry, setGeometry] = useState<{ height: number; centres: number[] } | null>(null)

  // Measured after every render that can change a row's height. jsdom reports zeros, which is
  // the cue to keep the fixed-row estimate rather than draw a zero-height beam.
  useLayoutEffect(() => {
    const ol = list.current
    const box = frame.current
    if (!ol || !box || box.offsetHeight === 0) return
    const centres = Array.from(ol.children, (li) => {
      const el = li as HTMLElement
      return el.offsetTop + el.offsetHeight / 2
    })
    setGeometry({ height: box.offsetHeight, centres })
  }, [steps, current, notice, failed])

  const height = geometry?.height ?? steps.length * BEACON_ROW + 10
  const centre = (i: number) => geometry?.centres[i] ?? i * BEACON_ROW + BEACON_ROW / 2 + 5
  const beamFoot = reached < 0 ? 8 : centre(reached) + 18

  return (
    <div className="beacon" ref={frame} style={{ position: 'relative' }}>
      <svg
        width={BEACON_SVG_W}
        height={height}
        viewBox={`0 0 ${BEACON_SVG_W} ${height}`}
        aria-hidden="true"
        style={{ position: 'absolute', left: 0, top: 0, color: LAMP_TONE.beam }}
      >
        {/* The shore the tower stands on, the tower, its gallery, the lamp room. */}
        <path
          d={`M 2 ${height} L 8 ${height - 26} L 18 ${height - 34} L 30 ${height - 22} L 40 ${height - 30} L 44 ${height} Z`}
          fill="url(#rs-hatch)"
          stroke="currentColor"
          strokeWidth="0.9"
          opacity="0.4"
        />
        <path
          d={`M 17 17 L 13 ${height - 30} L 33 ${height - 30} L 29 17 Z`}
          fill="none"
          stroke="currentColor"
          strokeWidth="0.9"
          opacity="0.4"
        />
        <path d="M 14 17 L 32 17" stroke="currentColor" strokeWidth="0.9" opacity="0.5" fill="none" />
        <rect x="17" y="5" width="12" height="12" fill="url(#rs-hatch)" stroke="currentColor" strokeWidth="0.9" opacity="0.85" />
        <path d="M 15 5 L 31 5 M 23 5 L 23 1" stroke="currentColor" strokeWidth="0.9" opacity="0.6" fill="none" />
        {/* The beam: as far down the list as the work has got. */}
        <path d={`M 31 10 L 118 ${beamFoot} L 118 2 Z`} fill="url(#rs-hatch)" opacity="0.3" />
        {steps.map((step, i) => {
          const isFailed = failed && i === reached
          const y = centre(i)
          return (
            <line
              key={step}
              x1="40"
              y1={y}
              x2="112"
              y2={y}
              stroke={isFailed ? LAMP_TONE.red : 'currentColor'}
              strokeWidth={i === reached ? 1.4 : 0.9}
              strokeDasharray={i > reached ? '2 4' : undefined}
              opacity={i < reached ? 0.7 : i === reached ? 1 : 0.2}
              style={i === reached && !isFailed ? { animation: 'rs-pulse 1.5s ease-in-out infinite' } : undefined}
            />
          )
        })}
      </svg>
      <ol className="step-list" ref={list} style={{ marginLeft: BEACON_LABEL_LEFT }}>
        {steps.map((step, i) => {
          const state = failed && i === reached ? 'failed' : i < reached ? 'done' : i === reached ? 'active' : 'pending'
          return (
            <li
              key={step}
              className={`step step-${state}`}
              data-state={state}
              aria-current={state === 'active' ? 'step' : undefined}
              style={{ minHeight: BEACON_ROW, fontWeight: state === 'active' ? 700 : 500 }}
            >
              {labels[step] ?? step}
              {state === 'active' && notice && (
                <span className="step-notice" role="status">
                  {notice}
                </span>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/** Swell — the section divider, said in the illustration's hand. ~0.22 inside a card. */
export function Swell({ opacity = 0.4 }: { opacity?: number }) {
  return (
    <svg
      className="swell"
      width="100%"
      height="9"
      viewBox="0 0 400 9"
      preserveAspectRatio="none"
      aria-hidden="true"
      style={{ display: 'block', color: LAMP_TONE.beam, opacity }}
    >
      <path
        d="M0 5 q 12.5 -4 25 0 t 25 0 t 25 0 t 25 0 t 25 0 t 25 0 t 25 0 t 25 0 t 25 0 t 25 0 t 25 0 t 25 0 t 25 0 t 25 0 t 25 0 t 25 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="0.9"
      />
    </svg>
  )
}

/** Shore — the empty state as the rock mass under a horizon. Replaces `.empty`. */
export function Shore({ children, ...rest }: { children?: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className="empty shore" style={{ padding: '2.5rem 2rem 0', overflow: 'hidden' }}>
      <p style={{ margin: '0 0 1.5rem', fontSize: '0.875rem' }}>{children}</p>
      <svg
        width="100%"
        height="74"
        viewBox="0 0 400 74"
        preserveAspectRatio="none"
        aria-hidden="true"
        style={{ display: 'block', color: LAMP_TONE.beam, margin: '0 -2rem', width: 'calc(100% + 4rem)' }}
      >
        <path
          d="M0 46 L 62 30 L 104 41 L 158 18 L 214 38 L 268 26 L 322 44 L 400 32 L 400 74 L 0 74 Z"
          fill="url(#rs-hatch)"
          stroke="currentColor"
          strokeWidth="0.9"
          opacity="0.5"
        />
      </svg>
    </div>
  )
}

/* ── Plate ─────────────────────────────────────────────────────────────────────────────
   The card as an engraved plate: a rule, an inset margin, and registration ticks at the
   corners. Reserve `lit` for state that is genuinely live — a running box. Every plate lit is
   no plate lit. */
export function Plate({
  as: Tag = 'div',
  children,
  lit,
  className,
  style,
  ...rest
}: {
  as?: ElementType
  children?: ReactNode
  lit?: boolean
} & HTMLAttributes<HTMLElement>) {
  const ink = lit ? 'rgba(232,195,122,.85)' : 'rgba(252,245,232,.42)'
  const tick = [
    `linear-gradient(${ink},${ink}) 0 0/11px 1px no-repeat`,
    `linear-gradient(${ink},${ink}) 0 0/1px 11px no-repeat`,
    `linear-gradient(${ink},${ink}) 100% 0/11px 1px no-repeat`,
    `linear-gradient(${ink},${ink}) 100% 0/1px 11px no-repeat`,
    `linear-gradient(${ink},${ink}) 0 100%/11px 1px no-repeat`,
    `linear-gradient(${ink},${ink}) 0 100%/1px 11px no-repeat`,
    `linear-gradient(${ink},${ink}) 100% 100%/11px 1px no-repeat`,
    `linear-gradient(${ink},${ink}) 100% 100%/1px 11px no-repeat`,
  ].join(',')
  return (
    <Tag
      {...rest}
      className={className ? `plate ${className}` : 'plate'}
      data-lit={lit ? '' : undefined}
      style={{
        position: 'relative',
        background: lit
          ? 'linear-gradient(148deg, rgba(232,195,122,.085) 0%, rgba(252,245,232,.012) 48%, rgba(0,0,0,.14) 100%), var(--rs-surface)'
          : 'linear-gradient(148deg, rgba(252,245,232,.045) 0%, rgba(252,245,232,.008) 46%, rgba(0,0,0,.12) 100%), var(--rs-surface)',
        border: '1px solid ' + (lit ? 'rgba(232,195,122,.5)' : 'rgba(252,245,232,.18)'),
        borderRadius: 0,
        padding: '1.1rem',
        ...style,
      }}
    >
      <div aria-hidden="true" style={{ position: 'absolute', inset: '4px', background: tick, pointerEvents: 'none' }} />
      {children}
    </Tag>
  )
}
