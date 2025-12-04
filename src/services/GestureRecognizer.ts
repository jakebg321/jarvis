import { FilesetResolver, HandLandmarker, FaceLandmarker } from '@mediapipe/tasks-vision';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';

export class GestureRecognizer {
    private handLandmarker: HandLandmarker | null = null;
    private faceLandmarker: FaceLandmarker | null = null;
    private runningMode: 'IMAGE' | 'VIDEO' = 'VIDEO';
    private lastVideoTime = -1;
    private _faceDetected = false;
    private _blendshapes: Record<string, number> = {};

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

            // No face = no hand tracking
            if (!this._faceDetected) {
                return null;
            }

            const results = this.handLandmarker.detectForVideo(video, now);
            return results;
        }
        return null;
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
        const indexIsOpen = landmarks[8].y < landmarks[6].y;
        const middleIsOpen = landmarks[12].y < landmarks[10].y;
        const ringIsOpen = landmarks[16].y < landmarks[14].y;
        const pinkyIsOpen = landmarks[20].y < landmarks[18].y;

        const wristX = landmarks[0].x;
        const thumbTipX = landmarks[4].x;
        const thumbIPX = landmarks[3].x;
        const thumbIsOpen = Math.abs(thumbTipX - wristX) > Math.abs(thumbIPX - wristX);

        const fingerCount = [indexIsOpen, middleIsOpen, ringIsOpen, pinkyIsOpen].filter(Boolean).length;

        if (indexIsOpen && middleIsOpen && !ringIsOpen && !pinkyIsOpen) {
            return 'PEACE_SIGN';
        }

        if (thumbIsOpen && !indexIsOpen && !middleIsOpen && !ringIsOpen && !pinkyIsOpen) {
            return 'THUMBS_UP';
        }

        if (indexIsOpen && !middleIsOpen && !ringIsOpen && pinkyIsOpen) {
            return 'ROCK_ON';
        }

        if (fingerCount === 4) {
            return 'OPEN_PALM';
        }

        if (fingerCount === 0 && !thumbIsOpen) {
            return 'CLOSED_FIST';
        }

        if (indexIsOpen && !middleIsOpen && !ringIsOpen && !pinkyIsOpen) {
            return 'POINTING_UP';
        }

        if (indexIsOpen && middleIsOpen && ringIsOpen && !pinkyIsOpen) {
            return 'THREE_FINGERS';
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
        const indexIsOpen = landmarks[8].y < landmarks[6].y;
        const middleIsOpen = landmarks[12].y < landmarks[10].y;
        const ringIsOpen = landmarks[16].y < landmarks[14].y;
        const pinkyIsOpen = landmarks[20].y < landmarks[18].y;
        const wristX = landmarks[0].x;
        const thumbTipX = landmarks[4].x;
        const thumbIPX = landmarks[3].x;
        const thumbIsOpen = Math.abs(thumbTipX - wristX) > Math.abs(thumbIPX - wristX);

        return {
            thumb: thumbIsOpen,
            index: indexIsOpen,
            middle: middleIsOpen,
            ring: ringIsOpen,
            pinky: pinkyIsOpen,
        };
    }
}
