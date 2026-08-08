// webeyetrack@0.0.2's compiled bundle hardcodes two remote asset URLs with no
// exposed config to override them (backend/services/profile_rules.py's
// counterpart doesn't need this - this is purely a frontend packaging fix):
//   - MediaPipe's WASM glue, loaded via a <script src="..."> tag injection
//     (not fetch()), so it can't be intercepted at runtime - only a source
//     patch or a full vendor/fork of the package can redirect it.
//   - The face_landmarker .task model file.
// Both are blocked by an MV3 extension page's default script-src 'self' CSP
// anyway, and fetching them live would break the calibration page's own
// privacy claim ("nothing is ever sent anywhere"). This patches the
// installed package to point at the self-hosted copies in public/mediapipe/
// instead (see scripts/README or the calibration plan for how those were
// obtained). Runs automatically via package.json's "postinstall" so it
// survives a fresh `npm install`; idempotent, so re-running is harmless.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

// Resolve via real Node module resolution rather than a path relative to
// this script - npm can hoist webeyetrack up to a parent node_modules
// (e.g. the repo root) instead of frontend/node_modules, and a hardcoded
// path would silently miss it, leaving the unpatched CDN-loading bundle in
// whatever copy actually gets used.
const require = createRequire(import.meta.url)

let bundlePath
try {
  bundlePath = require.resolve('webeyetrack/dist/index.js')
} catch {
  // webeyetrack isn't installed (e.g. a partial/offline install) - nothing to patch.
  process.exit(0)
}

const REPLACEMENTS = [
  ['"https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm"', '"/mediapipe/wasm"'],
  [
    '"https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"',
    '"/mediapipe/face_landmarker.task"',
  ],
  // webeyetrack@0.0.2's pruneCalibData() drops evicted calibData.supportX/
  // supportY entries by reslicing the JS arrays, but never calls
  // tf.dispose() on the tf.Tensor objects those entries hold (eyePatches,
  // headVectors, faceOrigins3D, and the supportY tensor itself). Tensors
  // aren't garbage-collected by the JS GC - they hold WebGL texture / WASM
  // buffer memory that only frees on an explicit dispose(). Every dot
  // calibration and every correct trial click
  // (App.tsx's handleTargetHit -> registerCalibrationPoint -> adapt())
  // calls pruneCalibData() and adds new tensors, so the backend leaks a
  // little more GPU/WASM memory on every click. Over the ~9-point cap this
  // is exactly what the calibration-dot phase and the trial click test
  // both do continuously, which is why the gaze blob progressively lags a
  // few seconds into the click test - the leaked backend memory makes each
  // subsequent step()/adapt() call slower. Fix: dispose each dropped
  // entry's tensors before letting the array reslice drop the references.
  [
    'e.prototype.pruneCalibData=function(){var e=this;c.tidy(function(){e.calibData.supportX.length>e.maxPoints&&(e.calibData.supportX=e.calibData.supportX.slice(-e.maxPoints),e.calibData.supportY=e.calibData.supportY.slice(-e.maxPoints),e.calibData.timestamps=e.calibData.timestamps.slice(-e.maxPoints),e.calibData.ptType=e.calibData.ptType.slice(-e.maxPoints));var t=Date.now(),n=1e3*e.clickTTL,r=e.calibData.timestamps.map(function(r,s){return t-r<=n||"click"!==e.calibData.ptType[s]?s:-1}).filter(function(e){return-1!==e});e.calibData.supportX=r.map(function(t){return e.calibData.supportX[t]}),e.calibData.supportY=r.map(function(t){return e.calibData.supportY[t]}),e.calibData.timestamps=r.map(function(t){return e.calibData.timestamps[t]}),e.calibData.ptType=r.map(function(t){return e.calibData.ptType[t]})})}',
    'e.prototype.pruneCalibData=function(){var e=this;if(e.calibData.supportX.length>e.maxPoints){var dropped=e.calibData.supportX.slice(0,e.calibData.supportX.length-e.maxPoints),droppedY=e.calibData.supportY.slice(0,e.calibData.supportY.length-e.maxPoints);dropped.forEach(function(d){c.dispose([d.eyePatches,d.headVectors,d.faceOrigins3D])}),c.dispose(droppedY),e.calibData.supportX=e.calibData.supportX.slice(-e.maxPoints),e.calibData.supportY=e.calibData.supportY.slice(-e.maxPoints),e.calibData.timestamps=e.calibData.timestamps.slice(-e.maxPoints),e.calibData.ptType=e.calibData.ptType.slice(-e.maxPoints)}var t=Date.now(),n=1e3*e.clickTTL,r=e.calibData.timestamps.map(function(r,s){return t-r<=n||"click"!==e.calibData.ptType[s]?s:-1}).filter(function(e){return-1!==e}),keepSet={};r.forEach(function(idx){keepSet[idx]=!0}),e.calibData.supportX.forEach(function(d,idx){keepSet[idx]||c.dispose([d.eyePatches,d.headVectors,d.faceOrigins3D])}),e.calibData.supportY.forEach(function(d,idx){keepSet[idx]||c.dispose(d)}),e.calibData.supportX=r.map(function(t){return e.calibData.supportX[t]}),e.calibData.supportY=r.map(function(t){return e.calibData.supportY[t]}),e.calibData.timestamps=r.map(function(t){return e.calibData.timestamps[t]}),e.calibData.ptType=r.map(function(t){return e.calibData.ptType[t]})}',
  ],
  // WebcamClient._processFrames drives its frame pump off raw
  // requestAnimationFrame (up to 60Hz) and, on every single tick, calls
  // convertVideoFrameToImageData() - which creates a brand-new <canvas>,
  // draws the video frame into it, and does a synchronous getImageData()
  // pixel readback - *before* even checking whether useGazeTracker.ts's own
  // MIN_FRAME_INTERVAL_MS throttle (10Hz) will actually use the result. At
  // 60fps that's up to ~60 full-frame pixel-buffer allocations a second (a
  // 640x480 frame alone is ~1.2MB) thrown away unread ~5 out of 6 times -
  // enough garbage-collector churn that the tab visibly freezes a few
  // seconds in, once the heap pressure catches up. This is very likely the
  // actual freeze (previous patch here only fixed a slower-building tensor
  // leak in pruneCalibData, which is real but not the dominant cause).
  // Fix: gate the conversion+callback itself on an ~80ms interval (below
  // our own 100ms/10Hz throttle, so it never suppresses a frame the app
  // would have used) so the expensive canvas readback only happens when a
  // sample is actually going to be processed, not on every display frame.
  [
    'e.prototype._processFrames=function(){var e=this,t=function(){return r(e,void 0,void 0,function(){var e;return s(this,function(n){switch(n.label){case 0:return!this.videoElement||this.videoElement.paused||this.videoElement.ended?[2]:(e=(0,a.convertVideoFrameToImageData)(this.videoElement),this.frameCallback?[4,this.frameCallback(e,this.videoElement.currentTime)]:[3,2]);case 1:n.sent(),n.label=2;case 2:return requestAnimationFrame(t),[2]}})})};requestAnimationFrame(t)}',
    'e.prototype._processFrames=function(){var e=this;e.__lastFrameAt=0;var t=function(){return r(e,void 0,void 0,function(){var e,ts;return s(this,function(n){switch(n.label){case 0:return!this.videoElement||this.videoElement.paused||this.videoElement.ended?[2]:(ts=performance.now(),ts-this.__lastFrameAt<80?[3,2]:(this.__lastFrameAt=ts,e=(0,a.convertVideoFrameToImageData)(this.videoElement),this.frameCallback?[4,this.frameCallback(e,this.videoElement.currentTime)]:[3,2]));case 1:n.sent(),n.label=2;case 2:return requestAnimationFrame(t),[2]}})})};requestAnimationFrame(t)}',
  ],
]

let bundle = readFileSync(bundlePath, 'utf-8')

let changed = false
for (const [from, to] of REPLACEMENTS) {
  // The bundle references each URL from more than one call site, so a
  // single non-global replace used to leave one occurrence unpatched while
  // still looking "done" (the target string was present from the other
  // site) - split/join replaces every occurrence instead.
  if (bundle.includes(from)) {
    bundle = bundle.split(from).join(to)
    changed = true
    continue
  }
  if (!bundle.includes(to)) {
    console.warn(
      `[patch-webeyetrack] Expected string not found (package version changed?): ${from}. ` +
        'Camera-based calibration may try to reach the network - re-check this patch against the installed version.',
    )
  }
}

if (changed) {
  writeFileSync(bundlePath, bundle, 'utf-8')
  console.log('[patch-webeyetrack] Patched dist/index.js to use self-hosted MediaPipe assets.')
} else {
  console.log('[patch-webeyetrack] Already patched, nothing to do.')
}
