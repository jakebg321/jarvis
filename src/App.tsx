import { useEffect, useRef, useState, useCallback } from 'react'
import { GestureRecognizer } from './services/GestureRecognizer'
import type { HandLandmarkerResult } from '@mediapipe/tasks-vision'

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
  // Thumb
  [0, 1], [1, 2], [2, 3], [3, 4],
  // Index
  [0, 5], [5, 6], [6, 7], [7, 8],
  // Middle
  [0, 9], [9, 10], [10, 11], [11, 12],
  // Ring
  [0, 13], [13, 14], [14, 15], [15, 16],
  // Pinky
  [0, 17], [17, 18], [18, 19], [19, 20],
  // Palm
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
  const ACTION_COOLDOWN_MS = 2000 // Prevent rapid-fire actions

  // Network test state
  const [networkInfo, setNetworkInfo] = useState<{ hostname: string; ips: string[]; port: number } | null>(null)
  const [networkMessages, setNetworkMessages] = useState<Array<{ from: string; action: string; ip: string; time: string }>>([])
  const [showNetworkPanel, setShowNetworkPanel] = useState(true)

  // Network setup
  useEffect(() => {
    if (!ipcRenderer) return

    // Get network info
    ipcRenderer.invoke('network-info').then(setNetworkInfo)

    // Listen for incoming messages
    const handleMessage = (_event: unknown, data: { from: string; action: string; ip: string }) => {
      setNetworkMessages(prev => [
        { ...data, time: new Date().toLocaleTimeString() },
        ...prev.slice(0, 9) // Keep last 10 messages
      ])
    }

    ipcRenderer.on('network-message', handleMessage)
    return () => {
      ipcRenderer.removeListener('network-message', handleMessage)
    }
  }, [])

  const sendPing = async () => {
    if (!ipcRenderer) return
    await ipcRenderer.invoke('network-ping')
  }

  useEffect(() => {
    const init = async () => {
      const rec = new GestureRecognizer()
      await rec.initialize()
      recognizerRef.current = rec  // Use ref (synchronous) instead of state
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

  // DRY RUN MODE - show what would happen without executing
  const DRY_RUN = true

  // Execute gesture action
  const executeGestureAction = useCallback(async (gesture: string) => {
    const now = Date.now()
    if (now - lastActionTimeRef.current < ACTION_COOLDOWN_MS) return

    const actionConfig = GESTURE_ACTIONS[gesture]
    if (!actionConfig) return

    lastActionTimeRef.current = now

    if (DRY_RUN) {
      // Just show what would happen
      console.log(`[DRY RUN] Would execute: ${actionConfig.action} - ${actionConfig.label}`)
      if (actionConfig.action === 'screenshot') {
        setActionFeedback({ label: 'WOULD: TAKE SCREENSHOT', success: true })
      } else if (actionConfig.action === 'launch' && actionConfig.app) {
        setActionFeedback({ label: `WOULD LAUNCH: ${actionConfig.label}`, success: true })
      }
    } else {
      // Real execution
      if (!ipcRenderer) return
      console.log(`Executing action: ${actionConfig.action} - ${actionConfig.label}`)
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

    // Clear feedback after 1.5 seconds
    setTimeout(() => setActionFeedback(null), 1500)
  }, [])

  // Sync canvas size with video dimensions on resize
  useEffect(() => {
    const syncCanvasSize = () => {
      if (videoRef.current && canvasRef.current) {
        canvasRef.current.width = videoRef.current.videoWidth || 1280
        canvasRef.current.height = videoRef.current.videoHeight || 720
      }
    }

    window.addEventListener('resize', syncCanvasSize)
    return () => window.removeEventListener('resize', syncCanvasSize)
  }, [])

  const startCamera = async () => {
    if (videoRef.current) {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720 }
      })
      videoRef.current.srcObject = stream
      videoRef.current.addEventListener('loadeddata', () => {
        // Sync canvas to video dimensions
        if (canvasRef.current && videoRef.current) {
          canvasRef.current.width = videoRef.current.videoWidth
          canvasRef.current.height = videoRef.current.videoHeight
        }
        predictWebcam()
      })
    }
  }

  const predictWebcam = () => {
    const recognizer = recognizerRef.current
    if (!recognizer || !videoRef.current || !canvasRef.current) return

    // FPS calculation
    const now = performance.now()
    frameTimesRef.current.push(now)
    // Keep only last 30 frames for averaging
    if (frameTimesRef.current.length > 30) {
      frameTimesRef.current.shift()
    }
    if (frameTimesRef.current.length > 1) {
      const elapsed = now - frameTimesRef.current[0]
      const avgFps = Math.round((frameTimesRef.current.length - 1) / (elapsed / 1000))
      setFps(avgFps)
    }

    const results = recognizer.detect(videoRef.current)
    setFaceDetected(recognizer.faceDetected)
    setBlendshapes(recognizer.blendshapes)

    // Clear canvas if no face
    if (!recognizer.faceDetected) {
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (canvas && ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height)
      }
      setCurrentGesture('UNKNOWN')
      requestAnimationFrame(predictWebcam)
      return
    }

    if (results) {
      drawResults(results)
      if (results.landmarks.length > 0) {
        const gesture = recognizer.recognizeGestureWithHold(results.landmarks[0]);
        const landmarks = results.landmarks[0];

        const handX = (1 - landmarks[0].x) * window.innerWidth;
        const handY = landmarks[0].y * window.innerHeight;

        setCurrentGesture(gesture)
        setStatus(`Hand: ${Math.round(handX)}, ${Math.round(handY)}`);

        // Execute action when gesture confirms and changes
        if (gesture !== lastGestureRef.current && gesture !== 'UNKNOWN') {
          executeGestureAction(gesture)
        }

        // Panel interaction logic
        if (gesture === 'CLOSED_FIST') {
          if (!grabbedPanel) {
            const nearPanel = panels.find(p =>
              Math.abs(p.x - handX) < 80 && Math.abs(p.y - handY) < 50
            );
            if (nearPanel) {
              setGrabbedPanel(nearPanel.id);
            }
          } else {
            setPanels(prev => prev.map(p =>
              p.id === grabbedPanel ? { ...p, x: handX, y: handY } : p
            ));
          }
        } else if (gesture === 'OPEN_PALM' && grabbedPanel) {
          setGrabbedPanel(null);
        }

        lastGestureRef.current = gesture;
      }
    }
    requestAnimationFrame(predictWebcam)
  }

  const drawResults = (results: HandLandmarkerResult) => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    // Use viewport dimensions (canvas is 100vw x 100vh)
    const w = window.innerWidth
    const h = window.innerHeight

    // Set canvas resolution to match viewport
    canvas.width = w
    canvas.height = h

    ctx.clearRect(0, 0, w, h)

    if (results.landmarks) {
      for (const landmarks of results.landmarks) {
        // Convert normalized coords to screen coords (mirror X)
        const points = landmarks.map(lm => ({
          x: (1 - lm.x) * w,
          y: lm.y * h
        }))

        // Draw connections (lines between joints)
        ctx.strokeStyle = '#00FFFF'
        ctx.lineWidth = 3
        for (const [start, end] of HAND_CONNECTIONS) {
          ctx.beginPath()
          ctx.moveTo(points[start].x, points[start].y)
          ctx.lineTo(points[end].x, points[end].y)
          ctx.stroke()
        }

        // Draw landmarks (dots at joints)
        ctx.fillStyle = '#FF00FF'
        for (const point of points) {
          ctx.beginPath()
          ctx.arc(point.x, point.y, 8, 0, 2 * Math.PI)
          ctx.fill()
        }

        // Draw fingertip labels
        ctx.font = 'bold 12px monospace'
        ctx.textAlign = 'center'
        for (const { index, label } of FINGERTIP_LABELS) {
          const point = points[index]
          // Label background
          ctx.fillStyle = 'rgba(0, 0, 0, 0.7)'
          const textWidth = ctx.measureText(label).width
          ctx.fillRect(point.x - textWidth / 2 - 4, point.y - 28, textWidth + 8, 16)
          // Label text
          ctx.fillStyle = '#00FFFF'
          ctx.fillText(label, point.x, point.y - 16)
        }

        // Draw wrist label
        const wrist = points[0]
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)'
        const wristText = 'WRIST'
        const wristWidth = ctx.measureText(wristText).width
        ctx.fillRect(wrist.x - wristWidth / 2 - 4, wrist.y + 12, wristWidth + 8, 16)
        ctx.fillStyle = '#FF00FF'
        ctx.fillText(wristText, wrist.x, wrist.y + 24)
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
          zIndex: 5,
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

      {/* Corner Brackets - Top Left */}
      <div className="absolute top-4 left-4 z-40" style={{ width: 60, height: 60, pointerEvents: 'none' }}>
        <div style={{ position: 'absolute', top: 0, left: 0, width: 20, height: 3, background: '#00FFFF' }} />
        <div style={{ position: 'absolute', top: 0, left: 0, width: 3, height: 20, background: '#00FFFF' }} />
      </div>
      {/* Corner Brackets - Top Right */}
      <div className="absolute top-4 right-4 z-40" style={{ width: 60, height: 60, pointerEvents: 'none' }}>
        <div style={{ position: 'absolute', top: 0, right: 0, width: 20, height: 3, background: '#00FFFF' }} />
        <div style={{ position: 'absolute', top: 0, right: 0, width: 3, height: 20, background: '#00FFFF' }} />
      </div>
      {/* Corner Brackets - Bottom Left */}
      <div className="absolute bottom-4 left-4 z-40" style={{ width: 60, height: 60, pointerEvents: 'none' }}>
        <div style={{ position: 'absolute', bottom: 0, left: 0, width: 20, height: 3, background: '#00FFFF' }} />
        <div style={{ position: 'absolute', bottom: 0, left: 0, width: 3, height: 20, background: '#00FFFF' }} />
      </div>
      {/* Corner Brackets - Bottom Right */}
      <div className="absolute bottom-4 right-4 z-40" style={{ width: 60, height: 60, pointerEvents: 'none' }}>
        <div style={{ position: 'absolute', bottom: 0, right: 0, width: 20, height: 3, background: '#00FFFF' }} />
        <div style={{ position: 'absolute', bottom: 0, right: 0, width: 3, height: 20, background: '#00FFFF' }} />
      </div>

      {/* HUD Overlay */}
      <div className="absolute top-8 left-8 z-50 font-mono">
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
      <div className="absolute bottom-8 left-8 z-50 font-mono text-xs">
        <span style={{ color: fps >= 24 ? '#00FF00' : fps >= 15 ? '#FFFF00' : '#FF0000' }}>
          {fps} FPS
        </span>
        <span className="text-gray-500 ml-2">| MediaPipe Vision</span>
      </div>

      {/* Action Feedback Overlay */}
      {actionFeedback && (
        <div
          className="absolute inset-0 z-[100] flex items-center justify-center pointer-events-none"
          style={{
            background: actionFeedback.success
              ? 'rgba(0, 255, 255, 0.1)'
              : 'rgba(255, 0, 0, 0.1)',
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

      {/* Gesture Guide - Bottom Center */}
      <div className="absolute bottom-8 left-1/2 transform -translate-x-1/2 z-50 font-mono text-[10px] text-gray-500">
        <div className="flex gap-4">
          <span>✌️ PEACE = Screenshot</span>
          <span>☝️ POINT = Chrome</span>
          <span>🤟 3 = VS Code</span>
          <span>🖖 4 = Slack</span>
          <span>👍 THUMB = Explorer</span>
          <span>🤘 ROCK = Terminal</span>
        </div>
      </div>

      {/* Video Feed - mirrored like a selfie cam */}
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
          transform: 'scaleX(-1)'  // Mirror the video
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
          zIndex: 10
        }}
      />

      {/* Stats Panel */}
      <div className="absolute top-20 right-8 z-50 font-mono text-xs" style={{
        background: 'rgba(0,0,0,0.85)',
        padding: '16px',
        borderRadius: '4px',
        border: '1px solid #00FFFF60',
        minWidth: '220px',
        boxShadow: '0 0 20px rgba(0, 255, 255, 0.1)',
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
        <div className="absolute bottom-20 right-8 z-50 font-mono text-xs" style={{
          background: 'rgba(0,0,0,0.9)',
          padding: '16px',
          borderRadius: '4px',
          border: '1px solid #FF00FF60',
          minWidth: '280px',
          maxHeight: '300px',
          boxShadow: '0 0 20px rgba(255, 0, 255, 0.1)',
        }}>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-purple-500 animate-pulse" />
              <span className="text-white font-bold tracking-wider">NETWORK TEST</span>
            </div>
            <button
              onClick={() => setShowNetworkPanel(false)}
              className="text-gray-500 hover:text-white"
            >
              [X]
            </button>
          </div>

          {/* This Machine */}
          <div className="mb-3 pb-2" style={{ borderBottom: '1px solid #FF00FF30' }}>
            <div className="text-gray-400 text-[10px] mb-1">THIS MACHINE</div>
            <div className="text-purple-400 font-bold">{networkInfo?.hostname || 'Loading...'}</div>
            <div className="text-gray-500 text-[10px]">
              {networkInfo?.ips.join(', ')} : {networkInfo?.port}
            </div>
          </div>

          {/* Ping Button */}
          <button
            onClick={sendPing}
            className="w-full mb-3 py-2 px-4 rounded font-bold tracking-wider transition-all"
            style={{
              background: 'linear-gradient(90deg, #FF00FF40, #00FFFF40)',
              border: '1px solid #FF00FF',
              color: '#FF00FF',
            }}
          >
            SEND PING
          </button>

          {/* Message Log */}
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

      {/* Toggle Network Panel Button (when hidden) */}
      {!showNetworkPanel && (
        <button
          onClick={() => setShowNetworkPanel(true)}
          className="absolute bottom-8 right-8 z-50 font-mono text-xs py-2 px-4 rounded"
          style={{
            background: 'rgba(0,0,0,0.8)',
            border: '1px solid #FF00FF60',
            color: '#FF00FF',
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
            backgroundColor: grabbedPanel === panel.id
              ? `${panel.color}40`
              : 'rgba(0,0,0,0.5)',
            boxShadow: grabbedPanel === panel.id
              ? `0 0 20px ${panel.color}`
              : 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: panel.color,
            borderRadius: 8,
            pointerEvents: 'none',
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
