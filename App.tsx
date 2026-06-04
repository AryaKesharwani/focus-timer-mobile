import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAudioPlayer } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import { useKeepAwake } from 'expo-keep-awake';
import * as Notifications from 'expo-notifications';
import { SchedulableTriggerInputTypes } from 'expo-notifications';
import { StatusBar } from 'expo-status-bar';
import { LiveActivity } from 'live-activity';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import Svg, { Circle } from 'react-native-svg';

const DURATION_PRESETS_MIN = [15, 25, 30, 45, 60] as const;
const DEFAULT_DURATION_MIN = 30;
const SHORT_BREAK_SEC = 5 * 60;
const LONG_BREAK_SEC = 15 * 60;
const POMODOROS_PER_LONG_BREAK = 4;
const STORAGE_KEY = 'focus-timer/history-v2';

type Mode = 'focus' | 'shortBreak' | 'longBreak';
type Phase = 'idle' | 'running' | 'paused';
type Screen = 'timer' | 'stats';

type SessionItem = {
  endedAt: number;
  durationSec: number;
  label: string;
};
type DailyStat = {
  sessions: number;
  focusSeconds: number;
  items: SessionItem[];
};
type History = Record<string, DailyStat>;

type AmbientChoice = 'off' | 'rain' | 'forest' | 'whiteNoise';

// Public CC0 ambient sound URLs. If a URL fails to load, the picker still
// works but audio will be silent. Replace with local require()'d files for
// offline playback — e.g. require('./assets/sounds/rain.mp3').
const AMBIENT_SOURCES: Record<
  Exclude<AmbientChoice, 'off'>,
  { uri: string; label: string }
> = {
  rain: {
    label: 'Rain',
    uri: 'https://cdn.pixabay.com/audio/2022/03/10/audio_d3d05dcc97.mp3',
  },
  forest: {
    label: 'Forest',
    uri: 'https://cdn.pixabay.com/audio/2022/03/15/audio_4c7c3f4769.mp3',
  },
  whiteNoise: {
    label: 'White noise',
    uri: 'https://cdn.pixabay.com/audio/2022/03/10/audio_2dde668ca0.mp3',
  },
};

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

function dayKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function shiftedDayKey(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return dayKey(d);
}

function shortWeekday(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return ['S', 'M', 'T', 'W', 'T', 'F', 'S'][d.getDay()];
}

async function loadHistory(): Promise<History> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as History) : {};
  } catch {
    return {};
  }
}

async function persistHistory(h: History): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(h));
  } catch {}
}

function computeStreak(history: History): number {
  let streak = 0;
  for (let i = 0; i < 365; i++) {
    const k = shiftedDayKey(i);
    const d = history[k];
    if (d && d.sessions > 0) {
      streak += 1;
    } else if (i === 0) {
      // today has no sessions yet — streak might still be alive from yesterday
      continue;
    } else {
      break;
    }
  }
  return streak;
}

function formatTime(totalSeconds: number): string {
  const safe = Math.max(0, Math.ceil(totalSeconds));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatFocused(seconds: number): string {
  const totalMin = Math.round(seconds / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

async function ensureNotificationPermission(): Promise<boolean> {
  const settings = await Notifications.getPermissionsAsync();
  if (settings.granted) return true;
  if (settings.canAskAgain === false) return false;
  const req = await Notifications.requestPermissionsAsync();
  return req.granted;
}

async function scheduleEndNotification(
  mode: Mode,
  seconds: number,
): Promise<string | null> {
  try {
    const id = await Notifications.scheduleNotificationAsync({
      content: {
        title:
          mode === 'focus'
            ? 'Focus session complete'
            : mode === 'longBreak'
              ? 'Long break over'
              : 'Break over',
        body:
          mode === 'focus'
            ? 'Nice work — taking a break.'
            : 'Ready for the next focus session?',
        sound: 'default',
      },
      trigger: {
        type: SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: Math.max(1, Math.round(seconds)),
        repeats: false,
      },
    });
    return id;
  } catch {
    return null;
  }
}

export default function App() {
  const { width } = useWindowDimensions();

  const [screen, setScreen] = useState<Screen>('timer');
  const [mode, setMode] = useState<Mode>('focus');
  const [phase, setPhase] = useState<Phase>('idle');
  const [durationMinutes, setDurationMinutes] = useState(DEFAULT_DURATION_MIN);
  const [totalSeconds, setTotalSeconds] = useState(DEFAULT_DURATION_MIN * 60);
  const [remaining, setRemaining] = useState(DEFAULT_DURATION_MIN * 60);
  const [taskLabel, setTaskLabel] = useState('');
  const [activeLabel, setActiveLabel] = useState('');
  const [pomodorosInCycle, setPomodorosInCycle] = useState(0);
  const [history, setHistory] = useState<History>({});
  const [ambient, setAmbient] = useState<AmbientChoice>('off');

  const endTimeRef = useRef<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const notifIdRef = useRef<string | null>(null);

  useKeepAwake();

  const ambientSource =
    ambient === 'off' ? null : AMBIENT_SOURCES[ambient];
  const player = useAudioPlayer(ambientSource);

  useEffect(() => {
    loadHistory().then(setHistory).catch(() => {});
    ensureNotificationPermission().catch(() => {});
  }, []);

  useEffect(() => {
    if (!player) return;
    try {
      player.loop = true;
      player.volume = 0.6;
    } catch {}
  }, [player, ambient]);

  // Drive ambient playback off the phase.
  useEffect(() => {
    if (!player) return;
    try {
      if (phase === 'running' && mode === 'focus' && ambient !== 'off') {
        player.play();
      } else {
        player.pause();
      }
    } catch {}
  }, [player, phase, mode, ambient]);

  const clearInternalTimer = useCallback(() => {
    if (intervalRef.current != null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const cancelScheduledNotif = useCallback(async () => {
    const id = notifIdRef.current;
    notifIdRef.current = null;
    if (id) {
      try {
        await Notifications.cancelScheduledNotificationAsync(id);
      } catch {}
    }
  }, []);

  useEffect(
    () => () => {
      clearInternalTimer();
      cancelScheduledNotif();
      LiveActivity.end().catch(() => {});
    },
    [clearInternalTimer, cancelScheduledNotif],
  );

  // Forward declarations resolved via refs.
  const completeRef = useRef<() => void>(() => {});

  // Tick interval driven by phase.
  useEffect(() => {
    if (phase !== 'running' || endTimeRef.current == null) return;
    const tick = () => {
      if (endTimeRef.current == null) return;
      const secondsLeft = (endTimeRef.current - Date.now()) / 1000;
      if (secondsLeft <= 0) {
        completeRef.current();
      } else {
        setRemaining(secondsLeft);
      }
    };
    intervalRef.current = setInterval(tick, 200);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [phase]);

  const recordCompletedFocus = useCallback(
    async (durationSec: number, label: string) => {
      const k = dayKey();
      const item: SessionItem = {
        endedAt: Date.now(),
        durationSec,
        label: label.trim(),
      };
      const next: History = { ...history };
      const prev = next[k] ?? { sessions: 0, focusSeconds: 0, items: [] };
      next[k] = {
        sessions: prev.sessions + 1,
        focusSeconds: prev.focusSeconds + durationSec,
        items: [...prev.items, item],
      };
      setHistory(next);
      await persistHistory(next);
    },
    [history],
  );

  const startSession = useCallback(
    async (nextMode: Mode, durationSec: number, label?: string) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      await cancelScheduledNotif();
      const now = Date.now();
      const endAt = now + durationSec * 1000;
      endTimeRef.current = endAt;
      setMode(nextMode);
      setTotalSeconds(durationSec);
      setRemaining(durationSec);
      const sessionLabel = nextMode === 'focus' ? (label ?? taskLabel) : '';
      if (nextMode === 'focus') {
        setActiveLabel(sessionLabel);
      }
      setPhase('running');
      const id = await scheduleEndNotification(nextMode, durationSec);
      notifIdRef.current = id;
      LiveActivity.start({
        startTime: now,
        endTime: endAt,
        totalDuration: durationSec,
        mode: nextMode,
        label: sessionLabel,
      }).catch(() => {});
    },
    [cancelScheduledNotif, taskLabel],
  );

  const complete = useCallback(async () => {
    clearInternalTimer();
    endTimeRef.current = null;
    notifIdRef.current = null;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
      () => {},
    );
    if (mode === 'focus') {
      await recordCompletedFocus(totalSeconds, activeLabel);
      const nextCycleCount = pomodorosInCycle + 1;
      if (nextCycleCount >= POMODOROS_PER_LONG_BREAK) {
        setPomodorosInCycle(0);
        await startSession('longBreak', LONG_BREAK_SEC);
      } else {
        setPomodorosInCycle(nextCycleCount);
        await startSession('shortBreak', SHORT_BREAK_SEC);
      }
    } else {
      setMode('focus');
      setTotalSeconds(durationMinutes * 60);
      setRemaining(durationMinutes * 60);
      setActiveLabel('');
      setPhase('idle');
      LiveActivity.end().catch(() => {});
    }
  }, [
    mode,
    totalSeconds,
    activeLabel,
    pomodorosInCycle,
    durationMinutes,
    clearInternalTimer,
    startSession,
    recordCompletedFocus,
  ]);

  useEffect(() => {
    completeRef.current = complete;
  }, [complete]);

  const start = useCallback(() => {
    startSession(mode, remaining, taskLabel);
  }, [startSession, mode, remaining, taskLabel]);

  const pause = useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    clearInternalTimer();
    const pausedRemainingSec =
      endTimeRef.current != null
        ? Math.max(0, (endTimeRef.current - Date.now()) / 1000)
        : remaining;
    setRemaining(pausedRemainingSec);
    endTimeRef.current = null;
    await cancelScheduledNotif();
    setPhase('paused');
    LiveActivity.update({
      endTime: Date.now() + pausedRemainingSec * 1000,
      mode,
      label: activeLabel,
      isPaused: true,
      pausedRemainingSec,
    }).catch(() => {});
  }, [clearInternalTimer, cancelScheduledNotif, mode, activeLabel, remaining]);

  const reset = useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    clearInternalTimer();
    endTimeRef.current = null;
    await cancelScheduledNotif();
    setMode('focus');
    setTotalSeconds(durationMinutes * 60);
    setRemaining(durationMinutes * 60);
    setActiveLabel('');
    setPhase('idle');
    LiveActivity.end().catch(() => {});
  }, [clearInternalTimer, cancelScheduledNotif, durationMinutes]);

  const selectDuration = useCallback(
    (minutes: number) => {
      if (phase !== 'idle' || mode !== 'focus') return;
      Haptics.selectionAsync().catch(() => {});
      setDurationMinutes(minutes);
      setTotalSeconds(minutes * 60);
      setRemaining(minutes * 60);
    },
    [phase, mode],
  );

  const ringSize = Math.min(width - 64, 300);
  const stroke = 14;
  const radius = (ringSize - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = totalSeconds > 0 ? 1 - remaining / totalSeconds : 0;
  const dashOffset = circumference * (1 - progress);

  const accent =
    mode === 'focus'
      ? '#7C5CFF'
      : mode === 'longBreak'
        ? '#3DDC97'
        : '#5BC0EB';

  const statusLabel = useMemo(() => {
    if (mode === 'shortBreak') {
      return phase === 'paused' ? 'Break · Paused' : 'Short break';
    }
    if (mode === 'longBreak') {
      return phase === 'paused' ? 'Long break · Paused' : 'Long break';
    }
    if (phase === 'running' && activeLabel.length > 0) return activeLabel;
    if (phase === 'running') return 'Focusing';
    if (phase === 'paused') return 'Paused';
    return 'Ready';
  }, [phase, mode, activeLabel]);

  const primaryLabel =
    phase === 'running' ? 'Pause' : phase === 'paused' ? 'Resume' : 'Start';
  const onPrimary = phase === 'running' ? pause : start;
  const showPresets = phase === 'idle' && mode === 'focus';
  const showLabelInput = phase === 'idle' && mode === 'focus';

  const today = history[dayKey()] ?? {
    sessions: 0,
    focusSeconds: 0,
    items: [],
  };

  if (screen === 'stats') {
    return (
      <StatsScreen
        history={history}
        onBack={() => setScreen('timer')}
        accent="#7C5CFF"
      />
    );
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: '#0F1115' }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.root}>
        <StatusBar style="light" />

        <View style={styles.topRow}>
          <View style={styles.header}>
            <Text style={styles.title}>Focus</Text>
            <Text style={styles.subtitle}>
              {mode === 'focus'
                ? `${durationMinutes} minute deep work · ${pomodorosInCycle}/${POMODOROS_PER_LONG_BREAK} until long break`
                : mode === 'longBreak'
                  ? '15 minute long break'
                  : '5 minute break'}
            </Text>
          </View>
          <Pressable
            onPress={() => setScreen('stats')}
            style={({ pressed }) => [
              styles.statsIcon,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.statsIconLabel}>Stats</Text>
          </Pressable>
        </View>

        {showLabelInput ? (
          <View style={styles.labelWrap}>
            <TextInput
              value={taskLabel}
              onChangeText={setTaskLabel}
              placeholder="What are you focusing on?"
              placeholderTextColor="#5A6072"
              style={styles.labelInput}
              maxLength={60}
              returnKeyType="done"
            />
          </View>
        ) : (
          <View style={{ height: 48 }} />
        )}

        <View style={styles.presetsRow}>
          {showPresets ? (
            DURATION_PRESETS_MIN.map((m) => {
              const selected = m === durationMinutes;
              return (
                <Pressable
                  key={m}
                  onPress={() => selectDuration(m)}
                  style={({ pressed }) => [
                    styles.preset,
                    selected && styles.presetSelected,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text
                    style={[
                      styles.presetLabel,
                      selected && styles.presetLabelSelected,
                    ]}
                  >
                    {m}
                  </Text>
                </Pressable>
              );
            })
          ) : (
            <View style={{ height: 44 }} />
          )}
        </View>

        <View style={[styles.ringWrap, { width: ringSize, height: ringSize }]}>
          <Svg width={ringSize} height={ringSize}>
            <Circle
              cx={ringSize / 2}
              cy={ringSize / 2}
              r={radius}
              stroke="#1E2230"
              strokeWidth={stroke}
              fill="none"
            />
            <Circle
              cx={ringSize / 2}
              cy={ringSize / 2}
              r={radius}
              stroke={accent}
              strokeWidth={stroke}
              strokeLinecap="round"
              fill="none"
              strokeDasharray={`${circumference} ${circumference}`}
              strokeDashoffset={dashOffset}
              transform={`rotate(-90 ${ringSize / 2} ${ringSize / 2})`}
            />
          </Svg>
          <View style={styles.ringCenter} pointerEvents="none">
            <Text style={styles.time}>{formatTime(remaining)}</Text>
            <Text style={styles.status} numberOfLines={1}>
              {statusLabel}
            </Text>
          </View>
        </View>

        <View style={styles.ambientRow}>
          {(['off', 'rain', 'forest', 'whiteNoise'] as AmbientChoice[]).map(
            (a) => {
              const selected = a === ambient;
              const label =
                a === 'off' ? 'Off' : AMBIENT_SOURCES[a].label;
              return (
                <Pressable
                  key={a}
                  onPress={() => {
                    Haptics.selectionAsync().catch(() => {});
                    setAmbient(a);
                  }}
                  style={({ pressed }) => [
                    styles.ambientChip,
                    selected && styles.ambientChipSelected,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text
                    style={[
                      styles.ambientLabel,
                      selected && styles.ambientLabelSelected,
                    ]}
                  >
                    {label}
                  </Text>
                </Pressable>
              );
            },
          )}
        </View>

        <View style={styles.controls}>
          <Pressable
            onPress={reset}
            disabled={phase === 'idle' && mode === 'focus'}
            style={({ pressed }) => [
              styles.secondaryBtn,
              phase === 'idle' && mode === 'focus' && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.secondaryLabel}>Reset</Text>
          </Pressable>

          <Pressable
            onPress={onPrimary}
            style={({ pressed }) => [
              styles.primaryBtn,
              { backgroundColor: accent },
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.primaryLabel}>{primaryLabel}</Text>
          </Pressable>
        </View>

        <Text style={styles.todayStats}>
          {today.sessions === 0
            ? 'No sessions today yet'
            : `${today.sessions} session${today.sessions === 1 ? '' : 's'} today · ${formatFocused(today.focusSeconds)} focused`}
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}

function StatsScreen({
  history,
  onBack,
  accent,
}: {
  history: History;
  onBack: () => void;
  accent: string;
}) {
  const today = history[dayKey()] ?? {
    sessions: 0,
    focusSeconds: 0,
    items: [],
  };
  const streak = computeStreak(history);
  const week = useMemo(() => {
    const arr: { label: string; sec: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const k = shiftedDayKey(i);
      arr.push({
        label: shortWeekday(i),
        sec: history[k]?.focusSeconds ?? 0,
      });
    }
    return arr;
  }, [history]);
  const maxSec = Math.max(...week.map((d) => d.sec), 1);
  const allTime = Object.values(history).reduce(
    (sum, d) => sum + d.focusSeconds,
    0,
  );
  const recent = useMemo(() => {
    const items: (SessionItem & { day: string })[] = [];
    Object.keys(history)
      .sort((a, b) => (a < b ? 1 : -1))
      .forEach((day) => {
        history[day].items.forEach((it) => items.push({ ...it, day }));
      });
    return items.sort((a, b) => b.endedAt - a.endedAt).slice(0, 10);
  }, [history]);

  return (
    <View style={statsStyles.root}>
      <StatusBar style="light" />
      <View style={statsStyles.headerRow}>
        <Pressable
          onPress={onBack}
          style={({ pressed }) => [
            statsStyles.backBtn,
            pressed && styles.pressed,
          ]}
        >
          <Text style={statsStyles.backLabel}>← Back</Text>
        </Pressable>
        <Text style={statsStyles.title}>Stats</Text>
        <View style={{ width: 64 }} />
      </View>

      <ScrollView
        contentContainerStyle={statsStyles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={statsStyles.cardsRow}>
          <View style={statsStyles.card}>
            <Text style={statsStyles.cardValue}>{today.sessions}</Text>
            <Text style={statsStyles.cardLabel}>Today</Text>
          </View>
          <View style={statsStyles.card}>
            <Text style={statsStyles.cardValue}>{streak}</Text>
            <Text style={statsStyles.cardLabel}>Day streak</Text>
          </View>
          <View style={statsStyles.card}>
            <Text style={statsStyles.cardValue}>{formatFocused(allTime)}</Text>
            <Text style={statsStyles.cardLabel}>All time</Text>
          </View>
        </View>

        <Text style={statsStyles.sectionTitle}>This week</Text>
        <View style={statsStyles.chart}>
          {week.map((d, i) => {
            const h = Math.max(4, Math.round((d.sec / maxSec) * 120));
            return (
              <View key={i} style={statsStyles.barColumn}>
                <View style={statsStyles.barTrack}>
                  <View
                    style={[
                      statsStyles.bar,
                      { height: h, backgroundColor: accent },
                    ]}
                  />
                </View>
                <Text style={statsStyles.barLabel}>{d.label}</Text>
                <Text style={statsStyles.barValue}>
                  {d.sec > 0 ? formatFocused(d.sec) : '–'}
                </Text>
              </View>
            );
          })}
        </View>

        <Text style={statsStyles.sectionTitle}>Recent sessions</Text>
        {recent.length === 0 ? (
          <Text style={statsStyles.empty}>
            Completed sessions will appear here.
          </Text>
        ) : (
          recent.map((it, i) => (
            <View key={i} style={statsStyles.row}>
              <View style={{ flex: 1 }}>
                <Text style={statsStyles.rowLabel} numberOfLines={1}>
                  {it.label || 'Focus session'}
                </Text>
                <Text style={statsStyles.rowDay}>{it.day}</Text>
              </View>
              <Text style={statsStyles.rowDuration}>
                {formatFocused(it.durationSec)}
              </Text>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0F1115',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 60,
    paddingBottom: 40,
    paddingHorizontal: 24,
  },
  topRow: {
    flexDirection: 'row',
    width: '100%',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  header: {
    alignItems: 'flex-start',
    gap: 6,
    flex: 1,
  },
  title: {
    color: '#F4F5F7',
    fontSize: 32,
    fontWeight: '700',
    letterSpacing: -0.5,
  },
  subtitle: {
    color: '#8B90A0',
    fontSize: 13,
  },
  statsIcon: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: '#1E2230',
  },
  statsIconLabel: {
    color: '#F4F5F7',
    fontSize: 13,
    fontWeight: '600',
  },
  labelWrap: {
    width: '100%',
    height: 48,
    justifyContent: 'center',
  },
  labelInput: {
    backgroundColor: '#1A1D27',
    color: '#F4F5F7',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
    fontSize: 15,
  },
  presetsRow: {
    flexDirection: 'row',
    gap: 8,
    height: 44,
    alignItems: 'center',
  },
  preset: {
    minWidth: 50,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: '#1E2230',
    alignItems: 'center',
  },
  presetSelected: {
    backgroundColor: '#2A2F44',
    borderWidth: 1,
    borderColor: '#7C5CFF',
  },
  presetLabel: {
    color: '#8B90A0',
    fontSize: 15,
    fontWeight: '600',
  },
  presetLabelSelected: {
    color: '#F4F5F7',
  },
  ringWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringCenter: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  time: {
    color: '#F4F5F7',
    fontSize: 60,
    fontWeight: '300',
    fontVariant: ['tabular-nums'],
    letterSpacing: -2,
  },
  status: {
    color: '#8B90A0',
    fontSize: 13,
    marginTop: 4,
    textTransform: 'uppercase',
    letterSpacing: 1.5,
    textAlign: 'center',
  },
  ambientRow: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  ambientChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: '#1A1D27',
  },
  ambientChipSelected: {
    backgroundColor: '#2A2F44',
    borderWidth: 1,
    borderColor: '#7C5CFF',
  },
  ambientLabel: {
    color: '#8B90A0',
    fontSize: 13,
    fontWeight: '500',
  },
  ambientLabelSelected: {
    color: '#F4F5F7',
  },
  controls: {
    flexDirection: 'row',
    gap: 12,
    width: '100%',
  },
  primaryBtn: {
    flex: 1,
    paddingVertical: 18,
    borderRadius: 16,
    alignItems: 'center',
  },
  primaryLabel: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '600',
  },
  secondaryBtn: {
    flex: 1,
    backgroundColor: '#1E2230',
    paddingVertical: 18,
    borderRadius: 16,
    alignItems: 'center',
  },
  secondaryLabel: {
    color: '#F4F5F7',
    fontSize: 17,
    fontWeight: '500',
  },
  disabled: {
    opacity: 0.4,
  },
  pressed: {
    opacity: 0.75,
  },
  todayStats: {
    color: '#8B90A0',
    fontSize: 13,
  },
});

const statsStyles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0F1115',
    paddingTop: 60,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingBottom: 12,
  },
  backBtn: {
    paddingVertical: 6,
    paddingHorizontal: 8,
    width: 64,
  },
  backLabel: {
    color: '#7C5CFF',
    fontSize: 15,
    fontWeight: '500',
  },
  title: {
    color: '#F4F5F7',
    fontSize: 22,
    fontWeight: '700',
  },
  scrollContent: {
    paddingHorizontal: 24,
    paddingBottom: 40,
    gap: 24,
  },
  cardsRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
  },
  card: {
    flex: 1,
    backgroundColor: '#1A1D27',
    borderRadius: 14,
    paddingVertical: 18,
    paddingHorizontal: 12,
    alignItems: 'center',
  },
  cardValue: {
    color: '#F4F5F7',
    fontSize: 22,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  cardLabel: {
    color: '#8B90A0',
    fontSize: 12,
    marginTop: 4,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  sectionTitle: {
    color: '#F4F5F7',
    fontSize: 17,
    fontWeight: '600',
    marginTop: 8,
  },
  chart: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 6,
    backgroundColor: '#1A1D27',
    borderRadius: 14,
    padding: 16,
  },
  barColumn: {
    flex: 1,
    alignItems: 'center',
  },
  barTrack: {
    width: '100%',
    height: 120,
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  bar: {
    width: 16,
    borderRadius: 4,
  },
  barLabel: {
    color: '#8B90A0',
    fontSize: 12,
    marginTop: 8,
    fontWeight: '500',
  },
  barValue: {
    color: '#5A6072',
    fontSize: 10,
    marginTop: 2,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1A1D27',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 12,
  },
  rowLabel: {
    color: '#F4F5F7',
    fontSize: 15,
    fontWeight: '500',
  },
  rowDay: {
    color: '#8B90A0',
    fontSize: 12,
    marginTop: 2,
  },
  rowDuration: {
    color: '#7C5CFF',
    fontSize: 14,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  empty: {
    color: '#8B90A0',
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 16,
  },
});
