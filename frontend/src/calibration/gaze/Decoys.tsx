// Fake sidebar + ad shown alongside every trial. Both are clickable and feed
// CalibrationTrial.distractorClickCount (direct behavioral evidence for the
// backend's decoy-distraction rule) and, when the camera is on, the gaze
// hit-testing in hitTest.ts (which looks these two elements up by id, and they are large
// enough targets to be measurable against ~85-90px gaze error, unlike the
// in-grid click-target shapes).
//
// Explicitly labeled as test content so a misclick doesn't read as a bug.

export const DECOY_SIDEBAR_ID = 'distill-decoy-sidebar'
export const DECOY_AD_ID = 'distill-decoy-ad'

const TEST_BADGE_CLASS = 'text-[10px] font-semibold tracking-wide text-on-surface-muted uppercase'

function Decoys({ onDecoyClick }: { onDecoyClick: () => void }) {
  return (
    <>
      <div
        id={DECOY_SIDEBAR_ID}
        className="fixed top-24 left-6 hidden w-40 flex-col gap-2 rounded-md border border-outline bg-surface p-3 text-left lg:flex"
      >
        <span className={TEST_BADGE_CLASS}>Part of the test</span>
        <p className="text-meta font-medium text-on-surface">Related</p>
        {['Popular this week', 'Trending now', 'You might like'].map((label) => (
          <button
            key={label}
            type="button"
            onClick={onDecoyClick}
            className="rounded-sm px-1 py-0.5 text-left text-meta text-accent-text underline-offset-2 hover:underline"
          >
            {label}
          </button>
        ))}
      </div>

      <div
        id={DECOY_AD_ID}
        className="fixed right-6 bottom-24 hidden w-48 flex-col gap-2 rounded-md border border-outline bg-surface p-3 text-left lg:flex"
      >
        <span className={TEST_BADGE_CLASS}>Part of the test · Ad</span>
        <p className="text-meta font-medium text-on-surface">Special offer, just for you!</p>
        <button
          type="button"
          onClick={onDecoyClick}
          className="rounded-md bg-accent px-3 py-1.5 text-meta font-medium text-accent-fg hover:bg-accent-hover"
        >
          Learn More
        </button>
      </div>
    </>
  )
}

export default Decoys
