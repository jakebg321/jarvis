# JARVIS Design State - Current Status & Open Questions

## What We Have Working

### Core System
- **Face-gated hand tracking**: Hand tracking only activates when face detected (prevents false triggers when looking away)
- **RAYCAST pointer**: Projects ray from wrist through index fingertip - point like a gun to aim
- **Force Grip precision mode**: Curl all fingers slightly (Palpatine style) to slow pointer for fine control
- **Single hand mode**: Settings panel lets you pick LEFT or RIGHT hand - only that hand controls the system

### Settings Panel (top right)
- Hand selection (LEFT/RIGHT)
- Raycast Factor (1x-10x): How much small movements amplify to screen movement
- Precision Speed (1%-100%): How slow the pointer moves in Force Grip mode
- Smoothing (5%-95%): Reduces jitter but adds lag

### Performance
- Batched React updates at 20fps (ML runs at full speed)
- GPU usage estimate displayed (based on inference time)
- FPS counter

### Current Gesture Mappings
| Gesture | Current Action |
|---------|---------------|
| POINTING_UP | Launch Chrome |
| PEACE_SIGN | Screenshot |
| THREE_FINGERS | Launch VS Code |
| FOUR_FINGERS | Launch Slack |
| THUMBS_UP | Launch Explorer |
| ROCK_ON | Launch Terminal |
| CLOSED_FIST | Grab/drag panels |
| OPEN_PALM | Release grabbed panel |

---

## The Core Design Problem: Commands vs Motion

### The Challenge
You want to use gestures for TWO different things:
1. **Continuous control** - Moving the pointer (needs to track smoothly)
2. **Discrete commands** - Trigger an action (switch terminal, click, enter)

These conflict because:
- While pointing to aim, your hand naturally shifts and fingers move slightly
- A gesture that triggers "click" could accidentally fire while you're just aiming
- Swipe gestures for "next terminal" could trigger while you're just moving the pointer

### Current Solution: Hold-to-Confirm
We have a 300ms hold threshold - you must hold a gesture stable for 300ms before it triggers. This helps but isn't perfect for rapid workflows.

---

## Proposed Solution: Modal Gestures

### The Idea: Two Modes

**AIM MODE** (default when index finger extended)
- Pointer tracks your hand
- NO gesture actions trigger
- You're purely aiming/positioning

**COMMAND MODE** (activated by specific pose)
- Pointer FREEZES in place
- Gestures now trigger actions
- Exit back to aim mode when done

### How to Enter Command Mode?
Options:
1. **Force Grip** - Currently used for precision, could double as command mode entry
2. **Closed Fist** - Clear "stop" signal
3. **Thumb Out** (hitchhiker) - Distinct pose
4. **Open Palm** (stop hand) - Universal "halt" signal

### Workflow Example: Terminal Switching

```
1. Point to aim at screen area (AIM MODE)
2. Make fist or open palm (enters COMMAND MODE, pointer freezes)
3. Show 1 finger = Terminal 1, 2 fingers = Terminal 2, etc.
4. Point again (exits COMMAND MODE, back to aiming)
```

Or with swipes:
```
1. Point to aim (AIM MODE)
2. Open palm (COMMAND MODE - pointer freezes)
3. Swipe left/right = prev/next terminal
4. Thumbs up = click at frozen pointer position
5. Point again (back to AIM MODE)
```

---

## Your Terminal Workflow - Detailed

### What You Want to Do
1. Switch between 4 WSL terminals
2. Click inside the terminal's text input area
3. Trigger voice-to-text
4. Press Enter to submit

### Technical Options

**Terminal Switching:**
- Windows Terminal: `Ctrl+Tab` (next), `Ctrl+Shift+Tab` (prev), `Alt+1-4` (direct)
- Or: Click on specific terminal window

**Click in Terminal:**
- Most terminals auto-focus input on click anywhere in window
- Could use robotjs to click at pointer position
- Or: Just focus the window and it's ready for input

**Voice-to-Text:**
- Windows: `Win+H` starts dictation
- Or: Integrate with your existing voice-to-text setup

**Enter/Submit:**
- Send Enter keypress via robotjs

### Proposed Gesture Flow

```
STATE: Aiming at Terminal 2 area
YOU: Open palm (freeze pointer, enter command mode)

STATE: Command mode, pointer frozen
YOU: Two fingers (peace sign)
JARVIS: Sends Alt+2 (switch to terminal 2)

YOU: Thumbs up
JARVIS: Clicks at frozen pointer position (focuses terminal)

YOU: Three fingers
JARVIS: Sends Win+H (voice-to-text)

[You speak your command]

YOU: Closed fist
JARVIS: Sends Enter

YOU: Point finger
STATE: Back to aiming mode, pointer unfreezes
```

---

## Open Questions

1. **What gesture should enter COMMAND MODE?**
   - Open palm? Fist? Something else?

2. **What gesture should exit COMMAND MODE?**
   - Point finger? Same gesture that entered? Timeout?

3. **Should pointer freeze or stay active in command mode?**
   - Freeze = stable click target
   - Active = can adjust while in command mode

4. **Do you want direct terminal numbers (1-4 fingers) or next/prev swipes?**

5. **How do you want to trigger the click?**
   - Thumbs up?
   - Quick fist pump?
   - Specific finger pose?

6. **What about accidental triggers?**
   - Keep the 300ms hold?
   - Require two-step confirmation for destructive actions?

---

## Files Reference

- `src/App.tsx` - Main UI and gesture handling (~830 lines)
- `src/services/GestureRecognizer.ts` - MediaPipe detection + gesture classification
- `electron/main.ts` - IPC handlers for system actions (screenshot, launch apps)
- Need to add: Keyboard/mouse simulation via robotjs for terminal control
