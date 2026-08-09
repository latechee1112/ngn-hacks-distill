// Snapshots className/inline-style before Distill touches an element, so any transform
// (local rules here, or backend TransformationActions later) can be undone exactly.
// Nodes are never removed - only class/style are ever mutated - so restoring these two
// values is always sufficient to put the page back exactly as it was.

interface OriginalSnapshot {
  className: string
  style: string
}

const originalMap = new Map<Element, OriginalSnapshot>()

export function saveOriginal(el: Element): void {
  if (originalMap.has(el)) return
  const htmlEl = el as HTMLElement
  originalMap.set(el, {
    className: htmlEl.className,
    style: htmlEl.getAttribute('style') || '',
  })
}

export function restoreAllOriginal(): void {
  originalMap.forEach((snapshot, el) => {
    const htmlEl = el as HTMLElement
    htmlEl.className = snapshot.className
    if (snapshot.style) {
      htmlEl.setAttribute('style', snapshot.style)
    } else {
      htmlEl.removeAttribute('style')
    }
  })
  originalMap.clear()
}

export function hasSavedOriginals(): boolean {
  return originalMap.size > 0
}

// A Map holds its keys strongly, so every element ever snapshotted stays reachable
// until restore clears the map. That is fine for a static page, but a virtualized
// feed recycles cards continuously - the ad observer snapshots each new one - and
// the map would pin every removed node for the lifetime of the page. Elements no
// longer in the document can never be restored anyway, so dropping them costs
// nothing. Called from the observer's rescan, where the churn actually happens.
export function pruneDetachedOriginals(): number {
  let removed = 0
  originalMap.forEach((_snapshot, el) => {
    if (!el.isConnected) {
      originalMap.delete(el)
      removed++
    }
  })
  return removed
}
