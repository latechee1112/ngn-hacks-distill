import { useCallback, useEffect, useRef, useState } from 'react'
import type { GazeResult } from 'webeyetrack'
import DotCalibration from '../calibration/gaze/DotCalibration'
import {
  buildGazeCalibrationFile,
  downloadGazeCalibrationFile,
  fitAffine,
  parseGazeCalibrationFile,
  residualError,
} from '../calibration/gaze/gazeCalibrationFile'
import { GAZE_VIDEO_ID, useGazeTracker } from '../calibration/gaze/useGazeTracker'
import FaceTrackDebugView from './FaceTrackDebugView'

// Standalone facetrack debug page. This used to be a 320px overlay in the
// corner of the calibration wizard, which was the wrong place for it twice
// over: it was too small to actually read the landmark scatter in, and it sat
// on top of the very screens whose timings and gaze targets the wizard exists
// to measure. Here it has the room to be legible and nothing it can corrupt.

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-on-surface-variant focus-visible:ring-offset-2 focus-visible:ring-offset-background'

// The reference grid filling the right half. Cells are big fixation targets
// with known centres, which is the whole point: look at one, and the screen
// plane panel should put the gaze ring in the matching place. The live
// highlight closes that loop without having to eyeball two panels at once.
const GRID_COLS = 6
const GRID_ROWS = 4
const COLUMN_LABELS = 'ABCDEF'

function ToolButton({
  onClick,
  children,
  disabled,
}: {
  onClick: () => void
  children: React.ReactNode
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md border border-outline bg-surface px-3 py-1.5 font-mono text-meta text-on-surface transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING}`}
    >
      {children}
    </button>
  )
}

function App() {
  const latestResultRef = useRef<GazeResult | null>(null)
  const showAnnotationsRef = useRef(true)
  const cellRefs = useRef<(HTMLButtonElement | null)[]>([])
  const gridRef = useRef<HTMLDivElement | null>(null)
  const startedRef = useRef(false)
  const [runningDots, setRunningDots] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const handleGazeSample = useCallback((result: GazeResult) => {
    latestResultRef.current = result
  }, [])

  const tracker = useGazeTracker(handleGazeSample)

  // The camera starts on load - opening this page IS the request for it.
  // Guarded because React 19's StrictMode runs effects twice in development,
  // and the second run would otherwise land inside the first's await on
  // WebEyeTrack.initialize(), before the tracker has marked itself active.
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    tracker.start(GAZE_VIDEO_ID).catch((err) => setError(err instanceof Error ? err.message : String(err)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'a' || event.key === 'A') showAnnotationsRef.current = !showAnnotationsRef.current
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Highlights whichever grid cell the current sample lands in. Done by
  // mutating style on the cells rather than through state: this runs on every
  // animation frame, and a re-render per frame would drag the whole page -
  // including the three canvases next door - down with it.
  useEffect(() => {
    let frameId = 0
    let highlighted: HTMLButtonElement | null = null
    const paint = () => {
      frameId = window.requestAnimationFrame(paint)
      const grid = gridRef.current
      const result = latestResultRef.current
      let next: HTMLButtonElement | null = null
      if (grid && result && result.gazeState === 'open') {
        const rect = grid.getBoundingClientRect()
        // normPog is viewport-normalized, so it has to become a viewport
        // pixel first - the grid is only half the page.
        const x = (result.normPog[0] + 0.5) * window.innerWidth - rect.left
        const y = (result.normPog[1] + 0.5) * window.innerHeight - rect.top
        if (x >= 0 && y >= 0 && x < rect.width && y < rect.height) {
          const col = Math.min(GRID_COLS - 1, Math.floor((x / rect.width) * GRID_COLS))
          const row = Math.min(GRID_ROWS - 1, Math.floor((y / rect.height) * GRID_ROWS))
          next = cellRefs.current[row * GRID_COLS + col] ?? null
        }
      }
      if (next !== highlighted) {
        if (highlighted) highlighted.style.backgroundColor = ''
        if (next) next.style.backgroundColor = 'rgba(34, 211, 238, 0.22)'
        highlighted = next
      }
    }
    frameId = window.requestAnimationFrame(paint)
    return () => {
      window.cancelAnimationFrame(frameId)
      if (highlighted) highlighted.style.backgroundColor = ''
    }
  }, [])

  // Clicking a cell is a free (position, was-looking-here) pair, exactly like
  // a correct trial click in the wizard - so the grid doubles as a way to add
  // calibration points anywhere on screen, not just at the nine dot
  // positions. maxSamples 4 summarises roughly the 400ms around the click:
  // a click says where the eye was at that moment, not over a whole dwell.
  function handleCellClick(index: number) {
    const cell = cellRefs.current[index]
    if (!cell) return
    const rect = cell.getBoundingClientRect()
    const nx = (rect.left + rect.width / 2) / window.innerWidth - 0.5
    const ny = (rect.top + rect.height / 2) / window.innerHeight - 0.5
    tracker.registerCalibrationPoint(nx, ny, 4)
    setNote(`Registered a point at ${COLUMN_LABELS[index % GRID_COLS]}${Math.floor(index / GRID_COLS) + 1}.`)
  }

  async function handleFileChosen(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget
    const picked = input.files?.[0]
    // Cleared first so re-picking the SAME path fires `change` again - Chrome
    // suppresses the event when the value is unchanged.
    input.value = ''
    if (!picked) return
    const parsed = parseGazeCalibrationFile(await picked.text())
    if (!parsed.ok) {
      setNote(`Couldn't load that file — ${parsed.error}.`)
      return
    }
    if (parsed.warning) console.warn('[Distill]', parsed.warning)
    tracker.setGazeCorrection(parsed.file.matrix, parsed.file.points)
    setNote(`Loaded a mapping fitted from ${parsed.file.points.length} points.`)
  }

  function handleSave() {
    const pairs = tracker.getCalibrationPairs()
    const matrix = tracker.getGazeCorrection() ?? fitAffine(pairs)
    if (!matrix) {
      setNote(`Couldn't fit a mapping from ${pairs.length} point${pairs.length === 1 ? '' : 's'}.`)
      return
    }
    downloadGazeCalibrationFile(buildGazeCalibrationFile(pairs, matrix))
    const meanError = residualError(matrix, pairs)
    setNote(
      `Saved ${pairs.length} points · mean error ${(meanError * 100).toFixed(1)}% of the viewport${
        meanError > 0.12 ? ' — high, consider redoing the dots' : ''
      }.`,
    )
  }

  return (
    <>
      {/* Must stay mounted for the tracker's whole lifetime, including while
          the dot overlay is up - see GAZE_VIDEO_ID in useGazeTracker.ts.
          Never shown directly: the panels draw their own copies of it. */}
      <video id={GAZE_VIDEO_ID} autoPlay muted playsInline className="sr-only" />
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={handleFileChosen}
      />

      <div className="flex h-screen w-screen overflow-hidden bg-background text-on-background">
        <div className="h-full w-1/2 shrink-0 border-r border-outline">
          <FaceTrackDebugView
            resultRef={latestResultRef}
            tracker={tracker}
            showAnnotationsRef={showAnnotationsRef}
          />
        </div>

        <div className="flex h-full w-1/2 min-w-0 flex-col">
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-outline px-4 py-3">
            <span className="font-mono text-meta text-on-surface-variant">facetrack debug</span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <ToolButton onClick={() => setRunningDots(true)} disabled={!tracker.ready}>
                Run 9 dots
              </ToolButton>
              <ToolButton onClick={() => fileInputRef.current?.click()}>Load calibration</ToolButton>
              <ToolButton onClick={handleSave}>Save calibration</ToolButton>
            </div>
          </div>

          <p className="shrink-0 px-4 py-2 font-mono text-meta text-on-surface-muted">
            {error
              ? `Camera error: ${error}`
              : note ||
                'Look at a cell to see it highlight · click one to register a calibration point · A toggles the overlay'}
          </p>

          <div
            ref={gridRef}
            className="grid min-h-0 flex-1 border-t border-outline"
            style={{
              gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${GRID_ROWS}, minmax(0, 1fr))`,
            }}
          >
            {Array.from({ length: GRID_COLS * GRID_ROWS }, (_, i) => (
              <button
                key={i}
                type="button"
                ref={(el) => {
                  cellRefs.current[i] = el
                }}
                onClick={() => handleCellClick(i)}
                className={`flex items-center justify-center border-r border-b border-outline font-mono text-meta text-on-surface-muted transition-colors hover:text-on-surface ${FOCUS_RING}`}
              >
                {COLUMN_LABELS[i % GRID_COLS]}
                {Math.floor(i / GRID_COLS) + 1}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Full-screen while it runs, deliberately: the dots have to be able to
          reach the corners of the viewport, which is what their fitted
          mapping is expressed in. */}
      {runningDots && (
        <DotCalibration
          tracker={tracker}
          onDone={() => setRunningDots(false)}
          onError={(message) => {
            setError(message)
            setRunningDots(false)
          }}
        />
      )}
    </>
  )
}

export default App
