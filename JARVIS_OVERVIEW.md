# JARVIS - Gesture Control HUD

## What It Is
A real-time gesture recognition overlay that uses your webcam to detect hand poses and facial expressions, then triggers system actions. Think Tony Stark but for a dev with 10 monitors.

## Current Tech Stack
- **Frontend**: Electron + React + Vite + TypeScript
- **Vision**: MediaPipe HandLandmarker (21 hand landmarks) + FaceLandmarker (468 face landmarks + 52 blendshapes)
- **System Control**: RobotJS (keyboard/mouse simulation)
- **Platform**: Windows (native modules)

---

## The Hard Problems

### 1. Your Right Hand is Fucked
Current gesture detection is symmetric - we can flip the logic for left-hand only mode, or design gestures that work with limited finger mobility:
- **Fist variations** work regardless
- **Thumb-only** gestures (thumbs up/down/sideways)
- **Wrist rotation** (palm up vs palm down)
- **Hand position** (raise hand to top/bottom/left/right of frame)
- **Two-hand combos** where left does the complex part

**Quick fix**: We can add a LEFT_HAND_PRIMARY mode that mirrors all detection.

### 2. Darkness / Lighting
MediaPipe struggles in low light. Options:
- **IR camera** (like Xbox Kinect) - works in total darkness
- **Minimum brightness threshold** - warn user when confidence drops
- **RGB LED strip behind monitor** - provides consistent face lighting
- **Night mode** - increase camera exposure/gain programmatically

Current confidence scores from MediaPipe could trigger a "LOW VISIBILITY" warning in the HUD.

### 3. Programming Every Motion Sucks
You're right - hardcoding `if (index && middle && !ring)` is fragile. Better approaches:

#### Option A: MediaPipe Gesture Recognizer (Built-in)
MediaPipe has a separate `GestureRecognizer` task that comes pre-trained:
- Closed_Fist, Open_Palm, Pointing_Up, Thumb_Down, Thumb_Up, Victory, ILoveYou
- Can be fine-tuned with custom gestures
- https://ai.google.dev/edge/mediapipe/solutions/vision/gesture_recognizer

#### Option B: Train Custom Classifier
Record samples → extract landmark positions → train a simple NN/SVM:
- Collect 50-100 samples per gesture
- Normalize hand position/scale
- Train classifier on relative joint angles
- Export to TensorFlow.js or ONNX

#### Option C: Gesture Libraries
- **fingerpose** (npm) - Define gestures as finger curl/direction descriptions
- **handtrack.js** - Simpler but less accurate
- **TensorFlow.js hand-pose-detection** - Alternative to MediaPipe

### 4. Subtle Gestures (Not Looking Like a Crazy Person)
The goal is gestures you wouldn't do accidentally but also aren't theatrical:

**Good Ideas:**
- Finger taps (index tip touches thumb tip = click)
- Pinch and drag (two-finger pinch = grab)
- Finger count held for 500ms
- Hand raise to specific zone + hold
- Double-tap gesture (like double-click but with fingers)

**Eye/Face Triggers (Already Have Blendshapes!):**
- Extended wink (hold 500ms) = confirm action
- Eyebrow raise = show command palette
- Mouth open wide = voice activation trigger
- Look left/right = switch monitor focus

**Combo System:**
- Fist + eye wink = confirm destructive action
- Palm + nod = "yes, do it"

---

## Mapping to Your Mouse Buttons

| Mouse Action | Gesture Equivalent |
|--------------|-------------------|
| Scroll wheel window switch | Swipe left/right (track hand X velocity) |
| Click left = down | Point down (index pointing at floor) |
| Click right = up | Point up (index pointing at ceiling) |
| Screenshot | Peace sign (or wink if hand is fucked) |
| Enter | Thumbs up |
| Voice to text | Mouth open wide (triggers listening mode) |
| Copy | Pinch gesture (thumb + index) |
| Paste | Release pinch / open palm after pinch |

---

## Accuracy Assessment

### What Works Well
- **Finger extension detection**: Very reliable in good lighting
- **Facial blendshapes**: Eye blinks, mouth open, smiles - all sub-100ms response
- **Hand tracking**: Solid 25-30fps even on integrated GPU
- **Face gating**: Stops false triggers when looking away

### What's Sketchy
- **Thumb detection**: Trickier due to rotation plane
- **Similar gestures**: 3 fingers vs 4 fingers can flicker
- **Fast movements**: Tracking lags on quick motions
- **Occlusion**: Fingers blocking each other = confusion

### Precision Numbers (Rough)
- Hand position: ~20px accuracy at arm's length
- Finger state (open/closed): 85-90% accuracy
- Gesture classification: 70-80% for complex ones, 95%+ for simple (fist/palm)
- Face detection: 98%+ when facing camera
- Blendshapes: Very precise (0-1 float values, smooth)

---

## The Business Angle (Since You Mentioned Selling)

### Who Would Pay For This
1. **Accessibility users** - RSI, carpal tunnel, limited mobility
2. **Streamers** - Gesture-triggered overlays, scene switches
3. **Presentation nerds** - Control slides without clicker
4. **DAW/Video editors** - Hands-free timeline scrubbing
5. **Surgeons/Lab techs** - Sterile environment, can't touch keyboard
6. **Gamers** - Secondary input layer

### Competitive Landscape
- **Leap Motion**: Hardware-based, expensive, discontinued consumer version
- **Kinect**: Dead
- **Ultraleap**: Enterprise pricing ($$$)
- **Software-only solutions**: Mostly garbage or research projects

### Why This Could Work
- Zero hardware (just webcam)
- MediaPipe is free and runs locally (privacy)
- Electron = cross-platform with minimal effort
- Customizable gestures = power users love it

### Why It Might Not
- Webcam quality varies wildly
- Lighting dependency
- Learning curve for gestures
- CPU/GPU usage in background

---

## Next Steps (If We're Actually Doing This)

### Immediate
1. [ ] Add left-hand primary mode for your busted right hand
2. [ ] Add "confidence" indicator to HUD (warn when detection is poor)
3. [ ] Implement velocity tracking for swipe gestures
4. [ ] Add eye-based triggers (wink = confirm)

### Short Term
5. [ ] Replace hardcoded gesture logic with fingerpose or custom classifier
6. [ ] Add gesture recording/training mode in UI
7. [ ] Implement gesture combos (gesture + face = action)
8. [ ] Add configurable action mappings (JSON/UI)

### If We're Selling This
9. [ ] Strip Electron, make it a system tray app
10. [ ] Add onboarding/calibration flow
11. [ ] Build gesture library marketplace
12. [ ] Usage analytics (opt-in)
13. [ ] Trial/license system

---

## Run Commands
```powershell
cd C:\Users\jakeb\VSCODE\jarvis
npm run dev      # Start Vite dev server
npm run electron # Start Electron (separate terminal)
```

## File Map
```
src/
  App.tsx                    # Main UI, canvas drawing, HUD
  services/
    GestureRecognizer.ts     # MediaPipe wrapper, gesture detection
electron/
  main.ts                    # Electron main process, IPC handlers, RobotJS
public/
  models/
    hand_landmarker.task     # MediaPipe hand model
    face_landmarker.task     # MediaPipe face model
```

---

*Last updated: Session 2 - Added HUD visuals, functional gestures, IPC actions*
