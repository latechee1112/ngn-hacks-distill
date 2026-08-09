import Icon from '../sidepanel/Icon'

// Shared chrome for every wizard screen. Extracted from App.tsx once the two
// intro screens grew real markup of their own - they import from here rather
// than from App.tsx, which would otherwise be a circular import.

// Not exported: this file is component-only so Fast Refresh keeps working
// (react-refresh/only-export-components). Other files in this folder keep
// their own local copy of the same string, as they did before this split.
const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-on-surface-variant focus-visible:ring-offset-2 focus-visible:ring-offset-background'

export function PrimaryButton({
  onClick,
  children,
  disabled,
  type = 'button',
}: {
  onClick?: () => void
  children: React.ReactNode
  disabled?: boolean
  type?: 'button' | 'submit'
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`cta-lift rounded-md bg-accent px-6 py-3 text-body font-medium text-accent-fg hover:bg-accent-hover disabled:cursor-wait disabled:opacity-60 ${FOCUS_RING}`}
    >
      {children}
    </button>
  )
}

export function SecondaryButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`cta-lift rounded-md border border-outline bg-surface px-6 py-3 text-body font-medium text-on-surface hover:bg-surface-hover ${FOCUS_RING}`}
    >
      {children}
    </button>
  )
}

/** Quiet text-only affordance - back links, "skip", file import. */
export function QuietButton({
  onClick,
  children,
  className = '',
}: {
  onClick: () => void
  children: React.ReactNode
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 rounded-md px-4 py-2 text-meta text-on-surface-variant transition-colors hover:text-on-surface ${FOCUS_RING} ${className}`}
    >
      {children}
    </button>
  )
}

/**
 * Staggered entrance for a screen's own elements. `delay` is the index-based
 * offset in ms; the animation itself (and its reduced-motion opt-out) lives in
 * index.css so nothing here has to branch on the media query.
 */
export function Reveal({
  delay = 0,
  className = '',
  children,
}: {
  delay?: number
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={`reveal ${className}`} style={{ '--delay': `${delay}ms` } as React.CSSProperties}>
      {children}
    </div>
  )
}

// The measured part of the wizard, as the person going through it experiences
// it. The welcome screen is deliberately absent: a progress rail on the very
// first screen reads as "you are already committed", which is exactly the
// wrong thing for a landing page whose other option is "skip for now".
const FLOW_STEPS = ['You', 'Camera', 'Calibrate', 'Practice', 'Tasks'] as const

export function StepRail({ current }: { current: number }) {
  return (
    <div className="flex flex-col items-center gap-2" aria-hidden="true">
      <div className="flex items-center gap-1.5">
        {FLOW_STEPS.map((label, i) => (
          <span
            key={label}
            className={`h-1 rounded-full transition-all duration-500 ease-out ${
              i === current
                ? 'w-8 bg-accent-text'
                : i < current
                  ? 'w-4 bg-accent-text/45'
                  : 'w-4 bg-outline-strong'
            }`}
          />
        ))}
      </div>
      <span className="text-meta text-on-surface-muted">
        Step {current + 1} of {FLOW_STEPS.length} · {FLOW_STEPS[current]}
      </span>
    </div>
  )
}

export function Shell({
  children,
  showGlow = false,
  wide = false,
  progress,
  animKey,
  direction = 'forward',
}: {
  children: React.ReactNode
  showGlow?: boolean
  // The task screens need more room than the reading screens: the spacing
  // trial's grid is 5 x 64px + 4 x 48px = 512px, exactly max-w-lg, which
  // would leave it wedged edge-to-edge with no breathing room at all. Prose
  // steps keep the narrower measure, which is easier to read.
  wide?: boolean
  /** Index into FLOW_STEPS, or omitted on screens outside the flow. */
  progress?: number
  // Changing this replays the enter animation. Passed explicitly (rather than
  // keying <Shell> itself from the caller) so the glow blooms and the outer
  // layout survive the step change - only the content block re-enters.
  animKey?: string
  direction?: 'forward' | 'back'
}) {
  return (
    <div className="relative isolate flex min-h-screen flex-col items-center justify-center gap-8 overflow-hidden bg-background px-6 py-16 text-center">
      {showGlow && (
        <>
          <div className="bg-glow bg-glow-top" aria-hidden="true" />
          <div className="bg-glow bg-glow-bottom" aria-hidden="true" />
        </>
      )}
      <div className="relative z-10 flex flex-col items-center gap-5">
        <div className="wordmark-in flex items-center gap-2 text-on-surface-variant">
          <Icon name="funnel" />
          <span className="text-meta font-semibold tracking-[0.08em] uppercase">Distill</span>
        </div>
        {progress !== undefined && <StepRail current={progress} />}
      </div>
      <div
        key={animKey}
        data-dir={direction}
        className={`step-enter relative z-10 flex w-full flex-col items-center gap-6 ${
          wide ? 'max-w-3xl' : 'max-w-lg'
        }`}
      >
        {children}
      </div>
    </div>
  )
}
