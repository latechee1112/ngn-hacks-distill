import Icon from '../sidepanel/Icon'
import { PrimaryButton, QuietButton, Reveal, SecondaryButton, Shell } from './ui'

// Deliberately claims-free: everything here is something the extension
// actually does, phrased as the reassurance someone weighing "should I give
// this my camera" is looking for before they read the camera screen.
const CHIPS = [
  { icon: 'pulse', label: 'About a minute' },
  { icon: 'eye', label: 'Nothing is recorded' },
  { icon: 'check', label: 'No account needed' },
] as const

export default function WelcomeScreen({
  onStart,
  onSkip,
  onLoadProfile,
  importError,
  direction,
}: {
  onStart: () => void
  onSkip: () => void
  onLoadProfile: () => void
  importError: string
  // Reachable in both directions. It is the flow's first screen, but also
  // where the name screen's "back" lands, and that has to read as going back.
  direction: 'forward' | 'back'
}) {
  return (
    <Shell showGlow animKey="welcome" direction={direction}>
      <Reveal delay={0}>
        <h1 className="hero-title text-display font-semibold">Reading, tuned to you</h1>
      </Reveal>
      <Reveal delay={80}>
        <p className="max-w-md text-body text-on-surface-variant">
          A few quick tasks tell Distill how you scan a page, so it can pick spacing, contrast, and motion
          settings that actually work for you, instead of one-size-fits-all defaults.
        </p>
      </Reveal>
      <Reveal delay={160}>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {CHIPS.map((chip) => (
            <span
              key={chip.label}
              className="flex items-center gap-1.5 rounded-full border border-outline bg-surface/70 px-3 py-1.5 text-meta text-on-surface-variant"
            >
              <Icon name={chip.icon} className="h-3.5 w-3.5" />
              {chip.label}
            </span>
          ))}
        </div>
      </Reveal>
      <Reveal delay={240}>
        <div className="flex flex-wrap justify-center gap-3">
          <PrimaryButton onClick={onStart}>Get started</PrimaryButton>
          <SecondaryButton onClick={onSkip}>Skip for now</SecondaryButton>
        </div>
      </Reveal>
      <Reveal delay={320}>
        <div className="flex flex-col items-center gap-2 border-t border-outline/70 pt-5">
          <QuietButton onClick={onLoadProfile}>
            <Icon name="upload" />
            Already have a profile? Load it
          </QuietButton>
          {importError && (
            <p role="alert" className="max-w-sm text-meta text-danger-text">
              {importError}
            </p>
          )}
        </div>
      </Reveal>
    </Shell>
  )
}
