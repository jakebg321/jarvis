# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## User Context

**User uses voice-to-text and cusses a lot - that's just how they talk. Don't be alarmed by profanity in messages.**

- Uses voice-to-text constantly (expect transcription quirks and casual language)
- Has injured right hand but **right hand is primary for gestures** (not immobile, just less agile)
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
├── App.tsx         # MAIN HUD - This is THE layer for all UI display
└── services/
    ├── GestureRecognizer.ts   # MediaPipe hand/face detection + gesture classification
    └── BodySegmentation.ts    # TensorFlow.js BodyPix for background replacement

public/models/      # MediaPipe model files (.task)
```

### App.tsx - THE MAIN HUD LAYER

**This is where all UI elements live. When adding display features, add them here.**

Current HUD elements (all positioned with `position: absolute/fixed`):
- **Top left:** "JARVIS // ACTIVE/STANDBY" header + status
- **Top center:** Mode indicator (AIM MODE / COMMAND MODE) + pending command display
- **Top right:** Settings button + settings panel
- **Bottom left:** FPS, GPU %, inference time, current gesture debug
- **Center (floating):** The pointer dot (big red circle in AIM mode)
- **Background:** Video feed (mirrored) + canvas overlay for hand/face landmarks

Z-Index layers (defined in `Z` const):
```typescript
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
}
```

### Dual Mode System

**AIM MODE** (default, green indicator)
- POINTING_UP (index finger) → moves pointer via RAYCAST projection
- Force Grip (Palpatine hands, fingers partially curled) → precision/slow mode
- OPEN_PALM (stop hand, all fingers extended) → enters COMMAND MODE

**COMMAND MODE** (red indicator, pointer frozen)
- Pointer freezes in place
- Gestures trigger commands (currently just displays what WOULD happen)
- POINTING_UP → exits back to AIM MODE

Command mode gesture mappings:
| Gesture | Command |
|---------|---------|
| PEACE_SIGN | Terminal 2 (Alt+2) |
| THREE_FINGERS | Terminal 3 (Alt+3) |
| FOUR_FINGERS | Terminal 4 (Alt+4) |
| THUMBS_UP | Click at pointer |
| CLOSED_FIST | Enter key |
| ROCK_ON | Voice input (Win+H) |

### Gesture Detection

**Finger "open" detection:** Uses distance-from-wrist comparison, not Y-axis.
- Finger is "open" if fingertip is further from wrist than the pip joint
- Works regardless of hand orientation (flat, vertical, angled)

```typescript
const distToWrist = (idx) => Math.hypot(landmarks[idx].x - wrist.x, landmarks[idx].y - wrist.y);
const indexIsOpen = distToWrist(8) > distToWrist(6);  // tip vs pip
```

### Key Concepts

**Face-Gated Gesture Recognition:** Hand tracking only activates when a face is detected (prevents false triggers when user looks away).

**Gesture Hold-to-Confirm:** 300ms hold threshold prevents accidental gesture triggers. Raw gesture must be held stable before it's confirmed.

**Single Hand Mode:** Settings panel lets you pick LEFT or RIGHT hand - only that hand controls the system. Default is RIGHT.

**Performance Optimization:** React state updates are batched at 20fps via `displayState`. High-frequency values (FPS, pointer pos, gesture) stored in refs, only copied to state in throttled `updateDisplay()`.

### MediaPipe Models

- `hand_landmarker.task` - 21 hand landmarks for gesture recognition
- `face_landmarker.task` - 468 face landmarks + 52 blendshapes for expression tracking

Models loaded from `/public/models/` via CDN WASM runtime.

## Known Issues

- **Background replacement (BodyPix):** Loads but has z-index and masking issues
- **VPN blocks multicast:** Need "Allow local network access" in VPN settings, or switch from OpenVPN UDP protocol
- **WSL network adapters:** Code explicitly binds to 192.168.x.x to avoid WSL virtual adapter conflicts

## Planned Feature: Force Throw Clipboard

See `.claude/JARVIS_CLAUDE_CODE_PROMPT.md` for full implementation spec. Core concept: pinch to grab clipboard content, throw hand motion to send to other machine via WebSocket.
