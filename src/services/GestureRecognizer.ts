import { FilesetResolver, HandLandmarker, FaceLandmarker } from '@mediapipe/tasks-vision';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';

export class GestureRecognizer {
    private handLandmarker: HandLandmarker | null = null;
    private faceLandmarker: FaceLandmarker | null = null;
    private runningMode: 'IMAGE' | 'VIDEO' = 'VIDEO';
    private lastVideoTime = -1;
    private _faceDetected = false;
    private _blendshapes: Record<string, number> = {};
    private _noseLandmark: { x: number; y: number } | null = null;
    private _faceLandmarks: Array<{ x: number; y: number; z: number }> | null = null;
    private _lastHandResults: ReturnType<HandLandmarker['detectForVideo']> | null = null;

    // Gesture hold tracking for debouncing
    private _currentGesture = 'UNKNOWN';
    private _gestureStartTime = 0;
    private _confirmedGesture = 'UNKNOWN';
    private readonly HOLD_THRESHOLD_MS = 300;

    get faceDetected() {
        return this._faceDetected;
    }

    get blendshapes() {
        return this._blendshapes;
    }

    get noseLandmark() {
        return this._noseLandmark;
    }

    get faceLandmarks() {
        return this._faceLandmarks;
    }

    async initialize() {
        const vision = await FilesetResolver.forVisionTasks(
            'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm'
        );

        this.handLandmarker = await HandLandmarker.createFromOptions(vision, {
            baseOptions: {
                modelAssetPath: '/models/hand_landmarker.task',
                delegate: 'GPU',
            },
            runningMode: this.runningMode,
            numHands: 2,
        });

        this.faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
            baseOptions: {
                modelAssetPath: '/models/face_landmarker.task',
                delegate: 'GPU',
            },
            runningMode: this.runningMode,
            numFaces: 1,
            outputFaceBlendshapes: true,
        });

        console.log('HandLandmarker + FaceLandmarker initialized');
    }

    detect(video: HTMLVideoElement) {
        if (!this.handLandmarker || !this.faceLandmarker) return null;

        if (video.currentTime !== this.lastVideoTime) {
            this.lastVideoTime = video.currentTime;
            const now = performance.now();

            // Check for face first
            const faceResults = this.faceLandmarker.detectForVideo(video, now);
            this._faceDetected = !!(faceResults?.faceLandmarks && faceResults.faceLandmarks.length > 0);

            // Extract blendshapes (facial expressions)
            if (faceResults?.faceBlendshapes && faceResults.faceBlendshapes.length > 0) {
                const shapes = faceResults.faceBlendshapes[0].categories;
                this._blendshapes = {};
                for (const shape of shapes) {
                    this._blendshapes[shape.categoryName] = shape.score;
                }
            }

            // Extract face landmarks
            if (faceResults?.faceLandmarks && faceResults.faceLandmarks.length > 0) {
                const landmarks = faceResults.faceLandmarks[0];
                this._faceLandmarks = landmarks.map(lm => ({ x: lm.x, y: lm.y, z: lm.z }));
                // Nose tip is index 1
                this._noseLandmark = { x: landmarks[1].x, y: landmarks[1].y };
            } else {
                this._faceLandmarks = null;
                this._noseLandmark = null;
            }

            // No face = no hand tracking
            if (!this._faceDetected) {
                this._lastHandResults = null;
                return null;
            }

            const results = this.handLandmarker.detectForVideo(video, now);
            this._lastHandResults = results;
            return results;
        }
        // Return cached results for duplicate frames
        return this._lastHandResults;
    }

    recognizeGestureWithHold(landmarks: NormalizedLandmark[]): string {
        const rawGesture = this.recognizeGesture(landmarks);
        const now = performance.now();

        if (rawGesture !== this._currentGesture) {
            this._currentGesture = rawGesture;
            this._gestureStartTime = now;
            return this._confirmedGesture;
        }

        if (now - this._gestureStartTime >= this.HOLD_THRESHOLD_MS) {
            this._confirmedGesture = rawGesture;
        }

        return this._confirmedGesture;
    }

    recognizeGesture(landmarks: NormalizedLandmark[]): string {
        // Check if fingers are extended - tip should be further from wrist than pip
        // Using distance from wrist instead of just Y comparison (works for any hand orientation)
        const wrist = landmarks[0];

        const distToWrist = (idx: number) => Math.hypot(landmarks[idx].x - wrist.x, landmarks[idx].y - wrist.y);

        // Finger is "open" if tip is further from wrist than the pip joint
        const indexIsOpen = distToWrist(8) > distToWrist(6);
        const middleIsOpen = distToWrist(12) > distToWrist(10);
        const ringIsOpen = distToWrist(16) > distToWrist(14);
        const pinkyIsOpen = distToWrist(20) > distToWrist(18);

        const thumbTipX = landmarks[4].x;
        const thumbIPX = landmarks[3].x;
        const thumbIsOpen = Math.abs(thumbTipX - wrist.x) > Math.abs(thumbIPX - wrist.x);

        const fingerCount = [indexIsOpen, middleIsOpen, ringIsOpen, pinkyIsOpen].filter(Boolean).length;

        // POINTING_UP first - most important for exiting command mode
        // Only index extended, others clearly closed
        if (indexIsOpen && !middleIsOpen && !ringIsOpen && !pinkyIsOpen) {
            return 'POINTING_UP';
        }

        if (indexIsOpen && middleIsOpen && !ringIsOpen && !pinkyIsOpen) {
            return 'PEACE_SIGN';
        }

        if (thumbIsOpen && !indexIsOpen && !middleIsOpen && !ringIsOpen && !pinkyIsOpen) {
            return 'THUMBS_UP';
        }

        if (indexIsOpen && !middleIsOpen && !ringIsOpen && pinkyIsOpen) {
            return 'ROCK_ON';
        }

        if (indexIsOpen && middleIsOpen && ringIsOpen && !pinkyIsOpen) {
            return 'THREE_FINGERS';
        }

        if (fingerCount === 0 && !thumbIsOpen) {
            return 'CLOSED_FIST';
        }

        // OPEN_PALM last - all 4 fingers must be open
        if (fingerCount === 4) {
            return 'OPEN_PALM';
        }

        if (fingerCount === 4 && !thumbIsOpen) {
            return 'FOUR_FINGERS';
        }

        if (fingerCount >= 1 && fingerCount <= 4) {
            return `FINGERS_${fingerCount}`;
        }

        return 'UNKNOWN';
    }

    getFingerStates(landmarks: NormalizedLandmark[]): Record<string, boolean> {
        const wrist = landmarks[0];
        const distToWrist = (idx: number) => Math.hypot(landmarks[idx].x - wrist.x, landmarks[idx].y - wrist.y);

        const indexIsOpen = distToWrist(8) > distToWrist(6);
        const middleIsOpen = distToWrist(12) > distToWrist(10);
        const ringIsOpen = distToWrist(16) > distToWrist(14);
        const pinkyIsOpen = distToWrist(20) > distToWrist(18);

        const thumbTipX = landmarks[4].x;
        const thumbIPX = landmarks[3].x;
        const thumbIsOpen = Math.abs(thumbTipX - wrist.x) > Math.abs(thumbIPX - wrist.x);

        return {
            thumb: thumbIsOpen,
            index: indexIsOpen,
            middle: middleIsOpen,
            ring: ringIsOpen,
            pinky: pinkyIsOpen,
        };
    }
}
