// Inline SVG icon set. lucide-react isn't a dependency of this project, so
// these are hand-authored in the same style: 24x24 box, stroked paths, no
// fills, so a single stroke width and size read consistently everywhere.
// Every icon renders at 16px — do not size these per-instance.

const PATHS = {
  // Brand mark: a funnel, for "distill".
  funnel: ['M22 3H2l8 9.5V19l4 2v-8.5L22 3Z'],
  layers: ['M12 3 3 7.5l9 4.5 9-4.5L12 3Z', 'm3 16.5 9 4.5 9-4.5', 'm3 12 9 4.5 9-4.5'],
  restore: ['M3 12a9 9 0 1 0 2.6-6.4L3 8', 'M3 3v5h5'],
  user: ['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2', 'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z'],
  pulse: ['M22 12h-4l-3 8-6-16-3 8H2'],
  // Ascending bars — reads as "size going up", for the larger-text toggle.
  textSize: ['M4 20v-3', 'M9 20v-6', 'M14 20v-9', 'M19 20v-13'],
  eye: ['M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z'],
  droplet: ['M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5S12.5 4 12 2c-.5 2-2 4.9-4 6.5S5 13 5 15a7 7 0 0 0 7 7Z'],
  // Open 3/4 ring — pair with the `animate-spin` class for a loading spinner.
  spinner: ['M12 3a9 9 0 1 0 9 9'],
  check: ['m4 12 5 5L20 6'],
  // Tray with an arrow into it / out of it — saving and loading a calibration
  // file in the calibration wizard. Same tray path both ways so the pair reads
  // as one control set, with only the arrow reversed.
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M12 3v12', 'm7 10 5 5 5-5'],
  upload: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M12 15V3', 'm7 8 5-5 5 5'],
} as const

export type IconName = keyof typeof PATHS

function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return (
    <svg
      className={`h-4 w-4 shrink-0 ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}

export default Icon
