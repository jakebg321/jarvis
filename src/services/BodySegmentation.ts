import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-backend-webgl';
import * as bodyPix from '@tensorflow-models/body-pix';

export class BodySegmentationService {
  private net: bodyPix.BodyPix | null = null;
  private backgroundImage: HTMLImageElement | null = null;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private _isReady = false;

  get isReady() {
    return this._isReady;
  }

  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d')!;
  }

  async initialize(backgroundUrl: string) {
    console.log('Initializing body segmentation with BodyPix...');

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
    console.log('Background image loaded');

    // Load BodyPix model
    this.net = await bodyPix.load({
      architecture: 'MobileNetV1',
      outputStride: 16,
      multiplier: 0.75,
      quantBytes: 2,
    });

    this._isReady = true;
    console.log('BodyPix initialized successfully');
  }

  async processFrame(video: HTMLVideoElement): Promise<HTMLCanvasElement | null> {
    if (!this.net || !this.backgroundImage || !this._isReady) {
      return null;
    }

    if (video.videoWidth === 0 || video.videoHeight === 0) {
      return null;
    }

    // Set canvas size to match video
    this.canvas.width = video.videoWidth;
    this.canvas.height = video.videoHeight;

    try {
      // Get segmentation
      const segmentation = await this.net.segmentPerson(video, {
        flipHorizontal: true, // Mirror to match video
        internalResolution: 'medium',
        segmentationThreshold: 0.7,
      });

      // Draw background
      this.ctx.drawImage(
        this.backgroundImage,
        0, 0,
        this.canvas.width, this.canvas.height
      );

      // Create mask from segmentation
      const mask = bodyPix.toMask(segmentation);

      // Create temp canvas for masked video
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = this.canvas.width;
      tempCanvas.height = this.canvas.height;
      const tempCtx = tempCanvas.getContext('2d')!;

      // Draw video (already flipped by segmentPerson)
      tempCtx.save();
      tempCtx.scale(-1, 1);
      tempCtx.drawImage(video, -this.canvas.width, 0);
      tempCtx.restore();

      // Get video image data
      const videoData = tempCtx.getImageData(0, 0, this.canvas.width, this.canvas.height);

      // Apply mask - where mask is person (not background), keep video pixel
      for (let i = 0; i < mask.data.length; i += 4) {
        // mask.data[i] is 0 for person, 255 for background (with default settings)
        // We want to show video where person is
        if (mask.data[i] === 0) {
          // Person - keep video pixel visible
          videoData.data[i + 3] = 255;
        } else {
          // Background - make transparent
          videoData.data[i + 3] = 0;
        }
      }

      tempCtx.putImageData(videoData, 0, 0);

      // Composite masked video onto background
      this.ctx.drawImage(tempCanvas, 0, 0);

      return this.canvas;
    } catch (error) {
      console.error('BodyPix segmentation error:', error);
      return null;
    }
  }
}
