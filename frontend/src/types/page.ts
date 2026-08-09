// Wire contract with the backend's PageBlock/BoundingBox models
// (backend/models/common.py). Field names and shape must match exactly -
// the backend is the source of truth; this file follows it, not vice versa.

export type Landmark = 'main' | 'article' | 'nav' | 'aside' | 'header' | 'footer' | 'form' | 'dialog' | 'other'

export interface BoundingBox {
  x: number
  y: number
  width: number
  height: number
}

export interface PageBlock {
  blockId: string
  tag: string
  landmark?: Landmark
  role?: string
  text: string
  isInteractive: boolean
  isFormControl: boolean
  isFormInstruction: boolean
  isPasswordField: boolean
  isPaymentField: boolean
  isConsentControl: boolean
  isWarning: boolean
  isAd: boolean
  isStickyPromo: boolean
  isAutoplayMedia: boolean
  isRepeatedLink: boolean
  visible: boolean
  boundingBox?: BoundingBox
}

export interface ExtractionResult {
  url: string
  extractedAt: number
  blocks: PageBlock[]
  hasSensitiveForms: boolean
}
