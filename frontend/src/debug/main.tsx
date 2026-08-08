import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
// Same stylesheet the calibration tab uses - this page is a full browser tab
// too, and shares its design tokens.
import '../calibration/index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
