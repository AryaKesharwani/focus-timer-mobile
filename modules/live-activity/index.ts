import { requireNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

export type LiveActivityMode = 'focus' | 'shortBreak' | 'longBreak';

export type StartArgs = {
  startTime: number;
  endTime: number;
  totalDuration: number;
  mode: LiveActivityMode;
  label?: string;
};

export type UpdateArgs = {
  endTime: number;
  mode: LiveActivityMode;
  label?: string;
  isPaused?: boolean;
  pausedRemainingSec?: number;
};

type NativeShape = {
  isSupported(): boolean;
  start(args: {
    startTime: number;
    endTime: number;
    totalDuration: number;
    mode: string;
    label: string;
  }): Promise<string | null>;
  update(args: {
    endTime: number;
    mode: string;
    label: string;
    isPaused: boolean;
    pausedRemainingSec: number;
  }): Promise<void>;
  end(): Promise<void>;
};

let cached: NativeShape | null = null;
function nativeOrNull(): NativeShape | null {
  if (Platform.OS !== 'ios') return null;
  if (cached) return cached;
  try {
    cached = requireNativeModule('LiveActivityModule') as NativeShape;
    return cached;
  } catch {
    return null;
  }
}

export const LiveActivity = {
  isSupported(): boolean {
    const n = nativeOrNull();
    if (!n) return false;
    try {
      return n.isSupported();
    } catch {
      return false;
    }
  },
  async start(args: StartArgs): Promise<string | null> {
    const n = nativeOrNull();
    if (!n) return null;
    try {
      return await n.start({
        startTime: args.startTime,
        endTime: args.endTime,
        totalDuration: args.totalDuration,
        mode: args.mode,
        label: args.label ?? '',
      });
    } catch {
      return null;
    }
  },
  async update(args: UpdateArgs): Promise<void> {
    const n = nativeOrNull();
    if (!n) return;
    try {
      await n.update({
        endTime: args.endTime,
        mode: args.mode,
        label: args.label ?? '',
        isPaused: args.isPaused ?? false,
        pausedRemainingSec: args.pausedRemainingSec ?? 0,
      });
    } catch {}
  },
  async end(): Promise<void> {
    const n = nativeOrNull();
    if (!n) return;
    try {
      await n.end();
    } catch {}
  },
};
