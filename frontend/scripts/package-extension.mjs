// Zips frontend/dist (already built by `npm run build`) into docs/extension.zip,
// the file the GitHub Pages landing page links to for "Load unpacked" installs.
// Uses PowerShell's Compress-Archive since this project is developed on Windows;
// swap for `zip` if this ever needs to run on macOS/Linux CI.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..', '..')
const distDir = resolve(root, 'frontend', 'dist')
const docsDir = resolve(root, 'docs')
const zipPath = resolve(docsDir, 'extension.zip')

if (!existsSync(distDir)) {
  console.error('frontend/dist not found - run `npm run build` first.')
  process.exit(1)
}

mkdirSync(docsDir, { recursive: true })
rmSync(zipPath, { force: true })

execFileSync(
  'powershell.exe',
  ['-NoProfile', '-Command', `Compress-Archive -Path '${distDir}\\*' -DestinationPath '${zipPath}'`],
  { stdio: 'inherit' },
)

console.log(`Wrote ${zipPath}`)
