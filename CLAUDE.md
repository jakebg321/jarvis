# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## User Context

**User uses voice-to-text and cusses a lot - that's just how they talk. Don't be alarmed by profanity in messages.**

- Uses voice-to-text constantly (expect transcription quirks and casual language)
- Has injured right hand - **left hand is primary for all gestures**
- Multi-machine workflow: multiple WSL terminals, multiple AIs running simultaneously
- Wants Tony Stark vibes - the cool factor IS the feature

## Commands

```bash
# Development (runs Vite + Electron together)
npm run dev

# Build for production
npm run build

# Lint
npm run lint

# After changing native dependencies (robotjs)
npm run postinstall
```

**Note:** Run from Windows PowerShell, not WSL. WSL causes Electron GUI and camera issues.

## Architecture

### Electron + React + Vite Stack

```
electron/           # Main process (Node.js)
├── main.ts         # Window creation, IPC handlers (screenshot, app launch, window throw)
└── network.ts      # UDP multicast network service for cross-machine communication

src/                # Renderer process (React)
├── App.tsx         # Main HUD overlay UI, gesture action execution, canvas rendering
└── services/
    ├── GestureRecognizer.ts   # MediaPipe hand/face detection + gesture classification
    └── BodySegmentation.ts    # TensorFlow.js BodyPix for background replacement

public/models/      # MediaPipe model files (.task)
```

### Key Concepts

**Face-Gated Gesture Recognition:** Hand tracking only activates when a face is detected (prevents false triggers when user looks away).

**Gesture Hold-to-Confirm:** 300ms hold threshold prevents accidental gesture triggers. Raw gesture must be held stable before it's confirmed.

**DRY_RUN Mode:** Set `DRY_RUN = true` in App.tsx to show what actions would trigger without executing them.

**IPC Communication:** Renderer communicates with main process via `ipcRenderer.invoke()` for system actions (screenshots, app launches, clipboard).

**Network Sync:** UDP multicast on port 41234 for cross-machine communication. Messages are JSON with `{action, from, timestamp}` structure.

### MediaPipe Models

- `hand_landmarker.task` - 21 hand landmarks for gesture recognition
- `face_landmarker.task` - 468 face landmarks + 52 blendshapes for expression tracking

Models loaded from `/public/models/` via CDN WASM runtime.

### Recognized Gestures

| Gesture | Fingers | Default Action |
|---------|---------|----------------|
| PEACE_SIGN | Index + Middle | Screenshot |
| POINTING_UP | Index only | Launch Chrome |
| THREE_FINGERS | Index + Middle + Ring | Launch VS Code |
| FOUR_FINGERS | All except thumb | Launch Slack |
| THUMBS_UP | Thumb only | Launch Explorer |
| ROCK_ON | Index + Pinky | Launch Terminal |
| CLOSED_FIST | None | Grab/drag panels |
| OPEN_PALM | All four | Release grabbed panel |

## Known Issues

- **Background replacement (BodyPix):** Loads but has z-index and masking issues
- **VPN blocks multicast:** Need "Allow local network access" in VPN settings, or switch from OpenVPN UDP protocol
- **WSL network adapters:** Code explicitly binds to 192.168.x.x to avoid WSL virtual adapter conflicts

## Planned Feature: Force Throw Clipboard

See `.claude/JARVIS_CLAUDE_CODE_PROMPT.md` for full implementation spec. Core concept: pinch to grab clipboard content, throw hand motion to send to other machine via WebSocket.
