// Power mode definitions for JARVIS

export const POWER_MODES = ['OFF', 'LOW', 'MEDIUM', 'HIGH', 'ULTRA'] as const;
export type PowerMode = typeof POWER_MODES[number];

export interface BodyPixConfig {
  enabled: boolean;
  architecture: 'MobileNetV1' | 'ResNet50';
  outputStride: 8 | 16 | 32;
  multiplier: 0.5 | 0.75 | 1.0;
  quantBytes: 1 | 2 | 4;
  internalResolution: 'low' | 'medium' | 'high' | 'full';
  segmentationThreshold: number;
  frameSkip: number;
  edgeBlur: number;
}

export const POWER_MODE_CONFIGS: Record<PowerMode, BodyPixConfig> = {
  OFF: {
    enabled: false,
    architecture: 'MobileNetV1',
    outputStride: 32,
    multiplier: 0.5,
    quantBytes: 2,
    internalResolution: 'low',
    segmentationThreshold: 0.5,
    frameSkip: 0,
    edgeBlur: 0,
  },
  LOW: {
    enabled: true,
    architecture: 'MobileNetV1',
    outputStride: 32,
    multiplier: 0.5,
    quantBytes: 2,
    internalResolution: 'low',
    segmentationThreshold: 0.5,
    frameSkip: 2,
    edgeBlur: 0,
  },
  MEDIUM: {
    enabled: true,
    architecture: 'MobileNetV1',
    outputStride: 16,
    multiplier: 0.75,
    quantBytes: 2,
    internalResolution: 'medium',
    segmentationThreshold: 0.6,
    frameSkip: 0,
    edgeBlur: 0,
  },
  HIGH: {
    enabled: true,
    architecture: 'MobileNetV1',
    outputStride: 16,
    multiplier: 1.0,
    quantBytes: 2,
    internalResolution: 'high',
    segmentationThreshold: 0.7,
    frameSkip: 0,
    edgeBlur: 3,
  },
  ULTRA: {
    enabled: true,
    architecture: 'ResNet50',
    outputStride: 16,
    multiplier: 1.0,
    quantBytes: 4,
    internalResolution: 'full',
    segmentationThreshold: 0.7,
    frameSkip: 0,
    edgeBlur: 5,
  },
};

const MACHINE_DEFAULTS: Record<string, PowerMode> = {
  'DESKTOP-6DSRLIR': 'HIGH',
  'Ceres': 'MEDIUM',
};

export function getDefaultPowerMode(hostname: string): PowerMode {
  if (MACHINE_DEFAULTS[hostname]) {
    return MACHINE_DEFAULTS[hostname];
  }
  const lower = hostname.toLowerCase();
  if (lower.includes('desktop') || lower.includes('workstation')) {
    return 'HIGH';
  }
  return 'MEDIUM';
}

export const POWER_MODE_STORAGE_KEY = 'jarvis_power_mode';
