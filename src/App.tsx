import { useEffect, useRef, useState, useCallback } from 'react'
import { GestureRecognizer } from './services/GestureRecognizer'
import type { HandLandmarkerResult, NormalizedLandmark } from '@mediapipe/tasks-vision'

// Pointer tracking modes
type PointerMode = 'OFF' | 'FINGERTIP' | 'PALM' | 'WRIST' | 'RAYCAST' | 'NOSE'
const POINTER_MODES: PointerMode[] = ['OFF', 'FINGERTIP', 'PALM', 'WRIST', 'RAYCAST', 'NOSE']

// Z-INDEX LAYER SYSTEM (bottom to top)
const Z = {
  VIDEO: 1,
  CANVAS: 2,           // Hand skeleton overlay
  SCAN_LINE: 3,        // Animated scan effect
  PANELS: 10,          // Draggable panels
  CORNER_BRACKETS: 20, // Corner decoration
  HUD: 30,             // Status text, FPS, gesture guide
  STATS_PANEL: 40,     // Biometrics panel
  NETWORK_PANEL: 40,   // Network panel (same level as stats)
  POINTER: 50,         // The tracking dot
  ACTION_FEEDBACK: 60, // Full screen flash on action
} as const

// Electron IPC for system actions
declare global {
  interface Window {
    require: NodeRequire;
  }
}
const ipcRenderer = typeof window !== 'undefined' && window.require
  ? window.require('electron').ipcRenderer
  : null;

// Gesture to action mappings
const GESTURE_ACTIONS: Record<string, { action: string; label: string; app?: string }> = {
  'PEACE_SIGN': { action: 'screenshot', label: 'SCREENSHOT' },
  'POINTING_UP': { action: 'launch', label: 'CHROME', app: 'chrome' },
  'THREE_FINGERS': { action: 'launch', label: 'VS CODE', app: 'code' },
  'FOUR_FINGERS': { action: 'launch', label: 'SLACK', app: 'slack' },
  'THUMBS_UP': { action: 'launch', label: 'EXPLORER', app: 'explorer' },
  'ROCK_ON': { action: 'launch', label: 'TERMINAL', app: 'terminal' },
};

// Hand landmark connections (21 points)
const HAND_CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [0, 9], [9, 10], [10, 11], [11, 12],
  [0, 13], [13, 14], [14, 15], [15, 16],
  [0, 17], [17, 18], [18, 19], [19, 20],
  [5, 9], [9, 13], [13, 17]
]

// Fingertip landmark indices and labels
const FINGERTIP_LABELS: { index: number; label: string }[] = [
  { index: 4, label: 'THUMB' },
  { index: 8, label: 'INDEX' },
  { index: 12, label: 'MIDDLE' },
  { index: 16, label: 'RING' },
  { index: 20, label: 'PINKY' },
]

interface Panel {
  id: string
  x: number
  y: number
  label: string
  color: string
}

function App() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const recognizerRef = useRef<GestureRecognizer | null>(null)
  const [status, setStatus] = useState('Initializing...')
  const [faceDetected, setFaceDetected] = useState(false)
  const [panels, setPanels] = useState<Panel[]>([
    { id: '1', x: 100, y: 150, label: 'PANEL A', color: '#00FFFF' },
    { id: '2', x: 300, y: 150, label: 'PANEL B', color: '#FF00FF' },
    { id: '3', x: 500, y: 150, label: 'PANEL C', color: '#FFFF00' },
  ])
  const [grabbedPanel, setGrabbedPanel] = useState<string | null>(null)
  const [blendshapes, setBlendshapes] = useState<Record<string, number>>({})
  const [currentGesture, setCurrentGesture] = useState('UNKNOWN')
  const lastGestureRef = useRef<string>('UNKNOWN')
  const [fps, setFps] = useState(0)
  const frameTimesRef = useRef<number[]>([])
  const [scanLinePos, setScanLinePos] = useState(0)
  const [actionFeedback, setActionFeedback] = useState<{ label: string; success: boolean } | null>(null)
  const lastActionTimeRef = useRef(0)
  const lastLogTimeRef = useRef(0)
  const ACTION_COOLDOWN_MS = 2000

  // Network test state
  const [networkInfo, setNetworkInfo] = useState<{ hostname: string; ips: string[]; port: number } | null>(null)
  const [networkMessages, setNetworkMessages] = useState<Array<{ from: string; action: string; ip: string; time: string }>>([])
  const [showNetworkPanel, setShowNetworkPanel] = useState(true)

  // Pointer test mode
  const [pointerMode, setPointerMode] = useState<PointerMode>('OFF')
  const pointerModeRef = useRef<PointerMode>('OFF') // Ref for animation loop access
  const [pointerPos, setPointerPos] = useState<{ x: number; y: number } | null>(null)
  const [smoothedPos, setSmoothedPos] = useState<{ x: number; y: number } | null>(null)
  const noseLandmarkRef = useRef<{ x: number; y: number } | null>(null)
  const faceLandmarksRef = useRef<Array<{ x: number; y: number; z: number }> | null>(null)

  // Keep ref in sync with state (fixes stale closure in animation loop)
  useEffect(() => {
    pointerModeRef.current = pointerMode
  }, [pointerMode])

  // DRY RUN MODE
  const DRY_RUN = true

  // Calculate pointer position based on mode
  const calculatePointerPosition = useCallback((
    landmarks: NormalizedLandmark[] | null,
    mode: PointerMode
  ): { x: number; y: number } | null => {
    const w = window.innerWidth
    const h = window.innerHeight

    if (mode === 'NOSE') {
      const nose = noseLandmarkRef.current
      if (!nose) return null
      return {
        x: (1 - nose.x) * w,
        y: nose.y * h
      }
    }

    if (!landmarks) return null

    switch (mode) {
      case 'FINGERTIP': {
        // Index fingertip (landmark 8)
        const tip = landmarks[8]
        return { x: (1 - tip.x) * w, y: tip.y * h }
      }
      case 'PALM': {
        // Average of palm landmarks (0, 5, 9, 13, 17)
        const palmIndices = [0, 5, 9, 13, 17]
        const avgX = palmIndices.reduce((sum, i) => sum + landmarks[i].x, 0) / palmIndices.length
        const avgY = palmIndices.reduce((sum, i) => sum + landmarks[i].y, 0) / palmIndices.length
        return { x: (1 - avgX) * w, y: avgY * h }
      }
      case 'WRIST': {
        // Wrist (landmark 0)
        const wrist = landmarks[0]
        return { x: (1 - wrist.x) * w, y: wrist.y * h }
      }
      case 'RAYCAST': {
        // Line from wrist through index tip, projected to screen
        const wrist = landmarks[0]
        const tip = landmarks[8]
        // Direction vector
        const dx = tip.x - wrist.x
        const dy = tip.y - wrist.y
        // Extend the line (multiply direction by factor)
        const factor = 2.5
        const projX = tip.x + dx * factor
        const projY = tip.y + dy * factor
        // Clamp to screen
        return {
          x: Math.max(0, Math.min(w, (1 - projX) * w)),
          y: Math.max(0, Math.min(h, projY * h))
        }
      }
      default:
        return null
    }
  }, [])

  // NO SMOOTHING - just pass through directly for debugging
  useEffect(() => {
    if (!pointerPos) {
      setSmoothedPos(null)
      return
    }
    console.log('🎯 POINTER:', pointerMode, pointerPos.x.toFixed(0), pointerPos.y.toFixed(0))
    // Direct pass-through, no smoothing
    setSmoothedPos({ x: pointerPos.x, y: pointerPos.y })
  }, [pointerPos, pointerMode])

  // Keyboard controls for pointer mode (1-5 keys, 0 for off)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key >= '0' && e.key <= '5') {
        const index = parseInt(e.key)
        setPointerMode(POINTER_MODES[index])
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Network setup
  useEffect(() => {
    if (!ipcRenderer) return

    ipcRenderer.invoke('network-info').then(setNetworkInfo)

    const handleMessage = (_event: unknown, data: { from: string; action: string; ip: string }) => {
      setNetworkMessages(prev => [
        { ...data, time: new Date().toLocaleTimeString() },
        ...prev.slice(0, 9)
      ])
    }

    ipcRenderer.on('network-message', handleMessage)
    return () => {
      ipcRenderer.removeListener('network-message', handleMessage)
    }
  }, [])

  const sendPing = async () => {
    if (!ipcRenderer) return
    const result = await ipcRenderer.invoke('network-ping')
    console.log('Ping sent:', result)
  }

  // Main initialization
  useEffect(() => {
    const init = async () => {
      const rec = new GestureRecognizer()
      await rec.initialize()
      recognizerRef.current = rec
      setStatus('Ready')
      startCamera()
    }
    init()
  }, [])

  // Scan line animation
  useEffect(() => {
    const interval = setInterval(() => {
      setScanLinePos(prev => (prev + 2) % 100)
    }, 50)
    return () => clearInterval(interval)
  }, [])

  const executeGestureAction = useCallback(async (gesture: string) => {
    const now = Date.now()
    if (now - lastActionTimeRef.current < ACTION_COOLDOWN_MS) return

    const actionConfig = GESTURE_ACTIONS[gesture]
    if (!actionConfig) return

    lastActionTimeRef.current = now

    if (DRY_RUN) {
      console.log(`[DRY RUN] Would execute: ${actionConfig.action} - ${actionConfig.label}`)
      if (actionConfig.action === 'screenshot') {
        setActionFeedback({ label: 'WOULD: TAKE SCREENSHOT', success: true })
      } else if (actionConfig.action === 'launch' && actionConfig.app) {
        setActionFeedback({ label: `WOULD LAUNCH: ${actionConfig.label}`, success: true })
      }
    } else {
      if (!ipcRenderer) return
      try {
        if (actionConfig.action === 'screenshot') {
          const result = await ipcRenderer.invoke('take-screenshot')
          setActionFeedback({ label: 'SCREENSHOT CAPTURED', success: result.success })
        } else if (actionConfig.action === 'launch' && actionConfig.app) {
          const result = await ipcRenderer.invoke('launch-app', actionConfig.app)
          setActionFeedback({ label: `LAUNCHING: ${actionConfig.label}`, success: result.success })
        }
      } catch (error) {
        console.error('Action error:', error)
        setActionFeedback({ label: 'ACTION FAILED', success: false })
      }
    }

    setTimeout(() => setActionFeedback(null), 1500)
  }, [])

  const startCamera = async () => {
    if (videoRef.current) {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720 }
      })
      videoRef.current.srcObject = stream
      videoRef.current.addEventListener('loadeddata', () => {
        if (canvasRef.current && videoRef.current) {
          canvasRef.current.width = videoRef.current.videoWidth
          canvasRef.current.height = videoRef.current.videoHeight
        }
        predictWebcam()
      })
    }
  }

  const predictWebcam = async () => {
    const recognizer = recognizerRef.current
    if (!recognizer || !videoRef.current || !canvasRef.current) {
      requestAnimationFrame(predictWebcam)
      return
    }

    // FPS calculation
    const now = performance.now()
    frameTimesRef.current.push(now)
    if (frameTimesRef.current.length > 30) {
      frameTimesRef.current.shift()
    }
    if (frameTimesRef.current.length > 1) {
      const elapsed = now - frameTimesRef.current[0]
      const avgFps = Math.round((frameTimesRef.current.length - 1) / (elapsed / 1000))
      setFps(avgFps)
    }

    const video = videoRef.current
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
      requestAnimationFrame(predictWebcam)
      return
    }

    const results = recognizer.detect(video)
    setFaceDetected(recognizer.faceDetected)
    setBlendshapes(recognizer.blendshapes)
    noseLandmarkRef.current = recognizer.noseLandmark
    faceLandmarksRef.current = recognizer.faceLandmarks

    if (!recognizer.faceDetected) {
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (canvas && ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height)
      }
      setCurrentGesture('UNKNOWN')
      setPointerPos(null)
      requestAnimationFrame(predictWebcam)
      return
    }

    // Always draw (face landmarks even without hand)
    drawResults(results)

    if (results && results.landmarks.length > 0) {
      const gesture = recognizer.recognizeGestureWithHold(results.landmarks[0])
      const landmarks = results.landmarks[0]

      const handX = (1 - landmarks[0].x) * window.innerWidth
      const handY = landmarks[0].y * window.innerHeight

      setCurrentGesture(gesture)
      setStatus(`Hand: ${Math.round(handX)}, ${Math.round(handY)}`)

      if (gesture !== lastGestureRef.current && gesture !== 'UNKNOWN') {
        executeGestureAction(gesture)
      }

      if (gesture === 'CLOSED_FIST') {
        if (!grabbedPanel) {
          const nearPanel = panels.find(p =>
            Math.abs(p.x - handX) < 80 && Math.abs(p.y - handY) < 50
          )
          if (nearPanel) {
            setGrabbedPanel(nearPanel.id)
          }
        } else {
          setPanels(prev => prev.map(p =>
            p.id === grabbedPanel ? { ...p, x: handX, y: handY } : p
          ))
        }
      } else if (gesture === 'OPEN_PALM' && grabbedPanel) {
        setGrabbedPanel(null)
      }

      lastGestureRef.current = gesture
    }

    // Update pointer position based on mode - ALWAYS try if mode is on
    // Use ref to avoid stale closure issue with animation loop
    const currentMode = pointerModeRef.current
    if (currentMode !== 'OFF') {
      let pos: { x: number; y: number } | null = null

      if (currentMode === 'NOSE') {
        // Nose tracking uses face landmarks
        pos = calculatePointerPosition(null, currentMode)
      } else if (results && results.landmarks && results.landmarks.length > 0) {
        // Hand-based tracking
        pos = calculatePointerPosition(results.landmarks[0], currentMode)
      }

      if (pos) {
        setPointerPos(pos)
      }
    }

    // Log Z-values every second
    if (Date.now() - lastLogTimeRef.current > 1000) {
      const logData: any = { timestamp: new Date().toISOString() };
      let hasData = false;

      // Face Z stats
      if (recognizer.faceLandmarks) {
        const fl = recognizer.faceLandmarks;
        const zs = fl.map(l => l.z);
        logData.face = {
          nose_z: fl[1].z.toFixed(4),
          left_eye_z: fl[33].z.toFixed(4),
          right_eye_z: fl[263].z.toFixed(4),
          min_z: Math.min(...zs).toFixed(4),
          max_z: Math.max(...zs).toFixed(4),
          avg_z: (zs.reduce((a, b) => a + b, 0) / zs.length).toFixed(4)
        };
        hasData = true;
      }

      // Hand Z stats
      if (results && results.landmarks && results.landmarks.length > 0) {
        logData.hands = results.landmarks.map((hand, index) => {
          const zs = hand.map(l => l.z);
          return {
            index,
            wrist_z: hand[0].z.toFixed(4),
            index_tip_z: hand[8].z.toFixed(4),
            min_z: Math.min(...zs).toFixed(4),
            max_z: Math.max(...zs).toFixed(4),
            avg_z: (zs.reduce((a, b) => a + b, 0) / zs.length).toFixed(4)
          };
        });
        hasData = true;
      }

      if (hasData) {
        console.log('📍 BODY MARKER Z-STATS:', logData);
        lastLogTimeRef.current = Date.now();
      }
    }

    requestAnimationFrame(predictWebcam)
  }

  const drawResults = (results: HandLandmarkerResult | null) => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    const w = window.innerWidth
    const h = window.innerHeight

    // Only resize if needed to avoid flicker
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }

    // Clear the entire canvas
    ctx.clearRect(0, 0, w, h)

    // Draw face landmarks first (underneath hand)
    const faceLandmarks = faceLandmarksRef.current
    if (faceLandmarks) {
      // Key face landmark indices for a cleaner look
      // Jaw line: 10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109
      // Eyes: Left: 33, 133, 160, 159, 158, 144, 145, 153  Right: 362, 263, 387, 386, 385, 373, 374, 380
      // Eyebrows: Left: 70, 63, 105, 66, 107  Right: 336, 296, 334, 293, 300
      // Nose: 1, 2, 98, 327, 168
      // Lips outer: 61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146

      // Draw dots at key points only (not all 468)
      const keyPoints = [
        // Face oval
        10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
        // Left eye
        33, 133, 160, 159, 158, 144, 145, 153,
        // Right eye
        362, 263, 387, 386, 385, 373, 374, 380,
        // Left eyebrow
        70, 63, 105, 66, 107,
        // Right eyebrow
        336, 296, 334, 293, 300,
        // Nose
        1, 2, 98, 327, 168,
        // Lips
        61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146
      ]

      ctx.fillStyle = '#00FF00'
      for (const idx of keyPoints) {
        if (idx < faceLandmarks.length) {
          const lm = faceLandmarks[idx]
          const x = (1 - lm.x) * w
          const y = lm.y * h
          ctx.beginPath()
          ctx.arc(x, y, 2, 0, 2 * Math.PI)
          ctx.fill()
        }
      }

      // Draw face mesh connections for key features
      ctx.strokeStyle = '#00FF0060'
      ctx.lineWidth = 1

      // Left eye outline
      const leftEye = [33, 160, 159, 158, 144, 145, 153, 133, 33]
      ctx.beginPath()
      for (let i = 0; i < leftEye.length; i++) {
        const lm = faceLandmarks[leftEye[i]]
        const x = (1 - lm.x) * w
        const y = lm.y * h
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()

      // Right eye outline
      const rightEye = [362, 387, 386, 385, 373, 374, 380, 263, 362]
      ctx.beginPath()
      for (let i = 0; i < rightEye.length; i++) {
        const lm = faceLandmarks[rightEye[i]]
        const x = (1 - lm.x) * w
        const y = lm.y * h
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()

      // Lips outline
      const lips = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146, 61]
      ctx.strokeStyle = '#FF00FF60'
      ctx.beginPath()
      for (let i = 0; i < lips.length; i++) {
        const lm = faceLandmarks[lips[i]]
        const x = (1 - lm.x) * w
        const y = lm.y * h
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()

      // NOSE pointer mode - draw on face
      if (pointerModeRef.current === 'NOSE') {
        const nose = faceLandmarks[1] // Nose tip
        const pointerX = (1 - nose.x) * w
        const pointerY = nose.y * h

        // Draw big red crosshair
        ctx.strokeStyle = '#FF0000'
        ctx.lineWidth = 4
        ctx.beginPath()
        ctx.moveTo(pointerX - 50, pointerY)
        ctx.lineTo(pointerX + 50, pointerY)
        ctx.stroke()
        ctx.beginPath()
        ctx.moveTo(pointerX, pointerY - 50)
        ctx.lineTo(pointerX, pointerY + 50)
        ctx.stroke()

        ctx.fillStyle = '#FF0000'
        ctx.beginPath()
        ctx.arc(pointerX, pointerY, 20, 0, 2 * Math.PI)
        ctx.fill()

        ctx.strokeStyle = '#FFFF00'
        ctx.lineWidth = 3
        ctx.beginPath()
        ctx.arc(pointerX, pointerY, 20, 0, 2 * Math.PI)
        ctx.stroke()

        ctx.fillStyle = '#FFFFFF'
        ctx.beginPath()
        ctx.arc(pointerX, pointerY, 5, 0, 2 * Math.PI)
        ctx.fill()
      }
    }

    // Draw hand landmarks
    if (results?.landmarks) {
      for (const landmarks of results.landmarks) {
        const points = landmarks.map(lm => ({
          x: (1 - lm.x) * w,
          y: lm.y * h
        }))

        ctx.strokeStyle = '#00FFFF'
        ctx.lineWidth = 3
        for (const [start, end] of HAND_CONNECTIONS) {
          ctx.beginPath()
          ctx.moveTo(points[start].x, points[start].y)
          ctx.lineTo(points[end].x, points[end].y)
          ctx.stroke()
        }

        ctx.fillStyle = '#FF00FF'
        for (const point of points) {
          ctx.beginPath()
          ctx.arc(point.x, point.y, 8, 0, 2 * Math.PI)
          ctx.fill()
        }

        ctx.font = 'bold 12px monospace'
        ctx.textAlign = 'center'
        for (const { index, label } of FINGERTIP_LABELS) {
          const point = points[index]
          ctx.fillStyle = 'rgba(0, 0, 0, 0.7)'
          const textWidth = ctx.measureText(label).width
          ctx.fillRect(point.x - textWidth / 2 - 4, point.y - 28, textWidth + 8, 16)
          ctx.fillStyle = '#00FFFF'
          ctx.fillText(label, point.x, point.y - 16)
        }

        const wrist = points[0]
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)'
        const wristText = 'WRIST'
        const wristWidth = ctx.measureText(wristText).width
        ctx.fillRect(wrist.x - wristWidth / 2 - 4, wrist.y + 12, wristWidth + 8, 16)
        ctx.fillStyle = '#FF00FF'
        ctx.fillText(wristText, wrist.x, wrist.y + 24)

        // DRAW POINTER DIRECTLY ON CANVAS - bypasses all React/z-index issues
        const mode = pointerModeRef.current
        if (mode !== 'OFF') {
          let pointerX = 0, pointerY = 0

          if (mode === 'FINGERTIP') {
            pointerX = points[8].x
            pointerY = points[8].y
          } else if (mode === 'PALM') {
            pointerX = (points[0].x + points[5].x + points[9].x + points[13].x + points[17].x) / 5
            pointerY = (points[0].y + points[5].y + points[9].y + points[13].y + points[17].y) / 5
          } else if (mode === 'WRIST') {
            pointerX = points[0].x
            pointerY = points[0].y
          } else if (mode === 'RAYCAST') {
            const dx = points[8].x - points[0].x
            const dy = points[8].y - points[0].y
            pointerX = points[8].x + dx * 2.5
            pointerY = points[8].y + dy * 2.5
            // Clamp to screen
            pointerX = Math.max(0, Math.min(w, pointerX))
            pointerY = Math.max(0, Math.min(h, pointerY))
          }

          // Draw big red crosshair
          ctx.strokeStyle = '#FF0000'
          ctx.lineWidth = 4
          // Horizontal line
          ctx.beginPath()
          ctx.moveTo(pointerX - 50, pointerY)
          ctx.lineTo(pointerX + 50, pointerY)
          ctx.stroke()
          // Vertical line
          ctx.beginPath()
          ctx.moveTo(pointerX, pointerY - 50)
          ctx.lineTo(pointerX, pointerY + 50)
          ctx.stroke()

          // Draw center circle
          ctx.fillStyle = '#FF0000'
          ctx.beginPath()
          ctx.arc(pointerX, pointerY, 20, 0, 2 * Math.PI)
          ctx.fill()

          // Yellow border
          ctx.strokeStyle = '#FFFF00'
          ctx.lineWidth = 3
          ctx.beginPath()
          ctx.arc(pointerX, pointerY, 20, 0, 2 * Math.PI)
          ctx.stroke()

          // White center dot
          ctx.fillStyle = '#FFFFFF'
          ctx.beginPath()
          ctx.arc(pointerX, pointerY, 5, 0, 2 * Math.PI)
          ctx.fill()
        }
      }
    }
  }

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      width: '100vw',
      height: '100vh',
      overflow: 'hidden',
      background: 'rgba(0,0,0,0.8)'
    }}>
      {/* Scan Line Effect */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          zIndex: Z.SCAN_LINE,
          background: `linear-gradient(
            to bottom,
            transparent ${scanLinePos}%,
            rgba(0, 255, 255, 0.03) ${scanLinePos + 0.5}%,
            rgba(0, 255, 255, 0.08) ${scanLinePos + 1}%,
            rgba(0, 255, 255, 0.03) ${scanLinePos + 1.5}%,
            transparent ${scanLinePos + 2}%
          )`,
        }}
      />

      {/* Corner Brackets */}
      <div className="absolute top-4 left-4" style={{ width: 60, height: 60, pointerEvents: 'none', zIndex: Z.CORNER_BRACKETS }}>
        <div style={{ position: 'absolute', top: 0, left: 0, width: 20, height: 3, background: '#00FFFF' }} />
        <div style={{ position: 'absolute', top: 0, left: 0, width: 3, height: 20, background: '#00FFFF' }} />
      </div>
      <div className="absolute top-4 right-4" style={{ width: 60, height: 60, pointerEvents: 'none', zIndex: Z.CORNER_BRACKETS }}>
        <div style={{ position: 'absolute', top: 0, right: 0, width: 20, height: 3, background: '#00FFFF' }} />
        <div style={{ position: 'absolute', top: 0, right: 0, width: 3, height: 20, background: '#00FFFF' }} />
      </div>
      <div className="absolute bottom-4 left-4" style={{ width: 60, height: 60, pointerEvents: 'none', zIndex: Z.CORNER_BRACKETS }}>
        <div style={{ position: 'absolute', bottom: 0, left: 0, width: 20, height: 3, background: '#00FFFF' }} />
        <div style={{ position: 'absolute', bottom: 0, left: 0, width: 3, height: 20, background: '#00FFFF' }} />
      </div>
      <div className="absolute bottom-4 right-4" style={{ width: 60, height: 60, pointerEvents: 'none', zIndex: Z.CORNER_BRACKETS }}>
        <div style={{ position: 'absolute', bottom: 0, right: 0, width: 20, height: 3, background: '#00FFFF' }} />
        <div style={{ position: 'absolute', bottom: 0, right: 0, width: 3, height: 20, background: '#00FFFF' }} />
      </div>

      {/* HUD Overlay */}
      <div className="absolute top-8 left-8 font-mono" style={{ zIndex: Z.HUD }}>
        <h1 className="text-2xl font-bold tracking-widest" style={{ color: faceDetected ? '#00FFFF' : '#666' }}>
          JARVIS // {faceDetected ? 'ACTIVE' : 'STANDBY'}
        </h1>
        <p className="text-sm opacity-80" style={{ color: faceDetected ? '#00FFFF' : '#666' }}>
          {faceDetected ? status : 'Looking for face...'}
        </p>
        <p className="text-xs opacity-60 mt-2 text-cyan-400">
          Hold gesture 300ms to confirm
        </p>
      </div>

      {/* FPS Counter */}
      <div className="absolute bottom-8 left-8 font-mono text-xs" style={{ zIndex: Z.HUD }}>
        <span style={{ color: fps >= 24 ? '#00FF00' : fps >= 15 ? '#FFFF00' : '#FF0000' }}>
          {fps} FPS
        </span>
        <span className="text-gray-500 ml-2">| MediaPipe Vision</span>
      </div>

      {/* Pointer Mode Selector */}
      <div className="absolute top-8 left-1/2 transform -translate-x-1/2 font-mono" style={{ zIndex: Z.HUD }}>
        <div className="text-center mb-2 text-xs text-gray-400">POINTER TEST MODE (Press 0-5)</div>
        <div className="flex gap-2">
          {POINTER_MODES.map((mode, i) => (
            <button
              key={mode}
              onClick={() => setPointerMode(mode)}
              className="px-3 py-1 rounded text-xs font-bold transition-all"
              style={{
                background: pointerMode === mode ? '#00FFFF' : 'rgba(0,0,0,0.8)',
                color: pointerMode === mode ? '#000' : '#00FFFF',
                border: '1px solid #00FFFF',
              }}
            >
              {i}: {mode}
            </button>
          ))}
        </div>
        {pointerMode !== 'OFF' && (
          <div className="text-center mt-2 text-xs text-cyan-400">
            {pointerMode === 'FINGERTIP' && 'Tracking index fingertip (landmark 8)'}
            {pointerMode === 'PALM' && 'Tracking palm center (avg of landmarks 0,5,9,13,17)'}
            {pointerMode === 'WRIST' && 'Tracking wrist (landmark 0) - most stable'}
            {pointerMode === 'RAYCAST' && 'Raycast from wrist through fingertip - like aiming'}
            {pointerMode === 'NOSE' && 'Tracking nose tip - hands free!'}
          </div>
        )}
      </div>

      {/* DEBUG: Show pointer mode status */}
      <div
        className="absolute font-mono text-2xl font-bold"
        style={{
          top: 120,
          left: '50%',
          transform: 'translateX(-50%)',
          color: pointerMode === 'OFF' ? '#666' : (smoothedPos ? '#00FF00' : '#FF0000'),
          zIndex: 9999,
          background: 'rgba(0,0,0,0.9)',
          padding: '10px 20px',
          border: '3px solid',
          borderColor: pointerMode === 'OFF' ? '#666' : (smoothedPos ? '#00FF00' : '#FF0000'),
        }}
      >
        {pointerMode === 'OFF'
          ? 'POINTER OFF - Press 1-5'
          : (smoothedPos
            ? `${pointerMode}: ${Math.round(smoothedPos.x)}, ${Math.round(smoothedPos.y)}`
            : `${pointerMode}: NO DATA`)}
      </div>

      {/* Pointer Dot - HUGE AND RED */}
      {pointerMode !== 'OFF' && smoothedPos && (
        <>
          {/* MASSIVE outer glow */}
          <div
            className="absolute rounded-full pointer-events-none"
            style={{
              left: smoothedPos.x - 100,
              top: smoothedPos.y - 100,
              width: 200,
              height: 200,
              background: 'radial-gradient(circle, rgba(255,0,0,0.5) 0%, rgba(255,0,0,0.2) 40%, transparent 70%)',
              zIndex: 9998,
            }}
          />
          {/* BIG RED DOT */}
          <div
            className="absolute rounded-full pointer-events-none"
            style={{
              left: smoothedPos.x - 40,
              top: smoothedPos.y - 40,
              width: 80,
              height: 80,
              background: '#FF0000',
              boxShadow: '0 0 40px #FF0000, 0 0 80px #FF0000, 0 0 120px #FF0000',
              border: '5px solid #FFFF00',
              zIndex: 9999,
            }}
          />
          {/* Center crosshair */}
          <div
            className="absolute pointer-events-none"
            style={{
              left: smoothedPos.x - 2,
              top: smoothedPos.y - 2,
              width: 4,
              height: 4,
              background: '#FFFFFF',
              zIndex: 10000,
            }}
          />
          {/* Crosshair lines - THICK */}
          <div
            className="absolute pointer-events-none"
            style={{
              left: smoothedPos.x - 80,
              top: smoothedPos.y - 2,
              width: 60,
              height: 4,
              background: '#FFFF00',
              zIndex: 9999,
            }}
          />
          <div
            className="absolute pointer-events-none"
            style={{
              left: smoothedPos.x + 20,
              top: smoothedPos.y - 2,
              width: 60,
              height: 4,
              background: '#FFFF00',
              zIndex: 9999,
            }}
          />
          <div
            className="absolute pointer-events-none"
            style={{
              left: smoothedPos.x - 2,
              top: smoothedPos.y - 80,
              width: 4,
              height: 60,
              background: '#FFFF00',
              zIndex: 9999,
            }}
          />
          <div
            className="absolute pointer-events-none"
            style={{
              left: smoothedPos.x - 2,
              top: smoothedPos.y + 20,
              width: 4,
              height: 60,
              background: '#FFFF00',
              zIndex: 9999,
            }}
          />
          {/* Coordinates display - BIG */}
          <div
            className="absolute font-mono text-xl font-bold pointer-events-none"
            style={{
              left: smoothedPos.x + 50,
              top: smoothedPos.y + 50,
              color: '#FFFF00',
              background: 'rgba(0,0,0,0.9)',
              padding: '2px 6px',
              borderRadius: 4,
              zIndex: Z.POINTER,
            }}
          >
            {Math.round(smoothedPos.x)}, {Math.round(smoothedPos.y)}
          </div>
        </>
      )}

      {/* Action Feedback Overlay */}
      {actionFeedback && (
        <div
          className="absolute inset-0 flex items-center justify-center pointer-events-none"
          style={{
            background: actionFeedback.success ? 'rgba(0, 255, 255, 0.1)' : 'rgba(255, 0, 0, 0.1)',
            zIndex: Z.ACTION_FEEDBACK,
          }}
        >
          <div
            className="font-mono text-4xl font-bold tracking-widest animate-pulse"
            style={{
              color: actionFeedback.success ? '#00FFFF' : '#FF0000',
              textShadow: `0 0 30px ${actionFeedback.success ? '#00FFFF' : '#FF0000'}`,
            }}
          >
            {actionFeedback.label}
          </div>
        </div>
      )}

      {/* Gesture Guide */}
      <div className="absolute bottom-8 left-1/2 transform -translate-x-1/2 font-mono text-[10px] text-gray-500" style={{ zIndex: Z.HUD }}>
        <div className="flex gap-4">
          <span>PEACE = Screenshot</span>
          <span>POINT = Chrome</span>
          <span>3 = VS Code</span>
          <span>4 = Slack</span>
          <span>THUMB = Explorer</span>
          <span>ROCK = Terminal</span>
        </div>
      </div>

      {/* Video Feed */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100vw',
          height: '100vh',
          objectFit: 'cover',
          opacity: 0.5,
          transform: 'scaleX(-1)',
          pointerEvents: 'none',
          zIndex: Z.VIDEO,
        }}
      />

      {/* Canvas Overlay for Skeleton */}
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100vw',
          height: '100vh',
          pointerEvents: 'none',
          zIndex: Z.CANVAS,
        }}
      />

      {/* Stats Panel */}
      <div className="absolute top-20 right-8 font-mono text-xs" style={{
        background: 'rgba(0,0,0,0.85)',
        padding: '16px',
        borderRadius: '4px',
        border: '1px solid #00FFFF60',
        minWidth: '220px',
        boxShadow: '0 0 20px rgba(0, 255, 255, 0.1)',
        zIndex: Z.STATS_PANEL,
      }}>
        <div className="flex items-center gap-2 mb-3">
          <div className="w-2 h-2 rounded-full" style={{ background: faceDetected ? '#00FF00' : '#FF0000' }} />
          <span className="text-white font-bold tracking-wider">BIOMETRICS</span>
        </div>

        <div className="mb-3 pb-2" style={{ borderBottom: '1px solid #00FFFF30' }}>
          <span className="text-gray-400">Active Gesture:</span>
          <div className="text-lg font-bold mt-1" style={{ color: currentGesture !== 'UNKNOWN' ? '#00FFFF' : '#666' }}>
            {currentGesture}
          </div>
        </div>

        <div className="text-gray-400 mb-2 text-[10px] tracking-widest">FACIAL EXPRESSIONS</div>
        {['eyeBlinkLeft', 'eyeBlinkRight', 'mouthOpen', 'mouthSmileLeft', 'mouthSmileRight', 'browDownLeft', 'browDownRight', 'jawOpen'].map(key => (
          <div key={key} className="flex items-center gap-2 mb-1">
            <span className="text-gray-500 w-24 truncate text-[10px]">{key.replace(/([A-Z])/g, ' $1').trim()}</span>
            <div className="flex-1 h-1.5 bg-gray-800 rounded overflow-hidden">
              <div
                className="h-full transition-all duration-100"
                style={{
                  width: `${(blendshapes[key] || 0) * 100}%`,
                  background: `linear-gradient(90deg, #00FFFF, #FF00FF)`
                }}
              />
            </div>
            <span className="text-cyan-400 w-7 text-right text-[10px]">{((blendshapes[key] || 0) * 100).toFixed(0)}</span>
          </div>
        ))}
      </div>

      {/* Network Test Panel */}
      {showNetworkPanel && (
        <div className="absolute bottom-20 right-8 font-mono text-xs" style={{
          background: 'rgba(0,0,0,0.9)',
          padding: '16px',
          borderRadius: '4px',
          border: '1px solid #FF00FF60',
          minWidth: '280px',
          maxHeight: '300px',
          boxShadow: '0 0 20px rgba(255, 0, 255, 0.1)',
          zIndex: Z.NETWORK_PANEL,
          pointerEvents: 'auto',
        }}>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-purple-500 animate-pulse" />
              <span className="text-white font-bold tracking-wider">NETWORK TEST</span>
            </div>
            <button onClick={() => setShowNetworkPanel(false)} className="text-gray-500 hover:text-white">
              [X]
            </button>
          </div>

          <div className="mb-3 pb-2" style={{ borderBottom: '1px solid #FF00FF30' }}>
            <div className="text-gray-400 text-[10px] mb-1">THIS MACHINE</div>
            <div className="text-purple-400 font-bold">{networkInfo?.hostname || 'Loading...'}</div>
            <div className="text-gray-500 text-[10px]">
              {networkInfo?.ips.join(', ')} : {networkInfo?.port}
            </div>
          </div>

          <button
            type="button"
            onClick={sendPing}
            className="w-full mb-3 py-2 px-4 rounded font-bold tracking-wider transition-all hover:scale-105 active:scale-95"
            style={{
              background: 'linear-gradient(90deg, #FF00FF40, #00FFFF40)',
              border: '2px solid #FF00FF',
              color: '#FF00FF',
              cursor: 'pointer',
            }}
          >
            SEND PING
          </button>

          <div className="text-gray-400 text-[10px] mb-2 tracking-widest">INCOMING MESSAGES</div>
          <div style={{ maxHeight: '120px', overflowY: 'auto' }}>
            {networkMessages.length === 0 ? (
              <div className="text-gray-600 text-center py-2">No messages yet...</div>
            ) : (
              networkMessages.map((msg, i) => (
                <div key={i} className="mb-2 pb-2" style={{ borderBottom: '1px solid #333' }}>
                  <div className="flex justify-between">
                    <span className="text-purple-400 font-bold">{msg.action}</span>
                    <span className="text-gray-600">{msg.time}</span>
                  </div>
                  <div className="text-gray-500 text-[10px]">
                    from {msg.from} ({msg.ip})
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {!showNetworkPanel && (
        <button
          onClick={() => setShowNetworkPanel(true)}
          className="absolute bottom-8 right-8 font-mono text-xs py-2 px-4 rounded"
          style={{
            background: 'rgba(0,0,0,0.8)',
            border: '1px solid #FF00FF60',
            color: '#FF00FF',
            zIndex: Z.NETWORK_PANEL,
          }}
        >
          [NETWORK]
        </button>
      )}

      {/* Interactive Panels */}
      {panels.map(panel => (
        <div
          key={panel.id}
          className="absolute font-mono text-sm transition-transform duration-75"
          style={{
            left: panel.x - 60,
            top: panel.y - 30,
            width: 120,
            height: 60,
            border: `2px solid ${panel.color}`,
            backgroundColor: grabbedPanel === panel.id ? `${panel.color}40` : 'rgba(0,0,0,0.5)',
            boxShadow: grabbedPanel === panel.id ? `0 0 20px ${panel.color}` : 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: panel.color,
            borderRadius: 8,
            pointerEvents: 'none',
            zIndex: Z.PANELS,
          }}
        >
          {panel.label}
          {grabbedPanel === panel.id && (
            <span className="absolute -top-6 text-xs">GRABBED</span>
          )}
        </div>
      ))}
    </div>
  )
}

export default App
