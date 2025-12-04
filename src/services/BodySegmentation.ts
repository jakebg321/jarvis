import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-backend-webgl';
import * as bodyPix from '@tensorflow-models/body-pix';
import { POWER_MODE_CONFIGS, type PowerMode, type BodyPixConfig } from '../config/PowerModes';

export class BodySegmentationService {
  private net: bodyPix.BodyPix | null = null;
  private backgroundImage: HTMLImageElement | null = null;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tempCanvas: HTMLCanvasElement;
  private tempCtx: CanvasRenderingContext2D;
  private maskCanvas: HTMLCanvasElement;
  private maskCtx: CanvasRenderingContext2D;
  private blurCanvas: HTMLCanvasElement;
  private blurCtx: CanvasRenderingContext2D;
  private _isReady = false;

  // Power mode support
  private _currentMode: PowerMode = 'MEDIUM';
  private _config: BodyPixConfig;
  private _frameCount = 0;
  private _lastProcessedFrame: HTMLCanvasElement | null = null;
  private _backgroundUrl: string = '';

  get isReady() {
    return this._isReady && this._config.enabled;
  }

  get currentMode(): PowerMode {
    return this._currentMode;
  }

  get isEnabled(): boolean {
    return this._config.enabled;
  }

  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d')!;
    this.tempCanvas = document.createElement('canvas');
    this.tempCtx = this.tempCanvas.getContext('2d')!;
    this.maskCanvas = document.createElement('canvas');
    this.maskCtx = this.maskCanvas.getContext('2d')!;
    this.blurCanvas = document.createElement('canvas');
    this.blurCtx = this.blurCanvas.getContext('2d')!;
    this._config = POWER_MODE_CONFIGS['MEDIUM'];
  }

  async initialize(backgroundUrl: string, mode: PowerMode = 'MEDIUM') {
    console.log(`Initializing body segmentation with mode: ${mode}`);
    this._backgroundUrl = backgroundUrl;
    this._currentMode = mode;
    this._config = POWER_MODE_CONFIGS[mode];

    if (!this._config.enabled) {
      console.log('Body segmentation disabled (OFF mode)');
      this._isReady = true;
      return;
    }

    // Set TensorFlow.js backend
    await tf.setBackend('webgl');
    await tf.ready();
    console.log('TensorFlow.js backend:', tf.getBackend());

    // Load background image
    this.backgroundImage = new Image();
    this.backgroundImage.crossOrigin = 'anonymous';
    await new Promise<void>((resolve, reject) => {
      this.backgroundImage!.onload = () => resolve();
      this.backgroundImage!.onerror = reject;
      this.backgroundImage!.src = backgroundUrl;
    });
    console.log('Background image loaded:', this.backgroundImage.width, 'x', this.backgroundImage.height);

    // Load BodyPix model with mode-specific config
    await this.loadModel();

    this._isReady = true;
    console.log(`BodyPix initialized with ${mode} mode (${this._config.architecture})`);
  }

  private async loadModel(): Promise<void> {
    console.log(`Loading BodyPix model: ${this._config.architecture}, stride: ${this._config.outputStride}, multiplier: ${this._config.multiplier}`);

    this.net = await bodyPix.load({
      architecture: this._config.architecture,
      outputStride: this._config.outputStride as 8 | 16 | 32,
      multiplier: this._config.multiplier,
      quantBytes: this._config.quantBytes,
    });
  }

  async setMode(mode: PowerMode): Promise<void> {
    if (mode === this._currentMode) return;

    const newConfig = POWER_MODE_CONFIGS[mode];
    const oldConfig = this._config;

    console.log(`Switching power mode: ${this._currentMode} -> ${mode}`);

    this._currentMode = mode;
    this._config = newConfig;
    this._frameCount = 0;
    this._lastProcessedFrame = null;

    // If switching to OFF, just disable
    if (!newConfig.enabled) {
      console.log('Body segmentation disabled');
      return;
    }

    // If was OFF, need to initialize
    if (!oldConfig.enabled) {
      if (!this.backgroundImage && this._backgroundUrl) {
        // Reload background image
        this.backgroundImage = new Image();
        this.backgroundImage.crossOrigin = 'anonymous';
        await new Promise<void>((resolve, reject) => {
          this.backgroundImage!.onload = () => resolve();
          this.backgroundImage!.onerror = reject;
          this.backgroundImage!.src = this._backgroundUrl;
        });
      }
      await this.loadModel();
      return;
    }

    // If architecture or key params changed, need to reload model
    if (oldConfig.architecture !== newConfig.architecture ||
        oldConfig.outputStride !== newConfig.outputStride ||
        oldConfig.multiplier !== newConfig.multiplier ||
        oldConfig.quantBytes !== newConfig.quantBytes) {

      console.log('Model architecture changed, reloading...');

      // Dispose old model
      if (this.net) {
        this.net.dispose();
        this.net = null;
      }

      // Load new model
      await this.loadModel();
      console.log(`Model reloaded for ${mode} mode`);
    } else {
      console.log('Same architecture, no reload needed');
    }
  }

  async processFrame(video: HTMLVideoElement): Promise<HTMLCanvasElement | null> {
    // OFF mode - return null
    if (!this._config.enabled) {
      return null;
    }

    if (!this.net || !this.backgroundImage || !this._isReady) {
      return null;
    }

    if (video.videoWidth === 0 || video.videoHeight === 0) {
      return null;
    }

    // Frame skipping for LOW mode
    this._frameCount++;
    if (this._config.frameSkip > 0) {
      if (this._frameCount % (this._config.frameSkip + 1) !== 0) {
        // Return last processed frame to maintain smooth display
        return this._lastProcessedFrame;
      }
    }

    const width = video.videoWidth;
    const height = video.videoHeight;

    // Set canvas sizes
    this.canvas.width = width;
    this.canvas.height = height;
    this.tempCanvas.width = width;
    this.tempCanvas.height = height;
    this.maskCanvas.width = width;
    this.maskCanvas.height = height;
    this.blurCanvas.width = width;
    this.blurCanvas.height = height;

    try {
      // Get segmentation
      const segmentation = await this.net.segmentPerson(video, {
        flipHorizontal: false,
        internalResolution: this._config.internalResolution,
        segmentationThreshold: this._config.segmentationThreshold,
      });

      // Step 1: Draw background image to main canvas
      this.ctx.drawImage(this.backgroundImage, 0, 0, width, height);

      // Step 2: Draw video frame to temp canvas
      this.tempCtx.drawImage(video, 0, 0, width, height);

      // Step 3: Create mask
      const maskImageData = this.maskCtx.createImageData(width, height);
      const segData = segmentation.data;

      for (let i = 0; i < segData.length; i++) {
        const pixelIndex = i * 4;
        if (segData[i] === 1) {
          // Person - white/opaque
          maskImageData.data[pixelIndex] = 255;
          maskImageData.data[pixelIndex + 1] = 255;
          maskImageData.data[pixelIndex + 2] = 255;
          maskImageData.data[pixelIndex + 3] = 255;
        } else {
          // Background - black/transparent
          maskImageData.data[pixelIndex] = 0;
          maskImageData.data[pixelIndex + 1] = 0;
          maskImageData.data[pixelIndex + 2] = 0;
          maskImageData.data[pixelIndex + 3] = 0;
        }
      }
      this.maskCtx.putImageData(maskImageData, 0, 0);

      // Step 4: Apply edge blur if configured (HIGH/ULTRA modes)
      let finalMaskData: ImageData;
      if (this._config.edgeBlur > 0) {
        // Use CSS filter for blur
        this.blurCtx.filter = `blur(${this._config.edgeBlur}px)`;
        this.blurCtx.drawImage(this.maskCanvas, 0, 0);
        this.blurCtx.filter = 'none';
        finalMaskData = this.blurCtx.getImageData(0, 0, width, height);
      } else {
        finalMaskData = this.maskCtx.getImageData(0, 0, width, height);
      }

      // Step 5: Apply mask to video
      const videoData = this.tempCtx.getImageData(0, 0, width, height);
      for (let i = 0; i < width * height; i++) {
        const pixelIndex = i * 4;
        // Use mask alpha for smooth edges (after blur)
        const maskAlpha = finalMaskData.data[pixelIndex + 3];
        if (maskAlpha < 128) {
          // More background than person - make transparent
          videoData.data[pixelIndex + 3] = 0;
        } else if (this._config.edgeBlur > 0 && maskAlpha < 255) {
          // Partial alpha for soft edges
          videoData.data[pixelIndex + 3] = maskAlpha;
        }
        // else: full alpha, keep as is
      }
      this.tempCtx.putImageData(videoData, 0, 0);

      // Step 6: Composite masked video onto background
      this.ctx.drawImage(this.tempCanvas, 0, 0);

      // Step 7: Flip the final result horizontally (mirror effect)
      this.tempCtx.save();
      this.tempCtx.scale(-1, 1);
      this.tempCtx.drawImage(this.canvas, -width, 0);
      this.tempCtx.restore();

      // Copy flipped result back to main canvas
      this.ctx.drawImage(this.tempCanvas, 0, 0);

      // Cache for frame skipping
      this._lastProcessedFrame = this.canvas;

      return this.canvas;
    } catch (error) {
      console.error('BodyPix segmentation error:', error);
      return null;
    }
  }

  dispose(): void {
    if (this.net) {
      this.net.dispose();
      this.net = null;
    }
    this._isReady = false;
    this._lastProcessedFrame = null;
    console.log('BodySegmentation disposed');
  }
}
