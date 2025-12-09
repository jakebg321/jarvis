import { useEffect, useRef, useState, useCallback } from 'react'
import { GestureRecognizer } from './services/GestureRecognizer'
import type { HandLandmarkerResult, NormalizedLandmark } from '@mediapipe/tasks-vision'

// Z-INDEX LAYER SYSTEM
const Z = {
  VIDEO: 1,
  CANVAS: 2,
  SCAN_LINE: 3,
  PANELS: 10,
  CORNER_BRACKETS: 20,
  HUD: 30,
  STATS_PANEL: 40,
  NETWORK_PANEL: 40,
  POINTER: 9999,
  ACTION_FEEDBACK: 60,
} as const

// Precision mode settings
const PRECISION_SLOWDOWN = 0.25
const PINCH_THRESHOLD = 0.06

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

const SMOOTHING = 0.4

function App() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const recognizerRef = useRef<GestureRecognizer | null>(null)

  // Core state
  const [status, setStatus] = useState('Initializing...')
  const [faceDetected, setFaceDetected] = useState(false)
  const [blendshapes, setBlendshapes] = useState<Record<string, number>>({})
  const [currentGesture, setCurrentGesture] = useState('UNKNOWN')
  const [fps, setFps] = useState(0)
  const [scanLinePos, setScanLinePos] = useState(0)
  const [actionFeedback, setActionFeedback] = useState<{ label: string; success: boolean } | null>(null)

  // Panels
  const [panels, setPanels] = useState<Panel[]>([
    { id: '1', x: 100, y: 150, label: 'PANEL A', color: '#00FFFF' },
    { id: '2', x: 300, y: 150, label: 'PANEL B', color: '#FF00FF' },
    { id: '3', x: 500, y: 150, label: 'PANEL C', color: '#FFFF00' },
  ])
  const [grabbedPanel, setGrabbedPanel] = useState<string | null>(null)

  // Network
  const [networkInfo, setNetworkInfo] = useState<{ hostname: string; ips: string[]; port: number } | null>(null)
  const [networkMessages, setNetworkMessages] = useState<Array<{ from: string; action: string; ip: string; time: string }>>([])
  const [showNetworkPanel, setShowNetworkPanel] = useState(true)

  // Pointer state - inline, no hook bullshit
  const [pointerPos, setPointerPos] = useState<{ x: number; y: number } | null>(null)
  const [isPrecisionMode, setIsPrecisionMode] = useState(false)
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null)

  // Refs
  const lastGestureRef = useRef<string>('UNKNOWN')
  const frameTimesRef = useRef<number[]>([])
  const lastActionTimeRef = useRef(0)
  const smoothedFaceLandmarksRef = useRef<Array<{ x: number; y: number; z: number }> | null>(null)
  const smoothedHandLandmarksRef = useRef<Array<Array<{ x: number; y: number }>> | null>(null)

  const ACTION_COOLDOWN_MS = 2000
  const DRY_RUN = true

  // Check if pinching
  const checkPinch = useCallback((landmarks: NormalizedLandmark[]): boolean => {
    const thumb = landmarks[4]
    const index = landmarks[8]
    const dist = Math.hypot(thumb.x - index.x, thumb.y - index.y)
    return dist < PINCH_THRESHOLD
  }, [])

  // Update pointer position
  const updatePointer = useCallback((landmarks: NormalizedLandmark[]) => {
    const w = window.innerWidth
    const h = window.innerHeight
    const precision = checkPinch(landmarks)
    setIsPrecisionMode(precision)

    // RAYCAST
    const wrist = landmarks[0]
    const tip = landmarks[8]
    const dx = tip.x - wrist.x
    const dy = tip.y - wrist.y
    const factor = 2.5
    const projX = tip.x + dx * factor
    const projY = tip.y + dy * factor

    let newX = Math.max(0, Math.min(w, (1 - projX) * w))
    let newY = Math.max(0, Math.min(h, projY * h))

    if (precision && lastPointerRef.current) {
      const last = lastPointerRef.current
      newX = last.x + (newX - last.x) * PRECISION_SLOWDOWN
      newY = last.y + (newY - last.y) * PRECISION_SLOWDOWN
    }

    lastPointerRef.current = { x: newX, y: newY }
    setPointerPos({ x: newX, y: newY })
  }, [checkPinch])

  // Smoothing function
  const smoothLandmarks = <T extends { x: number; y: number }>(
    current: T[] | null,
    previous: T[] | null,
    factor: number
  ): T[] | null => {
    if (!current) return null
    if (!previous || previous.length !== current.length) return current
    return current.map((curr, i) => {
      const prev = previous[i]
      return {
        ...curr,
        x: prev.x + (curr.x - prev.x) * (1 - factor),
        y: prev.y + (curr.y - prev.y) * (1 - factor),
      } as T
    })
  }

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
    return () => { ipcRenderer.removeListener('network-message', handleMessage) }
  }, [])

  const sendPing = async () => {
    if (!ipcRenderer) return
    await ipcRenderer.invoke('network-ping')
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
      if (actionConfig.action === 'screenshot') {
        setActionFeedback({ label: 'WOULD: TAKE SCREENSHOT', success: true })
      } else if (actionConfig.action === 'launch' && actionConfig.app) {
        setActionFeedback({ label: `WOULD LAUNCH: ${actionConfig.label}`, success: true })
      }
    } else if (ipcRenderer) {
      try {
        if (actionConfig.action === 'screenshot') {
          const result = await ipcRenderer.invoke('take-screenshot')
          setActionFeedback({ label: 'SCREENSHOT CAPTURED', success: result.success })
        } else if (actionConfig.action === 'launch' && actionConfig.app) {
          const result = await ipcRenderer.invoke('launch-app', actionConfig.app)
          setActionFeedback({ label: `LAUNCHING: ${actionConfig.label}`, success: result.success })
        }
      } catch {
        setActionFeedback({ label: 'ACTION FAILED', success: false })
      }
    }
    setTimeout(() => setActionFeedback(null), 1500)
  }, [])

  const startCamera = async () => {
    if (videoRef.current) {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } })
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
    if (frameTimesRef.current.length > 30) frameTimesRef.current.shift()
    if (frameTimesRef.current.length > 1) {
      const elapsed = now - frameTimesRef.current[0]
      setFps(Math.round((frameTimesRef.current.length - 1) / (elapsed / 1000)))
    }

    const video = videoRef.current
    if (!video || video.videoWidth === 0) {
      requestAnimationFrame(predictWebcam)
      return
    }

    const results = recognizer.detect(video)
    setFaceDetected(recognizer.faceDetected)
    setBlendshapes(recognizer.blendshapes)

    // Smooth face landmarks
    smoothedFaceLandmarksRef.current = smoothLandmarks(
      recognizer.faceLandmarks,
      smoothedFaceLandmarksRef.current,
      SMOOTHING
    )

    if (!recognizer.faceDetected) {
      const ctx = canvasRef.current?.getContext('2d')
      if (ctx) ctx.clearRect(0, 0, canvasRef.current!.width, canvasRef.current!.height)
      setCurrentGesture('UNKNOWN')
      requestAnimationFrame(predictWebcam)
      return
    }

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

      // Panel grabbing
      if (gesture === 'CLOSED_FIST') {
        if (!grabbedPanel) {
          const nearPanel = panels.find(p => Math.abs(p.x - handX) < 80 && Math.abs(p.y - handY) < 50)
          if (nearPanel) setGrabbedPanel(nearPanel.id)
        } else {
          setPanels(prev => prev.map(p => p.id === grabbedPanel ? { ...p, x: handX, y: handY } : p))
        }
      } else if (gesture === 'OPEN_PALM' && grabbedPanel) {
        setGrabbedPanel(null)
      }

      lastGestureRef.current = gesture

      // Update pointer
      updatePointer(results.landmarks[0])
    }

    requestAnimationFrame(predictWebcam)
  }

  const drawResults = (results: HandLandmarkerResult | null) => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    const w = window.innerWidth
    const h = window.innerHeight
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    ctx.clearRect(0, 0, w, h)

    // Draw face landmarks
    const faceLandmarks = smoothedFaceLandmarksRef.current
    if (faceLandmarks) {
      const keyPoints = [
        10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
        33, 133, 160, 159, 158, 144, 145, 153,
        362, 263, 387, 386, 385, 373, 374, 380,
        70, 63, 105, 66, 107,
        336, 296, 334, 293, 300,
        1, 2, 98, 327, 168,
        61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146
      ]

      ctx.fillStyle = '#00FF00'
      for (const idx of keyPoints) {
        if (idx < faceLandmarks.length) {
          const lm = faceLandmarks[idx]
          ctx.beginPath()
          ctx.arc((1 - lm.x) * w, lm.y * h, 8, 0, 2 * Math.PI)
          ctx.fill()
        }
      }

      // Eye outlines
      ctx.strokeStyle = '#00FF00'
      ctx.lineWidth = 3
      const drawPath = (indices: number[]) => {
        ctx.beginPath()
        indices.forEach((idx, i) => {
          const lm = faceLandmarks[idx]
          const x = (1 - lm.x) * w, y = lm.y * h
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
        })
        ctx.stroke()
      }
      drawPath([33, 160, 159, 158, 144, 145, 153, 133, 33])
      drawPath([362, 387, 386, 385, 373, 374, 380, 263, 362])

      // Lips
      ctx.strokeStyle = '#FF00FF'
      drawPath([61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146, 61])
    }

    // Draw hand landmarks
    if (results?.landmarks) {
      const currentHands = results.landmarks.map(landmarks =>
        landmarks.map(lm => ({ x: (1 - lm.x) * w, y: lm.y * h }))
      )

      if (!smoothedHandLandmarksRef.current || smoothedHandLandmarksRef.current.length !== currentHands.length) {
        smoothedHandLandmarksRef.current = currentHands
      } else {
        smoothedHandLandmarksRef.current = currentHands.map((hand, handIdx) => {
          const prevHand = smoothedHandLandmarksRef.current![handIdx]
          if (!prevHand || prevHand.length !== hand.length) return hand
          return hand.map((point, i) => ({
            x: prevHand[i].x + (point.x - prevHand[i].x) * (1 - SMOOTHING),
            y: prevHand[i].y + (point.y - prevHand[i].y) * (1 - SMOOTHING),
          }))
        })
      }

      for (const points of smoothedHandLandmarksRef.current) {
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
        const wristWidth = ctx.measureText('WRIST').width
        ctx.fillRect(wrist.x - wristWidth / 2 - 4, wrist.y + 12, wristWidth + 8, 16)
        ctx.fillStyle = '#FF00FF'
        ctx.fillText('WRIST', wrist.x, wrist.y + 24)
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
      {/* Scan Line */}
      <div style={{
        position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
        pointerEvents: 'none', zIndex: Z.SCAN_LINE,
        background: `linear-gradient(to bottom, transparent ${scanLinePos}%, rgba(0,255,255,0.03) ${scanLinePos + 0.5}%, rgba(0,255,255,0.08) ${scanLinePos + 1}%, rgba(0,255,255,0.03) ${scanLinePos + 1.5}%, transparent ${scanLinePos + 2}%)`,
      }} />

      {/* Status Header */}
      <div className="absolute top-8 left-8 font-mono" style={{ zIndex: Z.HUD }}>
        <h1 className="text-2xl font-bold tracking-widest" style={{ color: faceDetected ? '#00FFFF' : '#666' }}>
          JARVIS // {faceDetected ? 'ACTIVE' : 'STANDBY'}
        </h1>
        <p className="text-sm opacity-80" style={{ color: faceDetected ? '#00FFFF' : '#666' }}>
          {faceDetected ? status : 'Looking for face...'}
        </p>
      </div>

      {/* FPS */}
      <div className="absolute bottom-8 left-8 font-mono text-xs" style={{ zIndex: Z.HUD }}>
        <span style={{ color: fps >= 24 ? '#00FF00' : fps >= 15 ? '#FFFF00' : '#FF0000' }}>{fps} FPS</span>
      </div>

      {/* Pointer Status */}
      <div className="absolute top-8 left-1/2 transform -translate-x-1/2 font-mono" style={{ zIndex: Z.HUD }}>
        <div className="text-center text-sm" style={{ color: isPrecisionMode ? '#FF00FF' : '#00FF00' }}>
          {pointerPos ? `${isPrecisionMode ? 'PRECISION' : 'RAYCAST'}: ${Math.round(pointerPos.x)}, ${Math.round(pointerPos.y)}` : 'NO HAND'}
        </div>
        <div className="text-center text-xs text-cyan-400 mt-1">Point to aim • Pinch for precision</div>
      </div>

      {/* THE POINTER - BIG RED DOT */}
      {pointerPos && (
        <>
          <div style={{
            position: 'fixed',
            left: pointerPos.x - (isPrecisionMode ? 60 : 100),
            top: pointerPos.y - (isPrecisionMode ? 60 : 100),
            width: isPrecisionMode ? 120 : 200,
            height: isPrecisionMode ? 120 : 200,
            background: isPrecisionMode
              ? 'radial-gradient(circle, rgba(255,0,255,0.6) 0%, rgba(255,0,255,0.2) 40%, transparent 70%)'
              : 'radial-gradient(circle, rgba(255,0,0,0.5) 0%, rgba(255,0,0,0.2) 40%, transparent 70%)',
            borderRadius: '50%',
            pointerEvents: 'none',
            zIndex: Z.POINTER,
          }} />
          <div style={{
            position: 'fixed',
            left: pointerPos.x - (isPrecisionMode ? 15 : 40),
            top: pointerPos.y - (isPrecisionMode ? 15 : 40),
            width: isPrecisionMode ? 30 : 80,
            height: isPrecisionMode ? 30 : 80,
            background: isPrecisionMode ? '#FF00FF' : '#FF0000',
            boxShadow: isPrecisionMode ? '0 0 20px #FF00FF' : '0 0 40px #FF0000, 0 0 80px #FF0000',
            border: isPrecisionMode ? '3px solid #FFF' : '5px solid #FFFF00',
            borderRadius: '50%',
            pointerEvents: 'none',
            zIndex: Z.POINTER + 1,
          }} />
          <div style={{
            position: 'fixed',
            left: pointerPos.x - 2,
            top: pointerPos.y - 2,
            width: 4,
            height: 4,
            background: '#FFFFFF',
            pointerEvents: 'none',
            zIndex: Z.POINTER + 2,
          }} />
        </>
      )}

      {/* Action Feedback */}
      {actionFeedback && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{ background: actionFeedback.success ? 'rgba(0,255,255,0.1)' : 'rgba(255,0,0,0.1)', zIndex: Z.ACTION_FEEDBACK }}>
          <div className="font-mono text-4xl font-bold tracking-widest animate-pulse" style={{ color: actionFeedback.success ? '#00FFFF' : '#FF0000' }}>{actionFeedback.label}</div>
        </div>
      )}

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
    </div>
  )
}

export default App
