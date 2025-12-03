# JARVIS Force Throw - Claude Code Implementation Brief

## Context: Who You're Helping

You're helping an experienced developer who:
- Uses voice-to-text constantly, sits back from the keyboard
- Has an injured right hand - **left hand is primary for all gestures**
- Has a chaotic multi-machine workflow: 6+ WSL terminals, multiple AIs running simultaneously
- Currently uses ChatGPT as a clipboard sync service (copies text, pastes into chat, opens same chat on other machine, copies out) - this is the pain point we're solving
- Wants to feel like Tony Stark - the cool factor IS the feature
- Values working solutions over perfect architecture

## The Setup

**Machine Layout (same desk, same network):**
```
[LEFT: Primary Desktop]     [RIGHT: Laptop]
    4090 GPU                 Predator Helios Neo
    Windows                  Windows
    Primary workstation      Secondary machine
```

**Current JARVIS State:**
- Electron + React + Vite + TypeScript app
- MediaPipe HandLandmarker (21 hand landmarks) + FaceLandmarker (468 face landmarks, 52 blendshapes)
- Working gesture recognition: FIST, PALM, PEACE_SIGN, POINTING, THUMBS_UP, ROCK_ON, 3-finger, 4-finger
- 300ms hold-to-confirm prevents false triggers
- Face gating (only processes hands when user is looking at screen)
- Actions wired: Screenshot, launch apps via RobotJS
- HUD overlay with sci-fi aesthetics (scan lines, corner brackets, biometrics panel)

---

## The Feature: Force Throw Clipboard

### User Story
"I pinch to grab content on my left machine, then throw my hand toward the right, and the clipboard appears on my laptop. Like a Jedi throwing data across the room."

### Gesture Flow
```
1. PINCH (thumb + index together) = GRAB
   - Captures current clipboard content
   - Visual feedback: "GRABBED" indicator on HUD
   - Optional: highlight what's grabbed (text preview, image thumbnail)

2. HOLD while pinched = content is "held"
   - Track hand position
   - Show trajectory preview line toward target direction

3. THROW (rapid hand movement while releasing pinch)
   - Detect velocity vector (needs to exceed threshold)
   - Direction determines target: LEFT or RIGHT
   - Release pinch = content flies

4. RECEIVE (on target machine)
   - WebSocket receives clipboard payload
   - Writes to system clipboard
   - Visual feedback: "INCOMING" animation, then "RECEIVED"
   - Optional: toast notification with content preview
```

### Technical Architecture

**Network Layer:**
```
┌─────────────────┐         WebSocket          ┌─────────────────┐
│   Machine A     │◄─────────────────────────►│   Machine B     │
│   (Left/4090)   │                            │ (Right/Laptop)  │
│                 │                            │                 │
│ ┌─────────────┐ │    Clipboard Payload:      │ ┌─────────────┐ │
│ │ JARVIS App  │ │    {                       │ │ JARVIS App  │ │
│ │             │ │      type: 'text'|'image', │ │             │ │
│ │ Gesture     │ │      content: string|b64,  │ │ Gesture     │ │
│ │ Detection   │ │      source: 'LEFT',       │ │ Detection   │ │
│ │             │ │      timestamp: number     │ │             │ │
│ └─────────────┘ │    }                       │ └─────────────┘ │
└─────────────────┘                            └─────────────────┘
```

**Discovery Options (pick one):**
1. **Hardcoded IPs** - simplest, just config file with machine addresses
2. **mDNS/Bonjour** - auto-discovery via `bonjour-service` npm package
3. **Simple broadcast** - UDP broadcast on LAN to find peers

Recommendation: Start with hardcoded config, add discovery later.

**Clipboard Access (Electron):**
```typescript
// Read clipboard
const { clipboard } = require('electron');
const text = clipboard.readText();
const image = clipboard.readImage(); // returns NativeImage

// Write clipboard
clipboard.writeText(incomingText);
clipboard.writeImage(nativeImage.createFromBuffer(buffer));
```

**WebSocket Server (in Electron main process):**
```typescript
import { WebSocketServer, WebSocket } from 'ws';

// Each machine runs both server and client
const wss = new WebSocketServer({ port: 9147 }); // JARVIS port

// Connect to peer(s)
const peerSocket = new WebSocket('ws://OTHER_MACHINE_IP:9147');
```

---

## Gesture Detection Additions Needed

### 1. Pinch Detection
```typescript
// In GestureRecognizer.ts
detectPinch(landmarks: NormalizedLandmark[]): { isPinching: boolean; pinchDistance: number } {
  const thumbTip = landmarks[4];
  const indexTip = landmarks[8];
  
  // Calculate distance between thumb and index fingertips
  const distance = Math.sqrt(
    Math.pow(thumbTip.x - indexTip.x, 2) +
    Math.pow(thumbTip.y - indexTip.y, 2)
  );
  
  // Threshold ~0.05 in normalized coords (tune this)
  return {
    isPinching: distance < 0.05,
    pinchDistance: distance
  };
}
```

### 2. Velocity/Throw Detection
```typescript
// Track hand position history
private positionHistory: { x: number; y: number; timestamp: number }[] = [];

detectThrow(landmarks: NormalizedLandmark[]): { isThrow: boolean; direction: 'LEFT' | 'RIGHT' | null; velocity: number } {
  const wrist = landmarks[0];
  const now = performance.now();
  
  this.positionHistory.push({ x: wrist.x, y: wrist.y, timestamp: now });
  
  // Keep last 10 frames (~333ms at 30fps)
  if (this.positionHistory.length > 10) {
    this.positionHistory.shift();
  }
  
  if (this.positionHistory.length < 5) {
    return { isThrow: false, direction: null, velocity: 0 };
  }
  
  // Calculate velocity over last 5 frames
  const oldest = this.positionHistory[0];
  const newest = this.positionHistory[this.positionHistory.length - 1];
  const deltaX = newest.x - oldest.x;
  const deltaTime = (newest.timestamp - oldest.timestamp) / 1000;
  const velocity = Math.abs(deltaX / deltaTime);
  
  // Threshold: ~2.0 normalized units per second (tune this)
  const isThrow = velocity > 2.0;
  
  // Note: In mirrored video, positive deltaX = physical leftward movement
  // Adjust based on your mirror setup
  const direction = deltaX > 0 ? 'LEFT' : 'RIGHT';
  
  return { isThrow, direction: isThrow ? direction : null, velocity };
}
```

### 3. Combined Pinch-Throw State Machine
```typescript
type ThrowState = 'IDLE' | 'GRABBING' | 'HOLDING' | 'THROWING' | 'COOLDOWN';

class ForceThrowController {
  private state: ThrowState = 'IDLE';
  private grabbedContent: ClipboardContent | null = null;
  private grabStartTime: number = 0;
  
  update(pinch: PinchResult, throw_: ThrowResult, clipboard: ClipboardContent) {
    switch (this.state) {
      case 'IDLE':
        if (pinch.isPinching) {
          this.state = 'GRABBING';
          this.grabStartTime = Date.now();
          this.grabbedContent = clipboard;
        }
        break;
        
      case 'GRABBING':
        // Require 200ms pinch to confirm grab
        if (!pinch.isPinching) {
          this.state = 'IDLE';
        } else if (Date.now() - this.grabStartTime > 200) {
          this.state = 'HOLDING';
          this.onGrab(this.grabbedContent);
        }
        break;
        
      case 'HOLDING':
        if (!pinch.isPinching) {
          if (throw_.isThrow && throw_.direction) {
            this.state = 'THROWING';
            this.onThrow(this.grabbedContent, throw_.direction);
          } else {
            // Released without throwing = cancel
            this.state = 'IDLE';
            this.onCancel();
          }
        }
        break;
        
      case 'THROWING':
        // Brief cooldown to prevent repeat triggers
        setTimeout(() => { this.state = 'IDLE'; }, 1000);
        break;
    }
  }
}
```

---

## File Structure to Create

```
jarvis/
├── src/
│   ├── App.tsx                      # Add ForceThrow HUD elements
│   ├── services/
│   │   ├── GestureRecognizer.ts     # Add pinch + velocity detection
│   │   ├── ForceThrowController.ts  # NEW: State machine for throw gesture
│   │   └── ClipboardSync.ts         # NEW: WebSocket clipboard sync
│   └── config/
│       └── machines.json            # NEW: Peer machine configuration
├── electron/
│   ├── main.ts                      # Add WebSocket server, clipboard IPC
│   └── preload.ts                   # Expose clipboard + network to renderer
```

---

## Implementation Order

### Phase 1: Network Clipboard (get the pipes working)
1. Create `ClipboardSync.ts` service with WebSocket server/client
2. Add IPC handlers in `electron/main.ts` for clipboard read/write
3. Test: manually trigger send/receive between machines
4. Config file for peer IP addresses

### Phase 2: Pinch Detection
1. Add `detectPinch()` to `GestureRecognizer.ts`
2. Add pinch state to HUD (show when pinching)
3. Visual feedback: glow effect when content is "grabbed"

### Phase 3: Velocity/Throw Detection
1. Add position history tracking
2. Add `detectThrow()` with velocity calculation
3. Direction detection (left vs right)
4. Tune thresholds

### Phase 4: Integration
1. Create `ForceThrowController.ts` state machine
2. Wire gesture detection → clipboard sync
3. Add HUD animations (trajectory line, throw effect, receive notification)
4. End-to-end test

### Phase 5: Polish
1. Throw sound effect (whoosh)
2. Receive sound effect (catch/ding)
3. Content preview on grab
4. Error handling (peer offline, large content)

---

## HUD Visual Elements to Add

```tsx
// Grab indicator (when pinching + holding content)
{isHolding && (
  <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2">
    <div className="text-cyan-400 text-xl font-mono animate-pulse">
      HOLDING: {contentPreview}
    </div>
    <div className="text-xs text-gray-500">
      Release + throw to send
    </div>
  </div>
)}

// Trajectory line (while holding, pointing toward throw direction)
{isHolding && throwDirection && (
  <svg className="absolute inset-0 pointer-events-none">
    <line
      x1={handX} y1={handY}
      x2={throwDirection === 'LEFT' ? 0 : window.innerWidth} y2={handY}
      stroke="#00FFFF"
      strokeWidth="2"
      strokeDasharray="10,5"
      opacity="0.5"
    />
  </svg>
)}

// Incoming notification (on receiving machine)
{incomingContent && (
  <div className="absolute inset-0 flex items-center justify-center bg-cyan-500/10 animate-pulse">
    <div className="text-4xl font-mono text-cyan-400">
      INCOMING FROM {sourceMachine}
    </div>
  </div>
)}
```

---

## Key Technical Decisions

1. **WebSocket port**: 9147 (arbitrary, just needs to be consistent)
2. **Discovery**: Hardcoded IP for now (add mDNS later)
3. **Clipboard format**: JSON with type discriminator (`text` | `image` | `files`)
4. **Image handling**: Base64 encode, consider size limits (~10MB max)
5. **Security**: None for now (same LAN), add encryption later if needed

---

## Things to Watch Out For

1. **Mirrored video** - Your webcam feed is mirrored. When user moves hand RIGHT physically, it appears to move LEFT on screen. The throw direction logic needs to account for this.

2. **Coordinate systems** - MediaPipe landmarks are normalized (0-1). Screen coordinates need conversion.

3. **Velocity tuning** - The throw threshold will need experimentation. Too sensitive = accidental throws. Too high = frustrating.

4. **Clipboard timing** - Read clipboard at grab time, not throw time. User might change clipboard between grab and throw.

5. **Large content** - Images can be big. Consider compression or chunking for large payloads.

6. **Left hand only** - All gesture detection should work with left hand. Test extensively with left hand.

---

## Success Criteria

1. User pinches on Machine A → visual confirmation of grab
2. User throws toward Machine B → content appears on Machine B's clipboard
3. Latency under 200ms for text, under 1s for images
4. Works reliably 9/10 times without false triggers
5. Looks cool as fuck

---

## Reference: Existing Code Entry Points

**GestureRecognizer.ts** - Add new detection methods here:
- `detectPinch(landmarks)` 
- `detectThrow(landmarks)`
- Position history tracking

**App.tsx** - Add:
- ForceThrow HUD components
- State for throw controller
- IPC calls to clipboard sync

**electron/main.ts** - Add:
- WebSocket server setup
- IPC handlers: `clipboard-read`, `clipboard-write`, `send-to-peer`, `on-receive`

---

## Commands to Run

```powershell
# Install dependencies
npm install ws @types/ws

# Dev mode
npm run dev      # Terminal 1: Vite
npm run electron # Terminal 2: Electron

# On second machine, clone repo and run same commands
# Edit config/machines.json with each machine's IP
```

---

*This document is the complete context needed to implement Force Throw. Start with Phase 1 (network clipboard) and iterate.*
