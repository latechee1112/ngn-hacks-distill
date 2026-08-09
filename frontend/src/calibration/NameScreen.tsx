import { useEffect, useRef, useState } from 'react'
import Icon from '../sidepanel/Icon'
import { USER_NAME_MAX_LENGTH } from '../types/calibration'
import { PrimaryButton, QuietButton, Reveal, Shell } from './ui'

// How long the "Nice to meet you" beat holds before advancing. Long enough to
// read, short enough that nobody waiting to get on with it feels held up -
// and skipped entirely under prefers-reduced-motion (see below).
const GREETING_MS = 900

export default function NameScreen({
  userName,
  onUserNameChange,
  onContinue,
  onBack,
}: {
  userName: string
  onUserNameChange: (value: string) => void
  onContinue: () => void
  onBack: () => void
}) {
  const [greeting, setGreeting] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const timerRef = useRef<number | undefined>(undefined)

  // Its own screen now, so the field is the one thing on it - focusing it lets
  // someone type and press Enter without touching the mouse at all.
  useEffect(() => {
    inputRef.current?.focus()
    return () => window.clearTimeout(timerRef.current)
  }, [])

  function submit() {
    const trimmed = userName.trim()
    // Blank is a perfectly good answer here (the name is only ever a display
    // label), so there is nobody to greet - go straight through.
    if (!trimmed) {
      onContinue()
      return
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onContinue()
      return
    }
    setGreeting(trimmed)
    timerRef.current = window.setTimeout(onContinue, GREETING_MS)
  }

  if (greeting) {
    return (
      <Shell showGlow animKey="greeting" progress={0}>
        <Reveal delay={0}>
          <div className="flex items-center gap-2 text-accent-text">
            <Icon name="check" />
            <h1 className="hero-title text-display font-semibold">Nice to meet you, {greeting}</h1>
          </div>
        </Reveal>
        <Reveal delay={120}>
          <p className="text-body text-on-surface-variant">Setting up your profile…</p>
        </Reveal>
      </Shell>
    )
  }

  return (
    <Shell showGlow animKey="name" progress={0}>
      <Reveal delay={0}>
        <h1 className="hero-title text-display font-semibold">What should we call you?</h1>
      </Reveal>
      <Reveal delay={80}>
        {/* Optional, and deliberately only a label: the profile card in the
            extension popup says whose profile is loaded, and "Calibrated to
            Sam" reads as yours in a way "Calibrated profile" does not. Nothing
            downstream branches on it. */}
        <p className="max-w-md text-body text-on-surface-variant">
          Just so your profile has a name on it. Optional - it never leaves this browser.
        </p>
      </Reveal>
      <Reveal delay={160} className="w-full">
        <form
          className="name-field mx-auto w-full max-w-sm"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <label htmlFor="distill-user-name" className="sr-only">
            What should we call you?
          </label>
          <input
            ref={inputRef}
            id="distill-user-name"
            type="text"
            value={userName}
            maxLength={USER_NAME_MAX_LENGTH}
            placeholder="Your name"
            autoComplete="given-name"
            onChange={(e) => onUserNameChange(e.target.value)}
            className="w-full bg-transparent px-1 py-3 text-center text-display font-semibold text-on-background placeholder:font-normal placeholder:text-on-surface-muted focus:outline-none"
          />
        </form>
      </Reveal>
      <Reveal delay={240}>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <PrimaryButton onClick={submit}>{userName.trim() ? 'Continue' : 'Skip this'}</PrimaryButton>
        </div>
      </Reveal>
      <Reveal delay={320}>
        <QuietButton onClick={onBack}>← Back</QuietButton>
      </Reveal>
    </Shell>
  )
}
