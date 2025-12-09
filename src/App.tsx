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

// Default pointer settings (will be controlled by sliders)
const DEFAULT_RAYCAST_FACTOR = 2.5
const DEFAULT_PRECISION_SLOWDOWN = 0.25
const DEFAULT_SMOOTHING = 0.4

// Electron IPC for system actions
declare global {
  interface Window {
    require: NodeRequire;
  }
}
const ipcRenderer = typeof window !== 'undefined' && window.require
  ? window.require('electron').ipcRenderer
  : null;


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

function App() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const recognizerRef = useRef<GestureRecognizer | null>(null)

  // Core state - only things that NEED to trigger re-renders
  const [status, setStatus] = useState('Initializing...')
  const [actionFeedback, setActionFeedback] = useState<{ label: string; success: boolean } | null>(null)

  // High-frequency values stored in refs to avoid re-renders
  const faceDetectedRef = useRef(false)
  const currentGestureRef = useRef('UNKNOWN')
  const fpsRef = useRef(0)
  const scanLinePosRef = useRef(0)
  const gpuUsageRef = useRef(0)

  // Slider-controlled settings
  const [settings, setSettings] = useState({
    raycastFactor: DEFAULT_RAYCAST_FACTOR,
    precisionSlowdown: DEFAULT_PRECISION_SLOWDOWN,
    smoothing: DEFAULT_SMOOTHING,
    activeHand: 'right' as 'left' | 'right',
  })
  const [showSettings, setShowSettings] = useState(false)

  // Command mode state
  const [commandMode, setCommandMode] = useState(false)
  const frozenPointerRef = useRef<{ x: number; y: number } | null>(null)

  // Display state - updated at throttled rate for UI
  const [displayState, setDisplayState] = useState({
    faceDetected: false,
    currentGesture: 'UNKNOWN',
    fps: 0,
    scanLinePos: 0,
    pointerPos: null as { x: number; y: number } | null,
    isPrecisionMode: false,
    gpuUsage: 0,
    commandMode: false,
    pendingCommand: null as string | null,
  })
  const lastDisplayUpdateRef = useRef(0)
  const DISPLAY_UPDATE_INTERVAL = 50 // Update UI at 20fps max

  // Network
  const [networkInfo, setNetworkInfo] = useState<{ hostname: string; ips: string[]; port: number } | null>(null)
  const [networkMessages, setNetworkMessages] = useState<Array<{ from: string; action: string; ip: string; time: string }>>([])
  const [showNetworkPanel, setShowNetworkPanel] = useState(true)

  // Pointer state - stored in refs, batched to display state
  const pointerPosRef = useRef<{ x: number; y: number } | null>(null)
  const isPrecisionModeRef = useRef(false)
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null)

  // Refs
  const lastGestureRef = useRef<string>('UNKNOWN')
  const frameTimesRef = useRef<number[]>([])
  const lastActionTimeRef = useRef(0)
  const smoothedFaceLandmarksRef = useRef<Array<{ x: number; y: number; z: number }> | null>(null)
  const smoothedHandLandmarksRef = useRef<Array<Array<{ x: number; y: number }>> | null>(null)
  const canvasCtxRef = useRef<CanvasRenderingContext2D | null>(null)
  const canvasSizeRef = useRef({ w: 0, h: 0 })
  const inferenceTimesRef = useRef<number[]>([])
  const lastInferenceTimeRef = useRef(0)
  const smoothingRef = useRef(DEFAULT_SMOOTHING)

  const ACTION_COOLDOWN_MS = 2000
  const DRY_RUN = true

  // Command mode gesture mappings
  const COMMAND_MODE_ACTIONS: Record<string, { label: string; key?: string; action?: string }> = {
    'PEACE_SIGN': { label: 'TERMINAL 2', key: 'Alt+2' },
    'THREE_FINGERS': { label: 'TERMINAL 3', key: 'Alt+3' },
    'FOUR_FINGERS': { label: 'TERMINAL 4', key: 'Alt+4' },
    'THUMBS_UP': { label: 'CLICK', action: 'mouse-click' },
    'CLOSED_FIST': { label: 'ENTER', key: 'Enter' },
    'ROCK_ON': { label: 'VOICE INPUT', key: 'Win+H' },
    'POINTING_UP': { label: 'EXIT COMMAND MODE', action: 'exit-command-mode' },
  }

  // Ref to track pending command for display
  const pendingCommandRef = useRef<string | null>(null)

  // Check for "Force Grip" - Palpatine style, fingers partially curled
  // Not fully open, not fully closed - like gripping an invisible ball
  const checkForceGrip = useCallback((landmarks: NormalizedLandmark[]): boolean => {
    // First check: if index finger is extended (pointing), NOT a force grip
    const indexTipY = landmarks[8].y
    const indexPipY = landmarks[6].y
    const indexExtended = indexTipY < indexPipY // tip above pip = extended

    if (indexExtended) {
      // Index is pointing up = aiming mode, not precision
      return false
    }

    // Index is curled, now check if ALL fingers are partially curled (force grip)
    const fingers = [
      { tip: 8, pip: 6 },   // index
      { tip: 12, pip: 10 }, // middle
      { tip: 16, pip: 14 }, // ring
      { tip: 20, pip: 18 }, // pinky
    ]

    let partialCount = 0
    for (const f of fingers) {
      const tipY = landmarks[f.tip].y
      const pipY = landmarks[f.pip].y
      const diff = tipY - pipY // positive = tip below pip (curled)

      // Partially curled: tip is 0.01-0.08 below pip (not straight, not full fist)
      if (diff > 0.01 && diff < 0.08) {
        partialCount++
      }
    }

    // At least 3 fingers partially curled = force grip
    return partialCount >= 3
  }, [])

  // Update pointer position - writes to refs, not state
  const updatePointer = useCallback((landmarks: NormalizedLandmark[]) => {
    const w = window.innerWidth
    const h = window.innerHeight
    const precision = checkForceGrip(landmarks)
    isPrecisionModeRef.current = precision

    // RAYCAST - use slider setting for factor
    const wrist = landmarks[0]
    const tip = landmarks[8]
    const dx = tip.x - wrist.x
    const dy = tip.y - wrist.y
    const projX = tip.x + dx * settings.raycastFactor
    const projY = tip.y + dy * settings.raycastFactor

    let newX = Math.max(0, Math.min(w, (1 - projX) * w))
    let newY = Math.max(0, Math.min(h, projY * h))

    if (precision && lastPointerRef.current) {
      const last = lastPointerRef.current
      newX = last.x + (newX - last.x) * settings.precisionSlowdown
      newY = last.y + (newY - last.y) * settings.precisionSlowdown
    }

    lastPointerRef.current = { x: newX, y: newY }
    pointerPosRef.current = { x: newX, y: newY }
  }, [checkForceGrip, settings.raycastFactor, settings.precisionSlowdown])

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

  // Sync smoothing ref with settings
  useEffect(() => {
    smoothingRef.current = settings.smoothing
  }, [settings.smoothing])

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

  // Throttled display update function - batches all visual state updates
  const updateDisplay = useCallback(() => {
    const now = performance.now()
    if (now - lastDisplayUpdateRef.current < DISPLAY_UPDATE_INTERVAL) return

    lastDisplayUpdateRef.current = now
    scanLinePosRef.current = (scanLinePosRef.current + 2) % 100

    setDisplayState({
      faceDetected: faceDetectedRef.current,
      currentGesture: currentGestureRef.current,
      fps: fpsRef.current,
      scanLinePos: scanLinePosRef.current,
      pointerPos: commandMode ? frozenPointerRef.current : pointerPosRef.current,
      isPrecisionMode: isPrecisionModeRef.current,
      gpuUsage: gpuUsageRef.current,
      commandMode: commandMode,
      pendingCommand: pendingCommandRef.current,
    })
  }, [commandMode])


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

    // FPS calculation - use circular buffer instead of shift()
    const now = performance.now()
    const frameTimes = frameTimesRef.current
    frameTimes.push(now)
    if (frameTimes.length > 30) frameTimes.shift()
    if (frameTimes.length > 1) {
      const elapsed = now - frameTimes[0]
      fpsRef.current = Math.round((frameTimes.length - 1) / (elapsed / 1000))
    }

    const video = videoRef.current
    if (!video || video.videoWidth === 0) {
      requestAnimationFrame(predictWebcam)
      return
    }

    // Measure ML inference time
    const inferenceStart = performance.now()
    const results = recognizer.detect(video)
    const inferenceEnd = performance.now()
    const inferenceTime = inferenceEnd - inferenceStart

    // Track inference times for average
    inferenceTimesRef.current.push(inferenceTime)
    if (inferenceTimesRef.current.length > 30) inferenceTimesRef.current.shift()
    const avgInference = inferenceTimesRef.current.reduce((a, b) => a + b, 0) / inferenceTimesRef.current.length
    lastInferenceTimeRef.current = avgInference

    // Estimate GPU load based on inference time (rough heuristic)
    // ~5ms = light, ~15ms = medium, ~30ms+ = heavy
    gpuUsageRef.current = Math.min(100, Math.round((avgInference / 30) * 100))

    faceDetectedRef.current = recognizer.faceDetected

    // Smooth face landmarks
    smoothedFaceLandmarksRef.current = smoothLandmarks(
      recognizer.faceLandmarks,
      smoothedFaceLandmarksRef.current,
      smoothingRef.current
    )

    if (!recognizer.faceDetected) {
      const ctx = canvasRef.current?.getContext('2d')
      if (ctx) ctx.clearRect(0, 0, canvasRef.current!.width, canvasRef.current!.height)
      currentGestureRef.current = 'UNKNOWN'
      pointerPosRef.current = null
      updateDisplay()
      requestAnimationFrame(predictWebcam)
      return
    }

    drawResults(results)

    if (results && results.landmarks.length > 0) {
      // Find the active hand based on settings
      // MediaPipe handedness is from camera's POV (unmirrored)
      // We mirror the video, so MediaPipe "Right" = user's LEFT hand visually
      // To match user's actual hand: flip the comparison
      const targetHandedness = settings.activeHand === 'right' ? 'left' : 'right'

      let activeHandIndex = 0
      let foundActiveHand = false
      if (results.handednesses && results.handednesses.length > 0) {
        for (let i = 0; i < results.handednesses.length; i++) {
          const handedness = results.handednesses[i][0]?.categoryName?.toLowerCase()
          if (handedness === targetHandedness) {
            activeHandIndex = i
            foundActiveHand = true
            break
          }
        }
        // If active hand not found, skip processing
        if (!foundActiveHand) {
          pointerPosRef.current = null
          currentGestureRef.current = 'UNKNOWN'
          updateDisplay()
          requestAnimationFrame(predictWebcam)
          return
        }
      }

      const landmarks = results.landmarks[activeHandIndex]
      const gesture = recognizer.recognizeGestureWithHold(landmarks)

      currentGestureRef.current = gesture

      // COMMAND MODE LOGIC
      if (commandMode) {
        // In command mode - check for commands
        const cmdAction = COMMAND_MODE_ACTIONS[gesture]
        if (cmdAction) {
          pendingCommandRef.current = `${cmdAction.label}${cmdAction.key ? ` (${cmdAction.key})` : ''}`

          // Handle exit command mode
          if (gesture === 'POINTING_UP' && gesture !== lastGestureRef.current) {
            setCommandMode(false)
            frozenPointerRef.current = null
            pendingCommandRef.current = null
          }
          // For now just show what WOULD happen (DRY_RUN style)
          // Later we'll actually send the keystrokes
        } else {
          pendingCommandRef.current = null
        }
      } else {
        // In AIM mode - check for enter command mode
        if (gesture === 'OPEN_PALM' && gesture !== lastGestureRef.current) {
          // Enter command mode, freeze pointer
          setCommandMode(true)
          frozenPointerRef.current = pointerPosRef.current
          pendingCommandRef.current = 'COMMAND MODE'
        } else {
          // In aim mode, just clear any pending command display
          pendingCommandRef.current = null
        }
      }

      lastGestureRef.current = gesture

      // Update pointer (only in aim mode)
      if (!commandMode) {
        updatePointer(landmarks)
      }
    }

    // Throttled display update - only updates React state at 20fps
    updateDisplay()

    requestAnimationFrame(predictWebcam)
  }

  const drawResults = (results: HandLandmarkerResult | null) => {
    const canvas = canvasRef.current
    if (!canvas) return

    // Cache context reference
    if (!canvasCtxRef.current) {
      canvasCtxRef.current = canvas.getContext('2d')
    }
    const ctx = canvasCtxRef.current
    if (!ctx) return

    const w = window.innerWidth
    const h = window.innerHeight

    // Only resize canvas when window size actually changes
    if (canvasSizeRef.current.w !== w || canvasSizeRef.current.h !== h) {
      canvas.width = w
      canvas.height = h
      canvasSizeRef.current = { w, h }
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
            x: prevHand[i].x + (point.x - prevHand[i].x) * (1 - smoothingRef.current),
            y: prevHand[i].y + (point.y - prevHand[i].y) * (1 - smoothingRef.current),
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
        background: `linear-gradient(to bottom, transparent ${displayState.scanLinePos}%, rgba(0,255,255,0.03) ${displayState.scanLinePos + 0.5}%, rgba(0,255,255,0.08) ${displayState.scanLinePos + 1}%, rgba(0,255,255,0.03) ${displayState.scanLinePos + 1.5}%, transparent ${displayState.scanLinePos + 2}%)`,
      }} />

      {/* Status Header */}
      <div className="absolute top-8 left-8 font-mono" style={{ zIndex: Z.HUD }}>
        <h1 className="text-2xl font-bold tracking-widest" style={{ color: displayState.faceDetected ? '#00FFFF' : '#666' }}>
          JARVIS // {displayState.faceDetected ? 'ACTIVE' : 'STANDBY'}
        </h1>
        <p className="text-sm opacity-80" style={{ color: displayState.faceDetected ? '#00FFFF' : '#666' }}>
          {displayState.faceDetected ? status : 'Looking for face...'}
        </p>
      </div>

      {/* FPS & GPU Stats */}
      <div className="absolute bottom-8 left-8 font-mono text-xs" style={{ zIndex: Z.HUD }}>
        <div style={{ color: displayState.fps >= 24 ? '#00FF00' : displayState.fps >= 15 ? '#FFFF00' : '#FF0000' }}>
          {displayState.fps} FPS
        </div>
        <div style={{ color: displayState.gpuUsage < 50 ? '#00FF00' : displayState.gpuUsage < 80 ? '#FFFF00' : '#FF0000' }}>
          GPU: {displayState.gpuUsage}% ({Math.round(lastInferenceTimeRef.current)}ms)
        </div>
      </div>

      {/* Mode Status */}
      <div className="absolute top-8 left-1/2 transform -translate-x-1/2 font-mono" style={{ zIndex: Z.HUD }}>
        {/* Current Mode */}
        <div
          className="text-center text-lg font-bold px-4 py-1 mb-2"
          style={{
            background: displayState.commandMode ? 'rgba(255,0,0,0.3)' : 'rgba(0,255,0,0.2)',
            border: `2px solid ${displayState.commandMode ? '#FF0000' : '#00FF00'}`,
            color: displayState.commandMode ? '#FF0000' : '#00FF00',
          }}
        >
          {displayState.commandMode ? '⚡ COMMAND MODE' : '🎯 AIM MODE'}
        </div>

        {/* Pending Command Display */}
        {displayState.pendingCommand && (
          <div
            className="text-center text-xl font-bold py-2 px-6 mb-2 animate-pulse"
            style={{
              background: 'rgba(255,255,0,0.3)',
              border: '2px solid #FFFF00',
              color: '#FFFF00',
            }}
          >
            → {displayState.pendingCommand}
          </div>
        )}

        {/* Pointer Position */}
        <div className="text-center text-sm" style={{ color: displayState.isPrecisionMode ? '#FF00FF' : '#00FFFF' }}>
          {displayState.pointerPos ? `${Math.round(displayState.pointerPos.x)}, ${Math.round(displayState.pointerPos.y)}${displayState.commandMode ? ' (FROZEN)' : ''}` : 'NO HAND'}
        </div>

        {/* Help Text */}
        <div className="text-center text-xs text-gray-500 mt-1">
          {displayState.commandMode
            ? 'Point to exit • Gestures trigger commands'
            : 'Open palm = Command Mode • Force Grip = Precision'
          }
        </div>
      </div>

      {/* THE POINTER - BIG RED DOT */}
      {displayState.pointerPos && (
        <>
          <div style={{
            position: 'fixed',
            left: displayState.pointerPos.x - (displayState.isPrecisionMode ? 60 : 100),
            top: displayState.pointerPos.y - (displayState.isPrecisionMode ? 60 : 100),
            width: displayState.isPrecisionMode ? 120 : 200,
            height: displayState.isPrecisionMode ? 120 : 200,
            background: displayState.isPrecisionMode
              ? 'radial-gradient(circle, rgba(255,0,255,0.6) 0%, rgba(255,0,255,0.2) 40%, transparent 70%)'
              : 'radial-gradient(circle, rgba(255,0,0,0.5) 0%, rgba(255,0,0,0.2) 40%, transparent 70%)',
            borderRadius: '50%',
            pointerEvents: 'none',
            zIndex: Z.POINTER,
          }} />
          <div style={{
            position: 'fixed',
            left: displayState.pointerPos.x - (displayState.isPrecisionMode ? 15 : 40),
            top: displayState.pointerPos.y - (displayState.isPrecisionMode ? 15 : 40),
            width: displayState.isPrecisionMode ? 30 : 80,
            height: displayState.isPrecisionMode ? 30 : 80,
            background: displayState.isPrecisionMode ? '#FF00FF' : '#FF0000',
            boxShadow: displayState.isPrecisionMode ? '0 0 20px #FF00FF' : '0 0 40px #FF0000, 0 0 80px #FF0000',
            border: displayState.isPrecisionMode ? '3px solid #FFF' : '5px solid #FFFF00',
            borderRadius: '50%',
            pointerEvents: 'none',
            zIndex: Z.POINTER + 1,
          }} />
          <div style={{
            position: 'fixed',
            left: displayState.pointerPos.x - 2,
            top: displayState.pointerPos.y - 2,
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

      {/* Settings Toggle Button */}
      <button
        onClick={() => setShowSettings(!showSettings)}
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          background: 'rgba(0,0,0,0.8)',
          border: '1px solid #00FFFF',
          color: '#00FFFF',
          padding: '8px 12px',
          fontFamily: 'monospace',
          fontSize: '12px',
          cursor: 'pointer',
          zIndex: Z.HUD,
        }}
      >
        {showSettings ? 'HIDE' : 'SETTINGS'}
      </button>

      {/* Settings Panel */}
      {showSettings && (
        <div style={{
          position: 'absolute',
          top: 48,
          right: 8,
          background: 'rgba(0,0,0,0.9)',
          border: '1px solid #00FFFF',
          padding: '16px',
          fontFamily: 'monospace',
          fontSize: '12px',
          color: '#00FFFF',
          zIndex: Z.HUD,
          minWidth: '280px',
        }}>
          <div style={{ marginBottom: '16px', fontWeight: 'bold', borderBottom: '1px solid #00FFFF', paddingBottom: '8px' }}>
            POINTER SETTINGS
          </div>

          {/* Active Hand Toggle */}
          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', marginBottom: '8px' }}>Active Hand:</label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={() => setSettings(s => ({ ...s, activeHand: 'left' }))}
                style={{
                  flex: 1,
                  padding: '8px',
                  background: settings.activeHand === 'left' ? '#00FFFF' : 'transparent',
                  border: '1px solid #00FFFF',
                  color: settings.activeHand === 'left' ? '#000' : '#00FFFF',
                  fontFamily: 'monospace',
                  cursor: 'pointer',
                }}
              >
                LEFT
              </button>
              <button
                onClick={() => setSettings(s => ({ ...s, activeHand: 'right' }))}
                style={{
                  flex: 1,
                  padding: '8px',
                  background: settings.activeHand === 'right' ? '#00FFFF' : 'transparent',
                  border: '1px solid #00FFFF',
                  color: settings.activeHand === 'right' ? '#000' : '#00FFFF',
                  fontFamily: 'monospace',
                  cursor: 'pointer',
                }}
              >
                RIGHT
              </button>
            </div>
          </div>

          {/* Raycast Factor */}
          <div style={{ marginBottom: '12px' }}>
            <label style={{ display: 'block', marginBottom: '4px' }}>
              Raycast Factor: {settings.raycastFactor.toFixed(1)}x
            </label>
            <input
              type="range"
              min="1"
              max="10"
              step="0.5"
              value={settings.raycastFactor}
              onChange={(e) => setSettings(s => ({ ...s, raycastFactor: parseFloat(e.target.value) }))}
              style={{ width: '100%', accentColor: '#00FFFF' }}
            />
            <div style={{ fontSize: '10px', color: '#666', marginTop: '2px' }}>
              Higher = more reach, less hand movement (1x-10x)
            </div>
          </div>

          {/* Precision Slowdown */}
          <div style={{ marginBottom: '12px' }}>
            <label style={{ display: 'block', marginBottom: '4px' }}>
              Precision Speed: {(settings.precisionSlowdown * 100).toFixed(0)}%
            </label>
            <input
              type="range"
              min="0.01"
              max="1"
              step="0.01"
              value={settings.precisionSlowdown}
              onChange={(e) => setSettings(s => ({ ...s, precisionSlowdown: parseFloat(e.target.value) }))}
              style={{ width: '100%', accentColor: '#FF00FF' }}
            />
            <div style={{ fontSize: '10px', color: '#666', marginTop: '2px' }}>
              Lower = slower in Force Grip (1%-100%)
            </div>
          </div>

          {/* Smoothing */}
          <div style={{ marginBottom: '12px' }}>
            <label style={{ display: 'block', marginBottom: '4px' }}>
              Smoothing: {(settings.smoothing * 100).toFixed(0)}%
            </label>
            <input
              type="range"
              min="0.05"
              max="0.95"
              step="0.05"
              value={settings.smoothing}
              onChange={(e) => setSettings(s => ({ ...s, smoothing: parseFloat(e.target.value) }))}
              style={{ width: '100%', accentColor: '#00FF00' }}
            />
            <div style={{ fontSize: '10px', color: '#666', marginTop: '2px' }}>
              Higher = smoother but more lag (5%-95%)
            </div>
          </div>

          {/* Reset Button */}
          <button
            onClick={() => setSettings({
              raycastFactor: DEFAULT_RAYCAST_FACTOR,
              precisionSlowdown: DEFAULT_PRECISION_SLOWDOWN,
              smoothing: DEFAULT_SMOOTHING,
              activeHand: 'right',
            })}
            style={{
              width: '100%',
              background: 'transparent',
              border: '1px solid #FF0000',
              color: '#FF0000',
              padding: '8px',
              fontFamily: 'monospace',
              cursor: 'pointer',
              marginTop: '8px',
            }}
          >
            RESET DEFAULTS
          </button>

          {/* Gesture hint */}
          <div style={{ marginTop: '16px', paddingTop: '12px', borderTop: '1px solid #333', fontSize: '10px', color: '#FF00FF' }}>
            PRECISION MODE: Force Grip (Palpatine hands)
            <br />
            Curl fingers slightly like gripping invisible ball
          </div>
        </div>
      )}
    </div>
  )
}

export default App
