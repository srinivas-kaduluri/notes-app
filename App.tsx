import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import Checkbox from 'expo-checkbox';
import * as ImagePicker from 'expo-image-picker';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Image,
  Linking,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

type NoteStatus = 'open' | 'completed';
type SortField = 'status' | 'endDate' | 'startDate' | 'updatedAt' | 'title';
type SortDirection = 'asc' | 'desc';
type NoteView = 'active' | 'completed' | 'all';

type Attachment = {
  id: string;
  uri: string;
  type: 'image' | 'video' | 'unknown';
};

type LocationAlert = {
  enabled: boolean;
  placeQuery: string;
  lat?: number;
  lng?: number;
  radiusMeters?: number;
  onEntry?: boolean;
  onExit?: boolean;
};

type ChecklistItem = {
  id: string;
  text: string;
  kind: 'bullet' | 'check';
  checked?: boolean;
};

type PlaceSuggestion = {
  label: string;
  lat?: number;
  lng?: number;
  placeId?: string;
};

type Note = {
  id: string;
  title: string;
  checklist: ChecklistItem[];
  parentId: string | null;
  startDate: string;
  endDate: string;
  status: NoteStatus;
  completedAt?: string;
  completionNote?: string;
  followUpNoteId?: string;
  alertEnabled: boolean;
  alertDate?: string;
  alertTime?: string;
  attachments: Attachment[];
  locationAlert?: LocationAlert;
  numericFields: Record<string, number>;
  createdAt: string;
  updatedAt: string;
  history?: NoteSnapshot[];
};

type NoteSnapshot = {
  savedAt: string;
  title: string;
  status: NoteStatus;
  startDate: string;
  endDate: string;
  checklistCount: number;
  checkedCount: number;
};

type LegacyNote = Note & { body?: string };

type TableColumnType = 'text' | 'number';
type TableColumn = { id: string; name: string; type: TableColumnType; updatedAt: string };
type TableRow = { id: string; cells: Record<string, string>; updatedAt: string };
type TableData = { columns: TableColumn[]; rows: TableRow[] };

type AppSettings = {
  requireBiometricOnOpen: boolean;
  numericColumns: string[];
  locationServicesEnabled: boolean;
  allowMediaAccess: boolean;
  allowNotifications: boolean;
  allowBackgroundLocation: boolean;
};

const STORAGE_KEY = 'minimal_secure_notes_v1';
const SETTINGS_KEY = 'minimal_secure_settings_v1';
const TABLE_KEY = 'minimal_secure_table_v1';
const GEOFENCE_TASK = 'note_geofence_task_v1';
const GEOFENCE_MAP_KEY = 'note_geofence_map_v1';
const GOOGLE_PLACES_KEY = process.env.EXPO_PUBLIC_GOOGLE_PLACES_API_KEY?.trim() ?? '';
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim() ?? '';
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? '';

const defaultSettings: AppSettings = {
  requireBiometricOnOpen: true,
  numericColumns: ['Estimate', 'Actual'],
  locationServicesEnabled: false,
  allowMediaAccess: false,
  allowNotifications: false,
  allowBackgroundLocation: false,
};
const defaultTableData: TableData = {
  columns: [
    { id: 'col_text', name: 'Item', type: 'text', updatedAt: '' },
    { id: 'col_num', name: 'Value', type: 'number', updatedAt: '' },
  ],
  rows: [],
};

const nowIso = () => new Date().toISOString();
const todayDateInput = () => {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
};
const nowTimeInput = () => {
  const d = new Date();
  const h = d.getHours();
  const hh = h % 12 || 12;
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ap = h >= 12 ? 'PM' : 'AM';
  return `${hh}:${mm} ${ap}`;
};
const id = () => `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
const normalize = (v: string) => v.trim().toLowerCase();
const parseNumber = (v: string) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const parseUsDate = (text?: string): Date | null => {
  if (!text) return null;
  const m = text.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  const d = new Date(year, month - 1, day);
  return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day ? d : null;
};

const parseAmPmTime = (text?: string): { hours: number; minutes: number } | null => {
  if (!text) return null;
  const m = text.trim().toUpperCase().match(/^(\d{1,2}):(\d{2})\s?(AM|PM)$/);
  if (!m) return null;
  const rawH = Number(m[1]);
  const minutes = Number(m[2]);
  if (rawH < 1 || rawH > 12 || minutes > 59) return null;
  let hours = rawH % 12;
  if (m[3] === 'PM') hours += 12;
  return { hours, minutes };
};

const toDateTime = (dateInput?: string, timeInput?: string): Date | null => {
  const d = parseUsDate(dateInput);
  if (!d) return null;
  const t = parseAmPmTime(timeInput || '9:00 AM');
  if (!t) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), t.hours, t.minutes, 0, 0);
};

const sortLabel: Record<SortField, string> = {
  status: 'Status',
  endDate: 'End',
  startDate: 'Start',
  updatedAt: 'Updated',
  title: 'Title',
};

const statusOrder = (s: NoteStatus) => (s === 'open' ? 0 : 1);

const distanceMeters = (aLat: number, aLng: number, bLat: number, bLng: number) => {
  const r = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const x =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * r * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
};

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

type GeofenceMap = Record<
  string,
  {
    noteId: string;
    title: string;
    onEntry: boolean;
    onExit: boolean;
  }
>;

type CloudStateRow = {
  user_id: string;
  notes_json: Note[];
  table_json: TableData;
  updated_at?: string;
};

let supabaseSingleton: SupabaseClient | null = null;
const getSupabase = () => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  if (!supabaseSingleton) {
    supabaseSingleton = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storage: AsyncStorage as any,
      },
    });
  }
  return supabaseSingleton;
};

if (!TaskManager.isTaskDefined(GEOFENCE_TASK)) {
  TaskManager.defineTask(
    GEOFENCE_TASK,
    async ({ data, error }: { data?: unknown; error?: unknown }) => {
    if (error || !data) return;

    const payload = data as { eventType?: Location.GeofencingEventType; region?: { identifier?: string } };
    const regionId = payload.region?.identifier;
    if (!regionId || payload.eventType == null) return;

    try {
      const mapRaw = await AsyncStorage.getItem(GEOFENCE_MAP_KEY);
      const map = mapRaw ? (JSON.parse(mapRaw) as GeofenceMap) : {};
      const meta = map[regionId];
      if (!meta) return;

      const isEnter = payload.eventType === Location.GeofencingEventType.Enter;
      if ((isEnter && !meta.onEntry) || (!isEnter && !meta.onExit)) return;

      await Notifications.scheduleNotificationAsync({
        content: {
          title: `${isEnter ? 'Arrived' : 'Left'}: ${meta.title}`,
          body: isEnter ? 'You are at the saved place.' : 'You left the saved place.',
          data: { type: 'note-geofence', noteId: meta.noteId, mode: isEnter ? 'entry' : 'exit' },
        },
        trigger: null,
      });
    } catch {
      // no-op
    }
    },
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'notes' | 'table' | 'settings' | 'metrics'>('notes');
  const [loaded, setLoaded] = useState(false);
  const [locked, setLocked] = useState(false);

  const [notes, setNotes] = useState<Note[]>([]);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);

  const [search, setSearch] = useState('');
  const [treeView, setTreeView] = useState(true);
  const [noteView, setNoteView] = useState<NoteView>('active');
  const [sortField, setSortField] = useState<SortField>('status');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  const [showComposer, setShowComposer] = useState(false);
  const [title, setTitle] = useState('');
  const [newChecklist, setNewChecklist] = useState<ChecklistItem[]>([]);
  const [selectedParentId, setSelectedParentId] = useState<string | null>(null);
  const [parentSearch, setParentSearch] = useState('');
  const [startDate, setStartDate] = useState(todayDateInput());
  const [endDate, setEndDate] = useState(todayDateInput());
  const [alertEnabled, setAlertEnabled] = useState(false);
  const [alertDate, setAlertDate] = useState(todayDateInput());
  const [alertTime, setAlertTime] = useState('9:00 AM');
  const [locationEnabled, setLocationEnabled] = useState(false);
  const [placeQuery, setPlaceQuery] = useState('');
  const [placeSuggestions, setPlaceSuggestions] = useState<PlaceSuggestion[]>([]);
  const [radiusMeters, setRadiusMeters] = useState('150');
  const [locationOnEntry, setLocationOnEntry] = useState(true);
  const [locationOnExit, setLocationOnExit] = useState(true);
  const [composerCoords, setComposerCoords] = useState<{ lat: number; lng: number } | null>(null);

  const [detailNoteId, setDetailNoteId] = useState<string | null>(null);
  const [detailParentSearch, setDetailParentSearch] = useState('');
  const [detailCompletionNote, setDetailCompletionNote] = useState('');
  const [detailFollowUpTitle, setDetailFollowUpTitle] = useState('');
  const [detailPlaceSuggestions, setDetailPlaceSuggestions] = useState<PlaceSuggestion[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [imagePreviewUri, setImagePreviewUri] = useState<string | null>(null);
  const [linkerNoteId, setLinkerNoteId] = useState<string | null>(null);
  const [linkerSearch, setLinkerSearch] = useState('');

  const [nearbyIds, setNearbyIds] = useState<Set<string>>(new Set());
  const [tableData, setTableData] = useState<TableData>(defaultTableData);
  const [newColumnName, setNewColumnName] = useState('');
  const [newColumnType, setNewColumnType] = useState<TableColumnType>('text');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'error'>('idle');
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [lastMergeAt, setLastMergeAt] = useState<string | null>(null);
  const [lastMergeSource, setLastMergeSource] = useState<'pull' | 'push' | null>(null);
  const [lastMergeSummary, setLastMergeSummary] = useState<string | null>(null);
  const pushingRef = useRef(false);
  const detailOpenSnapshotRef = useRef<NoteSnapshot | null>(null);

  useEffect(() => {
    (async () => {
      await loadState();
      setLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(notes)).catch(() => {});
  }, [notes, loaded]);

  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)).catch(() => {});
  }, [settings, loaded]);

  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(TABLE_KEY, JSON.stringify(tableData)).catch(() => {});
  }, [tableData, loaded]);

  useEffect(() => {
    if (!loaded) return;
    if (!settings.requireBiometricOnOpen) {
      setLocked(false);
      return;
    }
    (async () => {
      const ok = await authenticate();
      setLocked(!ok);
    })();
  }, [loaded, settings.requireBiometricOnOpen]);

  useEffect(() => {
    if (!loaded) return;
    if (Platform.OS === 'web') return;
    if (!settings.allowNotifications) return;

    const syncNotifications = async () => {
      const permission = await Notifications.getPermissionsAsync();
      if (!permission.granted) {
        const req = await Notifications.requestPermissionsAsync();
        if (!req.granted) return;
      }

      const existing = await Notifications.getAllScheduledNotificationsAsync();
      await Promise.all(
        existing
          .filter((n: any) => (n.content.data as { type?: string } | undefined)?.type === 'note-alert')
          .map((n: any) => Notifications.cancelScheduledNotificationAsync(n.identifier)),
      );

      for (const note of notes) {
        if (note.status === 'completed') continue;
        if (!note.alertEnabled) continue;
        const dt = toDateTime(note.alertDate, note.alertTime);
        if (!dt) continue;
        if (dt.getTime() <= Date.now()) continue;

        await Notifications.scheduleNotificationAsync({
          content: {
            title: `Reminder: ${note.title}`,
            body: note.checklist[0]?.text || 'Open note',
            data: { type: 'note-alert', noteId: note.id },
          },
          trigger: {
            type: Notifications.SchedulableTriggerInputTypes.DATE,
            date: dt,
          },
        });
      }
    };

    syncNotifications().catch(() => {});
  }, [notes, loaded, settings.allowNotifications]);

  useEffect(() => {
    if (!loaded) return;
    if (Platform.OS === 'web') return;

    const syncGeofences = async () => {
      const clearGeofences = async () => {
        const started = await Location.hasStartedGeofencingAsync(GEOFENCE_TASK);
        if (started) await Location.stopGeofencingAsync(GEOFENCE_TASK);
        await AsyncStorage.removeItem(GEOFENCE_MAP_KEY);
      };

      if (!settings.locationServicesEnabled) {
        await clearGeofences();
        return;
      }
      if (!settings.allowBackgroundLocation || !settings.allowNotifications) {
        await clearGeofences();
        return;
      }

      const fg = await Location.requestForegroundPermissionsAsync();
      if (!fg.granted) {
        await clearGeofences();
        return;
      }
      const bg = await Location.requestBackgroundPermissionsAsync();
      if (!bg.granted) {
        await clearGeofences();
        return;
      }

      const geofenceCandidates = notes
        .filter((n) => n.status !== 'completed')
        .filter((n) => n.locationAlert?.enabled)
        .filter((n) => n.locationAlert?.lat != null && n.locationAlert?.lng != null)
        .filter((n) => (n.locationAlert?.onEntry ?? true) || (n.locationAlert?.onExit ?? true))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 20);

      if (!geofenceCandidates.length) {
        await clearGeofences();
        return;
      }

      const regions: Location.LocationRegion[] = geofenceCandidates.map((n) => ({
        identifier: n.id,
        latitude: n.locationAlert!.lat!,
        longitude: n.locationAlert!.lng!,
        radius: Math.max(75, Math.min(n.locationAlert!.radiusMeters ?? 150, 1000)),
        notifyOnEnter: n.locationAlert?.onEntry ?? true,
        notifyOnExit: n.locationAlert?.onExit ?? true,
      }));

      await Location.startGeofencingAsync(GEOFENCE_TASK, regions);

      const map: GeofenceMap = {};
      geofenceCandidates.forEach((n) => {
        map[n.id] = {
          noteId: n.id,
          title: n.title,
          onEntry: n.locationAlert?.onEntry ?? true,
          onExit: n.locationAlert?.onExit ?? true,
        };
      });
      await AsyncStorage.setItem(GEOFENCE_MAP_KEY, JSON.stringify(map));
    };

    syncGeofences().catch(() => {});
  }, [notes, settings.locationServicesEnabled, settings.allowBackgroundLocation, settings.allowNotifications, loaded]);

  useEffect(() => {
    if (!loaded) return;
    const supabase = getSupabase();
    if (!supabase) return;

    supabase.auth.getSession().then(({ data }: { data: { session: { user?: { id?: string } } | null } }) => {
      const uid = data.session?.user?.id ?? null;
      setCurrentUserId(uid);
      if (uid) pullCloudState(uid).catch(() => {});
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event: unknown, session: { user?: { id?: string } } | null) => {
      const uid = session?.user?.id ?? null;
      setCurrentUserId(uid);
      if (uid) pullCloudState(uid).catch(() => {});
    });

    return () => sub.subscription.unsubscribe();
  }, [loaded]);

  useEffect(() => {
    if (!loaded || !currentUserId) return;
    const timer = setTimeout(() => {
      pushCloudState(currentUserId).catch(() => {});
    }, 600);
    return () => clearTimeout(timer);
  }, [notes, tableData, currentUserId, loaded]);

  const loadState = async () => {
    try {
      const [notesRaw, settingsRaw, tableRaw] = await Promise.all([
        AsyncStorage.getItem(STORAGE_KEY),
        AsyncStorage.getItem(SETTINGS_KEY),
        AsyncStorage.getItem(TABLE_KEY),
      ]);

      if (notesRaw) {
        const parsed = JSON.parse(notesRaw) as LegacyNote[];
        if (Array.isArray(parsed)) {
          const migrated: Note[] = parsed.map((n) => {
            const body = (n as { body?: string }).body;
            const fromBody = body?.trim() ? [{ id: id(), text: body.trim(), kind: 'bullet' as const }] : [];
            return {
              ...n,
              checklist: Array.isArray(n.checklist) ? n.checklist : fromBody,
              attachments: n.attachments ?? [],
              numericFields: n.numericFields ?? {},
              startDate: n.startDate || todayDateInput(),
              endDate: n.endDate || todayDateInput(),
              alertEnabled: n.alertEnabled ?? false,
              alertDate: n.alertDate,
              alertTime: n.alertTime,
              locationAlert: n.locationAlert
                ? {
                    enabled: !!n.locationAlert.enabled,
                    placeQuery: n.locationAlert.placeQuery ?? '',
                    lat: n.locationAlert.lat,
                    lng: n.locationAlert.lng,
                    radiusMeters: n.locationAlert.radiusMeters ?? 150,
                    onEntry: n.locationAlert.onEntry ?? true,
                    onExit: n.locationAlert.onExit ?? true,
                  }
                : undefined,
              history: n.history ?? [],
            };
          });
          setNotes(migrated);
        }
      }

      if (settingsRaw) {
        const parsed = JSON.parse(settingsRaw) as Partial<AppSettings>;
        const merged: AppSettings = {
          ...defaultSettings,
          ...parsed,
          numericColumns: parsed?.numericColumns?.length ? parsed.numericColumns : defaultSettings.numericColumns,
          locationServicesEnabled: !!parsed?.locationServicesEnabled,
        };
        setSettings(merged);
      }

      if (tableRaw) {
        const parsedTable = JSON.parse(tableRaw) as Partial<TableData>;
        if (Array.isArray(parsedTable.columns) && Array.isArray(parsedTable.rows)) {
          setTableData(
            normalizeTable({
              columns: parsedTable.columns.length ? parsedTable.columns : defaultTableData.columns,
              rows: parsedTable.rows,
            }),
          );
        }
      }
    } catch {
      setNotes([]);
      setSettings(defaultSettings);
      setTableData(defaultTableData);
    }
  };

  const authenticate = async () => {
    if (Platform.OS === 'web') return true;
    try {
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      if (!hasHardware || !enrolled) return true;
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Unlock your notes',
        cancelLabel: 'Cancel',
      });
      return result.success;
    } catch {
      return false;
    }
  };

  const normalizeTable = (table: Partial<TableData> | TableData): TableData => {
    const columns = (table.columns ?? defaultTableData.columns).map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      updatedAt: c.updatedAt ?? nowIso(),
    }));
    const rows = (table.rows ?? []).map((r) => ({
      id: r.id,
      cells: r.cells ?? {},
      updatedAt: r.updatedAt ?? nowIso(),
    }));
    return { columns, rows };
  };

  const mergeNotesByUpdatedAt = (localNotes: Note[], remoteNotes: Note[]): Note[] => {
    const byId = new Map<string, Note>();
    [...localNotes, ...remoteNotes].forEach((n) => {
      const prev = byId.get(n.id);
      if (!prev) {
        byId.set(n.id, n);
        return;
      }
      byId.set(n.id, n.updatedAt >= prev.updatedAt ? n : prev);
    });
    return Array.from(byId.values());
  };

  const mergeTableByUpdatedAt = (localTable: TableData, remoteTable: TableData): TableData => {
    const local = normalizeTable(localTable);
    const remote = normalizeTable(remoteTable);

    const colMap = new Map<string, TableColumn>();
    [...local.columns, ...remote.columns].forEach((c) => {
      const prev = colMap.get(c.id);
      if (!prev || c.updatedAt >= prev.updatedAt) colMap.set(c.id, c);
    });
    const columns = Array.from(colMap.values());

    const rowMap = new Map<string, TableRow>();
    [...local.rows, ...remote.rows].forEach((r) => {
      const prev = rowMap.get(r.id);
      if (!prev || r.updatedAt >= prev.updatedAt) rowMap.set(r.id, r);
    });
    const rows = Array.from(rowMap.values()).map((row) => {
      const cells: Record<string, string> = {};
      columns.forEach((c) => {
        cells[c.id] = row.cells[c.id] ?? '';
      });
      return { ...row, cells };
    });

    return { columns, rows };
  };

  const pullCloudState = async (userId: string) => {
    const supabase = getSupabase();
    if (!supabase) return;
    setSyncStatus('syncing');
    const { data, error } = await supabase
      .from('app_state')
      .select('user_id, notes_json, table_json, updated_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      setSyncStatus('error');
      return;
    }
    if (data) {
      const row = data as CloudStateRow;
      const remoteNotes = Array.isArray(row.notes_json) ? row.notes_json : [];
      const remoteTable = row.table_json?.columns && row.table_json?.rows ? row.table_json : defaultTableData;

      const mergedNotes = mergeNotesByUpdatedAt(notes, remoteNotes);
      const mergedTable = mergeTableByUpdatedAt(tableData, normalizeTable(remoteTable));
      const notesChanged = JSON.stringify(mergedNotes) !== JSON.stringify(notes);
      const tableChanged = JSON.stringify(mergedTable) !== JSON.stringify(tableData);

      pushingRef.current = true;
      setNotes(mergedNotes);
      setTableData(mergedTable);
      if (notesChanged || tableChanged) {
        const parts: string[] = [];
        if (notesChanged) parts.push('notes');
        if (tableChanged) parts.push('table');
        setLastMergeAt(nowIso());
        setLastMergeSource('pull');
        setLastMergeSummary(`Merged ${parts.join(' + ')} from cloud`);
      }
      setTimeout(() => {
        pushingRef.current = false;
      }, 350);
    }
    setSyncStatus('idle');
    setLastSyncedAt(nowIso());
  };

  const pushCloudState = async (userId: string) => {
    const supabase = getSupabase();
    if (!supabase) return;
    if (pushingRef.current) return;
    setSyncStatus('syncing');
    const { data: remote, error: readError } = await supabase
      .from('app_state')
      .select('user_id, notes_json, table_json, updated_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (readError) {
      setSyncStatus('error');
      return;
    }

    const remoteNotes = Array.isArray((remote as CloudStateRow | null)?.notes_json)
      ? ((remote as CloudStateRow).notes_json as Note[])
      : [];
    const remoteTableRaw = (remote as CloudStateRow | null)?.table_json ?? defaultTableData;
    const mergedNotes = mergeNotesByUpdatedAt(notes, remoteNotes);
    const mergedTable = mergeTableByUpdatedAt(tableData, normalizeTable(remoteTableRaw));
    const notesChanged = JSON.stringify(mergedNotes) !== JSON.stringify(notes);
    const tableChanged = JSON.stringify(mergedTable) !== JSON.stringify(tableData);
    if (notesChanged) setNotes(mergedNotes);
    if (tableChanged) setTableData(mergedTable);
    if (notesChanged || tableChanged) {
      const parts: string[] = [];
      if (notesChanged) parts.push('notes');
      if (tableChanged) parts.push('table');
      setLastMergeAt(nowIso());
      setLastMergeSource('push');
      setLastMergeSummary(`Merged ${parts.join(' + ')} before upload`);
    }

    const payload: CloudStateRow = {
      user_id: userId,
      notes_json: mergedNotes,
      table_json: mergedTable,
      updated_at: nowIso(),
    };
    const { error } = await supabase.from('app_state').upsert(payload, { onConflict: 'user_id' });
    if (error) {
      setSyncStatus('error');
      return;
    }
    setSyncStatus('idle');
    setLastSyncedAt(nowIso());
  };

  const signUpCloud = async () => {
    const supabase = getSupabase();
    if (!supabase) return;
    if (!authEmail.trim() || !authPassword.trim()) {
      Alert.alert('Credentials required', 'Enter email and password.');
      return;
    }
    const { data, error } = await supabase.auth.signUp({
      email: authEmail.trim(),
      password: authPassword,
    });
    if (error) {
      Alert.alert('Sign up failed', error.message);
      return;
    }
    setCurrentUserId(data.user?.id ?? null);
    Alert.alert('Account created', 'You are signed in.');
  };

  const signInCloud = async () => {
    const supabase = getSupabase();
    if (!supabase) return;
    const { data, error } = await supabase.auth.signInWithPassword({
      email: authEmail.trim(),
      password: authPassword,
    });
    if (error) {
      Alert.alert('Sign in failed', error.message);
      return;
    }
    setCurrentUserId(data.user?.id ?? null);
  };

  const signOutCloud = async () => {
    const supabase = getSupabase();
    if (!supabase) return;
    await supabase.auth.signOut();
    setCurrentUserId(null);
  };

  const noteById = useMemo(() => {
    const map = new Map<string, Note>();
    notes.forEach((n) => map.set(n.id, n));
    return map;
  }, [notes]);

  const navigateToNote = (noteId?: string) => {
    if (!noteId) return;
    const target = noteById.get(noteId);
    setActiveTab('notes');
    setShowComposer(false);
    setDetailNoteId(noteId);
    setDetailParentSearch('');
    setDetailCompletionNote(target?.completionNote ?? '');
    setDetailFollowUpTitle('');
  };

  useEffect(() => {
    if (!loaded) return;
    if (Platform.OS === 'web') return;

    const processResponse = async (response: Notifications.NotificationResponse | null) => {
      const noteId = (response?.notification.request.content.data as { noteId?: string } | undefined)?.noteId;
      if (response?.notification.request.identifier) {
        Notifications.dismissNotificationAsync(response.notification.request.identifier).catch(() => {});
      }
      if (!noteId) return;
      navigateToNote(noteId);
      (Notifications as unknown as { clearLastNotificationResponseAsync?: () => Promise<void> })
        .clearLastNotificationResponseAsync?.()
        .catch(() => {});
    };

    Notifications.getLastNotificationResponseAsync().then(processResponse).catch(() => {});
    const sub = Notifications.addNotificationResponseReceivedListener((r) => {
      processResponse(r).catch(() => {});
    });

    return () => sub.remove();
  }, [loaded]);

  const parentPath = (note: Note) => {
    const path: string[] = [];
    let current = note.parentId ? noteById.get(note.parentId) : undefined;
    while (current) {
      path.unshift(current.title);
      current = current.parentId ? noteById.get(current.parentId) : undefined;
    }
    return path.join(' / ');
  };

  const timeValue = (input: string) => toDateTime(input, '12:00 AM')?.getTime() ?? 0;

  const baseCompare = (a: Note, b: Note) => {
    if (sortField === 'status') {
      const d = statusOrder(a.status) - statusOrder(b.status);
      if (d !== 0) return d;
      return timeValue(a.endDate) - timeValue(b.endDate);
    }
    if (sortField === 'title') return a.title.localeCompare(b.title);
    if (sortField === 'updatedAt') return a.updatedAt.localeCompare(b.updatedAt);
    if (sortField === 'startDate') return timeValue(a.startDate) - timeValue(b.startDate);
    return timeValue(a.endDate) - timeValue(b.endDate);
  };

  const compareNotes = (a: Note, b: Note) => (sortDirection === 'asc' ? baseCompare(a, b) : -baseCompare(a, b));

  const filteredNotes = useMemo(() => {
    const q = normalize(search);
    const base = q
      ? notes.filter((n) => {
          const text = n.checklist.map((x) => x.text).join(' ').toLowerCase();
          return (
            n.title.toLowerCase().includes(q) ||
            text.includes(q) ||
            n.status.includes(q) ||
            parentPath(n).toLowerCase().includes(q)
          );
        })
      : notes;
    return [...base].sort(compareNotes);
  }, [notes, search, sortField, sortDirection, noteById]);

  const viewedNotes = useMemo(() => {
    if (noteView === 'active') return filteredNotes.filter((n) => n.status !== 'completed');
    if (noteView === 'completed') return filteredNotes.filter((n) => n.status === 'completed');
    return filteredNotes;
  }, [filteredNotes, noteView]);
  const viewedIdSet = useMemo(() => new Set(viewedNotes.map((n) => n.id)), [viewedNotes]);

  const childrenByParent = useMemo(() => {
    const map = new Map<string, Note[]>();
    notes.forEach((n) => {
      const key = n.parentId ?? '__root__';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(n);
    });
    map.forEach((list) => list.sort(compareNotes));
    return map;
  }, [notes, sortField, sortDirection]);

  const roots = useMemo(
    () => (childrenByParent.get('__root__') ?? []).filter((n) => viewedIdSet.has(n.id)),
    [childrenByParent, viewedIdSet],
  );

  const composerParentCandidates = useMemo(() => {
    const q = normalize(parentSearch);
    if (!q) return [];
    return notes.filter((n) => n.title.toLowerCase().includes(q)).slice(0, 8);
  }, [notes, parentSearch]);

  const detailNote = detailNoteId ? noteById.get(detailNoteId) : undefined;

  const descendantsOf = (noteId: string) => {
    const blocked = new Set<string>();
    const stack = [noteId];
    while (stack.length) {
      const curr = stack.pop()!;
      blocked.add(curr);
      (childrenByParent.get(curr) ?? []).forEach((child) => stack.push(child.id));
    }
    return blocked;
  };

  const detailParentCandidates = useMemo(() => {
    if (!detailNote) return [];
    const blocked = descendantsOf(detailNote.id);
    const q = normalize(detailParentSearch);
    if (!q) return [];
    return notes
      .filter((n) => !blocked.has(n.id))
      .filter((n) => n.title.toLowerCase().includes(q))
      .slice(0, 8);
  }, [notes, detailNote, detailParentSearch, childrenByParent]);

  const linkerNote = linkerNoteId ? noteById.get(linkerNoteId) : undefined;
  const linkerCandidates = useMemo(() => {
    if (!linkerNote) return [];
    const blocked = descendantsOf(linkerNote.id);
    const q = normalize(linkerSearch);
    if (!q) return [];
    return notes
      .filter((n) => !blocked.has(n.id))
      .filter((n) => n.title.toLowerCase().includes(q))
      .slice(0, 8);
  }, [linkerNote, linkerSearch, notes, childrenByParent]);

  const dueAlerts = useMemo(() => {
    const now = Date.now();
    return filteredNotes
      .filter((n) => {
        if (n.status === 'completed') return false;
        if (!n.alertEnabled) return false;
        const dt = toDateTime(n.alertDate, n.alertTime);
        return !!dt && dt.getTime() <= now;
      })
      .slice(0, 4);
  }, [filteredNotes]);

  const nearbyAlerts = useMemo(
    () => filteredNotes.filter((n) => n.status !== 'completed' && nearbyIds.has(n.id)).slice(0, 4),
    [filteredNotes, nearbyIds],
  );
  const geofenceCount = useMemo(
    () =>
      notes.filter((n) => n.locationAlert?.enabled && n.locationAlert?.lat != null && n.locationAlert?.lng != null)
        .length,
    [notes],
  );

  const metrics = useMemo(() => {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 86400000);
    const monthAgo = new Date(now.getTime() - 30 * 86400000);

    const open = notes.filter((n) => n.status === 'open');
    const completed = notes.filter((n) => n.status === 'completed');
    const overdue = open.filter((n) => {
      const d = parseUsDate(n.endDate);
      return d && d < now;
    });
    const completedThisWeek = completed.filter((n) => n.completedAt && new Date(n.completedAt) >= weekAgo);
    const completedThisMonth = completed.filter((n) => n.completedAt && new Date(n.completedAt) >= monthAgo);
    const createdThisWeek = notes.filter((n) => new Date(n.createdAt) >= weekAgo);

    const durations = completed
      .filter((n) => n.completedAt && n.createdAt)
      .map((n) => (new Date(n.completedAt!).getTime() - new Date(n.createdAt).getTime()) / 86400000);
    const avgDays = durations.length
      ? (durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(1)
      : null;

    let totalCheckItems = 0;
    let checkedItems = 0;
    open.forEach((n) =>
      n.checklist.filter((c) => c.kind === 'check').forEach((c) => {
        totalCheckItems++;
        if (c.checked) checkedItems++;
      }),
    );

    const recent = [...notes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5);

    return {
      total: notes.length,
      open: open.length,
      completed: completed.length,
      overdue: overdue.length,
      completedThisWeek: completedThisWeek.length,
      completedThisMonth: completedThisMonth.length,
      createdThisWeek: createdThisWeek.length,
      avgDays,
      totalCheckItems,
      checkedItems,
      recent,
    };
  }, [notes]);

  // Capture a snapshot of the note when the detail modal opens
  useEffect(() => {
    if (!detailNoteId) {
      detailOpenSnapshotRef.current = null;
      return;
    }
    // noteById intentionally omitted from deps — we want the state at open time only
    const note = noteById.get(detailNoteId);
    if (!note) return;
    detailOpenSnapshotRef.current = {
      savedAt: nowIso(),
      title: note.title,
      status: note.status,
      startDate: note.startDate,
      endDate: note.endDate,
      checklistCount: note.checklist.filter((c) => c.kind === 'check').length,
      checkedCount: note.checklist.filter((c) => c.kind === 'check' && !!c.checked).length,
    };
    setShowHistory(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailNoteId]);

  const closeDetailModal = () => {
    if (detailNoteId && detailOpenSnapshotRef.current) {
      const note = noteById.get(detailNoteId);
      if (note) {
        const snap = detailOpenSnapshotRef.current;
        const checklistCount = note.checklist.filter((c) => c.kind === 'check').length;
        const checkedCount = note.checklist.filter((c) => c.kind === 'check' && !!c.checked).length;
        const changed =
          note.title !== snap.title ||
          note.status !== snap.status ||
          note.startDate !== snap.startDate ||
          note.endDate !== snap.endDate ||
          checklistCount !== snap.checklistCount ||
          checkedCount !== snap.checkedCount;
        if (changed) {
          const noteId = detailNoteId;
          setNotes((prev) =>
            prev.map((n) =>
              n.id === noteId
                ? { ...n, history: [...(n.history ?? []).slice(-19), snap] }
                : n,
            ),
          );
        }
      }
    }
    detailOpenSnapshotRef.current = null;
    setDetailNoteId(null);
    setShowHistory(false);
  };

  const updateNote = (noteId: string, updater: (current: Note) => Note) => {
    setNotes((prev) => prev.map((n) => (n.id === noteId ? updater(n) : n)));
  };

  const toggleTopLevelStatus = (note: Note, checked: boolean) => {
    updateNote(note.id, (n) => ({
      ...n,
      status: checked ? 'completed' : 'open',
      completedAt: checked ? nowIso() : undefined,
      updatedAt: nowIso(),
    }));
  };

  const resolvePlace = async (query: string) => {
    if (!settings.locationServicesEnabled) {
      Alert.alert('Location disabled', 'Enable Location Services in Settings.');
      return null;
    }
    const q = query.trim();
    if (!q) {
      Alert.alert('Enter location', 'Type a store name or address.');
      return null;
    }
    try {
      if (GOOGLE_PLACES_KEY) {
        const googleUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&key=${GOOGLE_PLACES_KEY}`;
        const googleRes = await fetch(googleUrl);
        if (googleRes.ok) {
          const googleJson = (await googleRes.json()) as {
            results?: Array<{ geometry?: { location?: { lat?: number; lng?: number } } }>;
          };
          const loc = googleJson.results?.[0]?.geometry?.location;
          if (typeof loc?.lat === 'number' && typeof loc?.lng === 'number') {
            return { lat: loc.lat, lng: loc.lng };
          }
        }
      }

      const expoResults = await Location.geocodeAsync(q);
      if (expoResults.length) {
        return { lat: expoResults[0].latitude, lng: expoResults[0].longitude };
      }

      const osm = await fetchPlaceSuggestionsOsm(q);
      const first = osm[0];
      if (typeof first?.lat === 'number' && typeof first?.lng === 'number') {
        return { lat: first.lat, lng: first.lng };
      }

      Alert.alert('Not found', 'Try a more specific place or add city/state.');
      return null;
    } catch {
      Alert.alert('Lookup failed', 'Could not resolve this place right now.');
      return null;
    }
  };

  const fetchPlaceSuggestionsOsm = async (query: string): Promise<PlaceSuggestion[]> => {
    const q = query.trim();
    if (q.length < 2) return [];
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`;
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'Accept-Language': 'en-US',
        },
      });
      if (!res.ok) return [];
      const data = (await res.json()) as Array<{ display_name?: string; lat?: string; lon?: string }>;
      return data
        .map((item) => ({
          label: item.display_name ?? '',
          lat: Number(item.lat || '0'),
          lng: Number(item.lon || '0'),
        }))
        .filter((item) => item.label && Number.isFinite(item.lat) && Number.isFinite(item.lng));
    } catch {
      // fallback below
    }
    try {
      const pUrl = `https://photon.komoot.io/api/?limit=6&q=${encodeURIComponent(q)}`;
      const pRes = await fetch(pUrl);
      if (!pRes.ok) return [];
      const pJson = (await pRes.json()) as {
        features?: Array<{ properties?: { name?: string; city?: string; state?: string; country?: string }; geometry?: { coordinates?: number[] } }>;
      };
      return (pJson.features ?? [])
        .map((f) => {
          const coords = f.geometry?.coordinates ?? [];
          const parts = [f.properties?.name, f.properties?.city, f.properties?.state, f.properties?.country].filter(Boolean);
          return {
            label: parts.join(', '),
            lng: Number(coords[0]),
            lat: Number(coords[1]),
          };
        })
        .filter((x) => x.label && Number.isFinite(x.lat) && Number.isFinite(x.lng));
    } catch {
      return [];
    }
  };

  const fetchPlaceSuggestionsGoogle = async (query: string): Promise<PlaceSuggestion[]> => {
    const q = query.trim();
    if (!GOOGLE_PLACES_KEY || q.length < 2) return [];
    try {
      const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(
        q,
      )}&key=${GOOGLE_PLACES_KEY}`;
      const res = await fetch(url);
      if (!res.ok) return [];
      const data = (await res.json()) as {
        predictions?: Array<{ description?: string; place_id?: string }>;
      };
      return (data.predictions ?? [])
        .filter((p) => !!p.description && !!p.place_id)
        .slice(0, 6)
        .map((p) => ({
          label: p.description ?? '',
          placeId: p.place_id,
        }));
    } catch {
      return [];
    }
  };

  const fetchPlaceSuggestions = async (query: string): Promise<PlaceSuggestion[]> => {
    const google = await fetchPlaceSuggestionsGoogle(query);
    if (google.length) return google;
    return fetchPlaceSuggestionsOsm(query);
  };

  const resolveGooglePlaceId = async (placeId?: string): Promise<{ lat: number; lng: number } | null> => {
    if (!placeId || !GOOGLE_PLACES_KEY) return null;
    try {
      const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(
        placeId,
      )}&fields=geometry/location&key=${GOOGLE_PLACES_KEY}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = (await res.json()) as { result?: { geometry?: { location?: { lat?: number; lng?: number } } } };
      const loc = data.result?.geometry?.location;
      if (typeof loc?.lat === 'number' && typeof loc?.lng === 'number') {
        return { lat: loc.lat, lng: loc.lng };
      }
      return null;
    } catch {
      return null;
    }
  };

  const resolveSuggestionCoords = async (suggestion: PlaceSuggestion) => {
    if (typeof suggestion.lat === 'number' && typeof suggestion.lng === 'number') {
      return { lat: suggestion.lat, lng: suggestion.lng };
    }
    const byId = await resolveGooglePlaceId(suggestion.placeId);
    if (byId) return byId;
    return resolvePlace(suggestion.label);
  };

  const refreshNearby = async () => {
    if (!settings.locationServicesEnabled) {
      Alert.alert('Location disabled', 'Enable Location Services in Settings.');
      return;
    }
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission needed', 'Location permission is required.');
      return;
    }
    const current = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });

    const hits = new Set<string>();
    notes.forEach((n) => {
      const geo = n.locationAlert;
      if (!geo?.enabled || geo.lat == null || geo.lng == null) return;
      const meters = distanceMeters(current.coords.latitude, current.coords.longitude, geo.lat, geo.lng);
      if (meters <= (geo.radiusMeters ?? 150)) hits.add(n.id);
    });

    setNearbyIds(hits);
  };

  useEffect(() => {
    if (!settings.locationServicesEnabled || !locationEnabled) {
      setPlaceSuggestions([]);
      return;
    }
    const timer = setTimeout(() => {
      fetchPlaceSuggestions(placeQuery).then(setPlaceSuggestions);
    }, 260);
    return () => clearTimeout(timer);
  }, [placeQuery, locationEnabled, settings.locationServicesEnabled]);

  useEffect(() => {
    if (!settings.locationServicesEnabled || !detailNote?.locationAlert?.enabled) {
      setDetailPlaceSuggestions([]);
      return;
    }
    const q = detailNote.locationAlert.placeQuery ?? '';
    const timer = setTimeout(() => {
      fetchPlaceSuggestions(q).then(setDetailPlaceSuggestions);
    }, 260);
    return () => clearTimeout(timer);
  }, [detailNote?.id, detailNote?.locationAlert?.placeQuery, detailNote?.locationAlert?.enabled, settings.locationServicesEnabled]);

  const resetComposer = () => {
    setTitle('');
    setNewChecklist([]);
    setSelectedParentId(null);
    setParentSearch('');
    setStartDate(todayDateInput());
    setEndDate(todayDateInput());
    setAlertEnabled(false);
    setAlertDate(todayDateInput());
    setAlertTime('9:00 AM');
    setLocationEnabled(false);
    setPlaceQuery('');
    setRadiusMeters('150');
    setLocationOnEntry(true);
    setLocationOnExit(true);
    setComposerCoords(null);
    setShowComposer(false);
  };

  const addComposerChecklistItem = () => {
    setNewChecklist((prev) => [...prev, { id: id(), text: '', kind: 'bullet', checked: false }]);
  };

  const setComposerChecklistText = (itemId: string, value: string) => {
    setNewChecklist((prev) => prev.map((item) => (item.id === itemId ? { ...item, text: value } : item)));
  };

  const toggleComposerKind = (itemId: string) => {
    setNewChecklist((prev) =>
      prev.map((item) =>
        item.id === itemId
          ? { ...item, kind: item.kind === 'bullet' ? 'check' : 'bullet', checked: item.kind === 'bullet' ? false : item.checked }
          : item,
      ),
    );
  };

  const removeComposerChecklistItem = (itemId: string) => {
    setNewChecklist((prev) => prev.filter((item) => item.id !== itemId));
  };

  const resolveComposerPlace = async () => {
    const found = await resolvePlace(placeQuery);
    if (!found) return;
    setComposerCoords(found);
    Alert.alert('Location saved', 'Address/store resolved.');
  };

  const addNote = async () => {
    if (!title.trim()) {
      Alert.alert('Title required', 'Enter a title.');
      return;
    }

    let geo: LocationAlert | undefined;
    if (locationEnabled && settings.locationServicesEnabled) {
      if (!locationOnEntry && !locationOnExit) {
        Alert.alert('Choose trigger', 'Enable entry and/or exit for location alert.');
        return;
      }
      let coords = composerCoords;
      if (!coords) coords = await resolvePlace(placeQuery);
      if (!coords) return;
      geo = {
        enabled: true,
        placeQuery: placeQuery.trim(),
        lat: coords.lat,
        lng: coords.lng,
        radiusMeters: parseNumber(radiusMeters) || 150,
        onEntry: locationOnEntry,
        onExit: locationOnExit,
      };
    }

    const newNote: Note = {
      id: id(),
      title: title.trim(),
      checklist: newChecklist.filter((i) => i.text.trim()),
      parentId: selectedParentId,
      startDate,
      endDate,
      status: 'open',
      alertEnabled,
      alertDate: alertEnabled ? alertDate : undefined,
      alertTime: alertEnabled ? alertTime : undefined,
      attachments: [],
      locationAlert: geo,
      numericFields: {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    setNotes((prev) => [...prev, newNote]);
    resetComposer();
  };

  const setChecklistText = (noteId: string, itemId: string, text: string) => {
    updateNote(noteId, (n) => ({
      ...n,
      checklist: n.checklist.map((item) => (item.id === itemId ? { ...item, text } : item)),
      updatedAt: nowIso(),
    }));
  };

  const toggleChecklistKind = (noteId: string, itemId: string) => {
    updateNote(noteId, (n) => ({
      ...n,
      checklist: n.checklist.map((item) =>
        item.id === itemId
          ? { ...item, kind: item.kind === 'bullet' ? 'check' : 'bullet', checked: item.kind === 'bullet' ? false : item.checked }
          : item,
      ),
      updatedAt: nowIso(),
    }));
  };

  const toggleChecklistCheck = (noteId: string, itemId: string) => {
    updateNote(noteId, (n) => ({
      ...n,
      checklist: n.checklist.map((item) =>
        item.id === itemId && item.kind === 'check' ? { ...item, checked: !item.checked } : item,
      ),
      updatedAt: nowIso(),
    }));
  };

  const removeChecklistItem = (noteId: string, itemId: string) => {
    updateNote(noteId, (n) => ({
      ...n,
      checklist: n.checklist.filter((item) => item.id !== itemId),
      updatedAt: nowIso(),
    }));
  };

  const addChecklistItem = (noteId: string) => {
    updateNote(noteId, (n) => ({
      ...n,
      checklist: [...n.checklist, { id: id(), text: '', kind: 'bullet', checked: false }],
      updatedAt: nowIso(),
    }));
  };

  const markComplete = () => {
    if (!detailNote) return;
    const completionNote = detailCompletionNote.trim();
    const follow = detailFollowUpTitle.trim();

    let followUpNoteId: string | undefined;
    if (follow) {
      const existing = notes.find((n) => normalize(n.title) === normalize(follow));
      if (existing) {
        followUpNoteId = existing.id;
      } else {
        const newFollow: Note = {
          id: id(),
          title: follow,
          checklist: [],
          parentId: detailNote.parentId,
          startDate: todayDateInput(),
          endDate: todayDateInput(),
          status: 'open',
          alertEnabled: false,
          attachments: [],
          numericFields: {},
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        followUpNoteId = newFollow.id;
        setNotes((prev) => [...prev, newFollow]);
      }
    }

    updateNote(detailNote.id, (n) => ({
      ...n,
      status: 'completed',
      completedAt: nowIso(),
      completionNote,
      followUpNoteId,
      updatedAt: nowIso(),
    }));

    setDetailFollowUpTitle('');
  };

  const deleteNote = (noteId: string) => {
    const target = noteById.get(noteId);
    if (!target) return;

    Alert.alert('Delete note?', 'This note will be removed.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          setNotes((prev) =>
            prev
              .filter((n) => n.id !== noteId)
              .map((n) => {
                const parentId = n.parentId === noteId ? target.parentId : n.parentId;
                const followUpNoteId = n.followUpNoteId === noteId ? undefined : n.followUpNoteId;
                return parentId !== n.parentId || followUpNoteId !== n.followUpNoteId
                  ? { ...n, parentId, followUpNoteId, updatedAt: nowIso() }
                  : n;
              }),
          );
          detailOpenSnapshotRef.current = null;
          setDetailNoteId(null);
          setShowHistory(false);
        },
      },
    ]);
  };

  const duplicateNote = (note: Note) => {
    const copy: Note = {
      ...note,
      id: id(),
      title: `${note.title} (copy)`,
      checklist: note.checklist.map((item) => ({ ...item, id: id() })),
      status: 'open',
      completedAt: undefined,
      completionNote: undefined,
      followUpNoteId: undefined,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    setNotes((prev) => [...prev, copy]);
  };

  const attachMedia = async (target: Note) => {
    if (!settings.allowMediaAccess) {
      Alert.alert('Media blocked', 'Enable Media Access in Settings first.');
      return;
    }
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission needed', 'Media access is required.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.All,
      quality: 0.8,
      allowsMultipleSelection: false,
    });
    if (result.canceled || !result.assets?.length) return;

    const asset = result.assets[0];
    updateNote(target.id, (n) => ({
      ...n,
      attachments: [
        ...n.attachments,
        {
          id: id(),
          uri: asset.uri,
          type: asset.type === 'video' ? 'video' : asset.type === 'image' ? 'image' : 'unknown',
        },
      ],
      updatedAt: nowIso(),
    }));
  };

  const resolveDetailPlace = async (note: Note) => {
    const q = note.locationAlert?.placeQuery ?? '';
    const found = await resolvePlace(q);
    if (!found) return;
    updateNote(note.id, (n) => ({
      ...n,
      locationAlert: {
        ...(n.locationAlert ?? { enabled: true, placeQuery: q, radiusMeters: 150, onEntry: true, onExit: true }),
        enabled: true,
        lat: found.lat,
        lng: found.lng,
      },
      updatedAt: nowIso(),
    }));
    Alert.alert('Location saved', 'Address/store resolved.');
  };

  const openInMaps = async (note: Note) => {
    const lat = note.locationAlert?.lat;
    const lng = note.locationAlert?.lng;
    if (lat == null || lng == null) return;

    const label = encodeURIComponent(note.locationAlert?.placeQuery || note.title);
    const url = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}%20(${label})`;
    try {
      await Linking.openURL(url);
    } catch {
      Alert.alert('Unable to open maps', 'Could not open the map link.');
    }
  };

  const addTableColumn = () => {
    const name = newColumnName.trim();
    if (!name) {
      Alert.alert('Column name required', 'Enter a column name.');
      return;
    }
    const newId = `col_${id()}`;
    setTableData((prev) => ({
      columns: [...prev.columns, { id: newId, name, type: newColumnType, updatedAt: nowIso() }],
      rows: prev.rows.map((row) => ({ ...row, cells: { ...row.cells, [newId]: '' }, updatedAt: nowIso() })),
    }));
    setNewColumnName('');
    setNewColumnType('text');
  };

  const removeTableColumn = (columnId: string) => {
    setTableData((prev) => ({
      columns: prev.columns.filter((c) => c.id !== columnId),
      rows: prev.rows.map((row) => {
        const nextCells = { ...row.cells };
        delete nextCells[columnId];
        return { ...row, cells: nextCells, updatedAt: nowIso() };
      }),
    }));
  };

  const addTableRow = () => {
    setTableData((prev) => {
      const cells: Record<string, string> = {};
      prev.columns.forEach((c) => {
        cells[c.id] = '';
      });
      return { ...prev, rows: [...prev.rows, { id: `row_${id()}`, cells, updatedAt: nowIso() }] };
    });
  };

  const removeTableRow = (rowId: string) => {
    setTableData((prev) => ({ ...prev, rows: prev.rows.filter((r) => r.id !== rowId) }));
  };

  const updateTableCell = (rowId: string, colId: string, value: string) => {
    setTableData((prev) => ({
      ...prev,
      rows: prev.rows.map((row) =>
        row.id === rowId ? { ...row, cells: { ...row.cells, [colId]: value }, updatedAt: nowIso() } : row,
      ),
    }));
  };

  const tableTotals = useMemo(() => {
    const totals: Record<string, number> = {};
    tableData.columns
      .filter((c) => c.type === 'number')
      .forEach((c) => {
        totals[c.id] = tableData.rows.reduce((sum, row) => sum + parseNumber(row.cells[c.id] ?? ''), 0);
      });
    return totals;
  }, [tableData]);

  const noteAlertIcons = (note: Note) => {
    const icons: string[] = [];
    if (note.alertEnabled) icons.push('⏰');
    if (
      note.locationAlert?.enabled &&
      typeof note.locationAlert.lat === 'number' &&
      typeof note.locationAlert.lng === 'number'
    ) {
      icons.push('📍');
    }
    return icons;
  };

  const openDetail = (noteId: string) => {
    navigateToNote(noteId);
  };

  const renderTitleRow = (note: Note, depth: number) => {
    const icons = noteAlertIcons(note);
    return (
      <View key={note.id} style={[styles.titleRow, { marginLeft: depth * 14 }]}>
        <View style={styles.titleAccent} />
        <View style={styles.titleRowInner}>
          <View style={styles.titleTopRow}>
            <Checkbox value={note.status === 'completed'} onValueChange={(v) => toggleTopLevelStatus(note, v)} style={styles.checkbox} />
            <Pressable style={styles.titleTapArea} onPress={() => openDetail(note.id)}>
              <Text style={styles.titleRowText} numberOfLines={1}>
                {note.title}
              </Text>
            </Pressable>
            <View style={styles.iconRow}>
              {icons.map((icon) => (
                <Text key={`${note.id}_${icon}`} style={styles.iconText}>
                  {icon}
                </Text>
              ))}
              <Pressable
                style={styles.inlineLinkBtn}
                onPress={() => {
                  setLinkerNoteId(note.id);
                  setLinkerSearch('');
                }}
              >
                <Text style={styles.inlineLinkText}>🔗</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </View>
    );
  };

  const renderTree = (items: Note[], depth: number): React.ReactNode[] => {
    const out: React.ReactNode[] = [];
    items.forEach((note) => {
      out.push(renderTitleRow(note, depth));
      const children = (childrenByParent.get(note.id) ?? []).filter((n) => viewedIdSet.has(n.id));
      out.push(...renderTree(children, depth + 1));
    });
    return out;
  };

  if (!loaded) {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.header}>Loading...</Text>
      </SafeAreaView>
    );
  }

  if (locked) {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar style="dark" />
        <Text style={styles.header}>Locked</Text>
        <Pressable
          style={styles.primaryButton}
          onPress={async () => {
            const ok = await authenticate();
            if (ok) setLocked(false);
          }}
        >
          <Text style={styles.primaryButtonText}>Unlock</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="dark" />
      <Text style={styles.header}>Minimal Secure Notes</Text>

      <View style={styles.tabs}>
        {(['notes', 'table', 'settings', 'metrics'] as const).map((tab) => (
          <Pressable
            key={tab}
            style={[styles.tabBtn, activeTab === tab && styles.tabBtnActive]}
            onPress={() => setActiveTab(tab)}
          >
            <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>{tab.toUpperCase()}</Text>
          </Pressable>
        ))}
      </View>

      {activeTab === 'notes' && (
        <ScrollView contentContainerStyle={styles.scrollBody}>
          <TextInput style={styles.input} placeholder="Search" value={search} onChangeText={setSearch} />

          {(dueAlerts.length > 0 || nearbyAlerts.length > 0) && (
            <View style={styles.alertStrip}>
              {dueAlerts.length > 0 && <Text style={styles.alertStripTitle}>◷ Due</Text>}
              {dueAlerts.map((n) => (
                <Text key={`due_${n.id}`} style={styles.alertStripText}>• {n.title}</Text>
              ))}
              {nearbyAlerts.length > 0 && <Text style={styles.alertStripTitle}>◎ Nearby</Text>}
              {nearbyAlerts.map((n) => (
                <Text key={`near_${n.id}`} style={styles.alertStripText}>• {n.title}</Text>
              ))}
            </View>
          )}

          {!!lastMergeAt && !!lastMergeSummary && (
            <View style={styles.mergeStrip}>
              <Text style={styles.mergeStripTitle}>Sync merge ({lastMergeSource})</Text>
              <Text style={styles.mergeStripText}>{lastMergeSummary}</Text>
              <Text style={styles.mergeStripText}>{new Date(lastMergeAt).toLocaleString()}</Text>
              <Pressable
                style={styles.actionBtn}
                onPress={() => {
                  setLastMergeAt(null);
                  setLastMergeSource(null);
                  setLastMergeSummary(null);
                }}
              >
                <Text style={styles.actionText}>Dismiss</Text>
              </Pressable>
            </View>
          )}

          <View style={styles.topControls}>
            <Pressable style={styles.slimBtn} onPress={() => setTreeView((v) => !v)}>
              <Text style={styles.slimBtnText}>{treeView ? 'Tree' : 'List'}</Text>
            </Pressable>
            <Pressable style={styles.slimBtn} onPress={refreshNearby}>
              <Text style={styles.slimBtnText}>◎ Nearby</Text>
            </Pressable>
          </View>

          <View style={styles.sortRow}>
            {(['active', 'completed', 'all'] as NoteView[]).map((view) => (
              <Pressable
                key={view}
                style={[styles.sortChip, noteView === view && styles.sortChipActive]}
                onPress={() => setNoteView(view)}
              >
                <Text style={[styles.sortChipText, noteView === view && styles.sortChipTextActive]}>
                  {view === 'active' ? 'Active' : view === 'completed' ? 'Completed' : 'All'}
                </Text>
              </Pressable>
            ))}
          </View>

          <View style={styles.sortRow}>
            {(['status', 'endDate', 'startDate', 'updatedAt', 'title'] as SortField[]).map((field) => (
              <Pressable
                key={field}
                style={[styles.sortChip, sortField === field && styles.sortChipActive]}
                onPress={() => {
                  if (sortField === field) {
                    setSortDirection((v) => (v === 'asc' ? 'desc' : 'asc'));
                    return;
                  }
                  setSortField(field);
                  setSortDirection('asc');
                }}
              >
                <Text style={[styles.sortChipText, sortField === field && styles.sortChipTextActive]}>
                  {sortLabel[field]}
                  {sortField === field ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : ''}
                </Text>
              </Pressable>
            ))}
          </View>

          {treeView ? renderTree(roots, 0) : viewedNotes.map((n) => renderTitleRow(n, 0))}
        </ScrollView>
      )}

      {activeTab === 'table' && (
        <ScrollView contentContainerStyle={styles.scrollBody}>
          <View style={styles.row}>
            <TextInput
              style={[styles.input, styles.half]}
              placeholder="Column name"
              value={newColumnName}
              onChangeText={setNewColumnName}
            />
            <Pressable
              style={[styles.sortChip, newColumnType === 'text' && styles.sortChipActive]}
              onPress={() => setNewColumnType('text')}
            >
              <Text style={[styles.sortChipText, newColumnType === 'text' && styles.sortChipTextActive]}>Text</Text>
            </Pressable>
            <Pressable
              style={[styles.sortChip, newColumnType === 'number' && styles.sortChipActive]}
              onPress={() => setNewColumnType('number')}
            >
              <Text style={[styles.sortChipText, newColumnType === 'number' && styles.sortChipTextActive]}>
                Number
              </Text>
            </Pressable>
            <Pressable style={styles.actionBtn} onPress={addTableColumn}>
              <Text style={styles.actionText}>+ Col</Text>
            </Pressable>
          </View>

          <View style={styles.actionsRow}>
            {tableData.columns.map((col) => (
              <Pressable key={col.id} style={styles.tableColumnPill} onLongPress={() => removeTableColumn(col.id)}>
                <Text style={styles.tableColumnPillText}>
                  {col.name} ({col.type})
                </Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.meta}>Tip: long-press a column chip to remove it.</Text>

          <Pressable style={styles.primaryButton} onPress={addTableRow}>
            <Text style={styles.primaryButtonText}>Add Row</Text>
          </Pressable>

          <ScrollView horizontal showsHorizontalScrollIndicator>
            <View style={styles.gridWrap}>
              <View style={styles.gridRowHeader}>
                {tableData.columns.map((col) => (
                  <Text key={col.id} style={styles.gridHeaderCell}>
                    {col.name}
                  </Text>
                ))}
                <Text style={styles.gridHeaderCell}>Remove</Text>
              </View>

              {tableData.rows.map((row) => (
                <View key={row.id} style={styles.gridRow}>
                  {tableData.columns.map((col) => (
                    <TextInput
                      key={`${row.id}_${col.id}`}
                      style={styles.gridInput}
                      keyboardType={col.type === 'number' ? 'number-pad' : 'default'}
                      value={row.cells[col.id] ?? ''}
                      onChangeText={(v) => updateTableCell(row.id, col.id, v)}
                    />
                  ))}
                  <Pressable style={styles.removePill} onPress={() => removeTableRow(row.id)}>
                    <Text style={styles.removePillText}>X</Text>
                  </Pressable>
                </View>
              ))}

              {tableData.rows.length > 0 && (
                <View style={styles.gridTotalRow}>
                  {tableData.columns.map((col, index) => (
                    <Text key={`total_${col.id}`} style={styles.gridTotalCell}>
                      {col.type === 'number' ? String(tableTotals[col.id] ?? 0) : index === 0 ? 'Total' : ''}
                    </Text>
                  ))}
                  <Text style={styles.gridTotalCell} />
                </View>
              )}
            </View>
          </ScrollView>
        </ScrollView>
      )}

      {activeTab === 'settings' && (
        <ScrollView contentContainerStyle={styles.scrollBody}>
          <View style={styles.rowBetween}>
            <Text style={styles.meta}>Biometric lock</Text>
            <Pressable
              style={[styles.smallToggle, settings.requireBiometricOnOpen && styles.smallToggleOn]}
              onPress={() => setSettings((prev) => ({ ...prev, requireBiometricOnOpen: !prev.requireBiometricOnOpen }))}
            >
              <Text style={styles.toggleText}>{settings.requireBiometricOnOpen ? 'ON' : 'OFF'}</Text>
            </Pressable>
          </View>

          <View style={styles.rowBetween}>
            <Text style={styles.meta}>Notifications</Text>
            <Pressable
              style={[styles.smallToggle, settings.allowNotifications && styles.smallToggleOn]}
              onPress={() => setSettings((prev) => ({ ...prev, allowNotifications: !prev.allowNotifications }))}
            >
              <Text style={styles.toggleText}>{settings.allowNotifications ? 'ON' : 'OFF'}</Text>
            </Pressable>
          </View>

          <View style={styles.rowBetween}>
            <Text style={styles.meta}>Media access</Text>
            <Pressable
              style={[styles.smallToggle, settings.allowMediaAccess && styles.smallToggleOn]}
              onPress={() => setSettings((prev) => ({ ...prev, allowMediaAccess: !prev.allowMediaAccess }))}
            >
              <Text style={styles.toggleText}>{settings.allowMediaAccess ? 'ON' : 'OFF'}</Text>
            </Pressable>
          </View>

          <View style={styles.rowBetween}>
            <Text style={styles.meta}>Location services</Text>
            <Pressable
              style={[styles.smallToggle, settings.locationServicesEnabled && styles.smallToggleOn]}
              onPress={() =>
                setSettings((prev) => {
                  const next = !prev.locationServicesEnabled;
                  if (!next) setNearbyIds(new Set());
                  return { ...prev, locationServicesEnabled: next };
                })
              }
            >
              <Text style={styles.toggleText}>{settings.locationServicesEnabled ? 'ON' : 'OFF'}</Text>
            </Pressable>
          </View>
          <View style={styles.rowBetween}>
            <Text style={styles.meta}>Background geofence</Text>
            <Pressable
              style={[styles.smallToggle, settings.allowBackgroundLocation && styles.smallToggleOn]}
              onPress={() =>
                setSettings((prev) => ({ ...prev, allowBackgroundLocation: !prev.allowBackgroundLocation }))
              }
            >
              <Text style={styles.toggleText}>{settings.allowBackgroundLocation ? 'ON' : 'OFF'}</Text>
            </Pressable>
          </View>
          <Text style={styles.meta}>Active geofences: {Math.min(geofenceCount, 20)}/20</Text>

          <Text style={styles.section}>Cloud Sync</Text>
          {!SUPABASE_URL || !SUPABASE_ANON_KEY ? (
            <Text style={styles.meta}>
              Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY for cross-device sync.
            </Text>
          ) : !currentUserId ? (
            <>
              <TextInput
                style={styles.input}
                placeholder="Email"
                autoCapitalize="none"
                keyboardType="email-address"
                value={authEmail}
                onChangeText={setAuthEmail}
              />
              <TextInput
                style={styles.input}
                placeholder="Password"
                secureTextEntry
                value={authPassword}
                onChangeText={setAuthPassword}
              />
              <View style={styles.actionsRow}>
                <Pressable style={styles.primaryButton} onPress={signInCloud}>
                  <Text style={styles.primaryButtonText}>Sign In</Text>
                </Pressable>
                <Pressable style={styles.actionBtn} onPress={signUpCloud}>
                  <Text style={styles.actionText}>Sign Up</Text>
                </Pressable>
              </View>
            </>
          ) : (
            <>
              <Text style={styles.meta}>Signed in: {currentUserId.slice(0, 8)}...</Text>
              <Text style={styles.meta}>Sync: {syncStatus}</Text>
              {lastSyncedAt && <Text style={styles.meta}>Last sync: {new Date(lastSyncedAt).toLocaleString()}</Text>}
              {lastMergeAt && lastMergeSummary && (
                <Text style={styles.meta}>
                  Merge: {lastMergeSummary} ({lastMergeSource}) at {new Date(lastMergeAt).toLocaleString()}
                </Text>
              )}
              <View style={styles.actionsRow}>
                <Pressable style={styles.actionBtn} onPress={() => pushCloudState(currentUserId)}>
                  <Text style={styles.actionText}>Sync now</Text>
                </Pressable>
                <Pressable style={styles.deleteButton} onPress={signOutCloud}>
                  <Text style={styles.deleteButtonText}>Sign Out</Text>
                </Pressable>
              </View>
            </>
          )}

        </ScrollView>
      )}

      {activeTab === 'metrics' && (
        <ScrollView contentContainerStyle={styles.scrollBody}>
          <Text style={styles.section}>Summary</Text>
          <View style={styles.metricsGrid}>
            <View style={styles.metricCard}>
              <Text style={styles.metricCardValue}>{metrics.total}</Text>
              <Text style={styles.metricCardLabel}>Total</Text>
            </View>
            <View style={styles.metricCard}>
              <Text style={styles.metricCardValue}>{metrics.open}</Text>
              <Text style={styles.metricCardLabel}>Open</Text>
            </View>
            <View style={styles.metricCard}>
              <Text style={styles.metricCardValue}>{metrics.completed}</Text>
              <Text style={styles.metricCardLabel}>Completed</Text>
            </View>
            <View style={[styles.metricCard, metrics.overdue > 0 && styles.metricCardOverdue]}>
              <Text style={styles.metricCardValue}>{metrics.overdue}</Text>
              <Text style={styles.metricCardLabel}>Overdue</Text>
            </View>
          </View>

          <Text style={styles.section}>Completion</Text>
          <View style={styles.metricRow}>
            <Text style={styles.meta}>This week:</Text>
            <Text style={styles.metricValue}>{metrics.completedThisWeek}</Text>
          </View>
          <View style={styles.metricRow}>
            <Text style={styles.meta}>This month:</Text>
            <Text style={styles.metricValue}>{metrics.completedThisMonth}</Text>
          </View>
          <View style={styles.metricRow}>
            <Text style={styles.meta}>All time:</Text>
            <Text style={styles.metricValue}>{metrics.completed}</Text>
          </View>

          <Text style={styles.section}>Avg time to complete</Text>
          <Text style={styles.metricBig}>{metrics.avgDays != null ? `${metrics.avgDays} days` : '—'}</Text>

          <Text style={styles.section}>Checklist (open notes)</Text>
          <Text style={styles.metricBig}>
            {metrics.checkedItems}/{metrics.totalCheckItems} checked
            {metrics.totalCheckItems > 0
              ? ` (${Math.round((metrics.checkedItems / metrics.totalCheckItems) * 100)}%)`
              : ''}
          </Text>

          <Text style={styles.section}>Created this week</Text>
          <Text style={styles.metricBig}>{metrics.createdThisWeek}</Text>

          <Text style={styles.section}>Recently updated</Text>
          {metrics.recent.map((n) => (
            <View key={n.id} style={styles.metricRecentRow}>
              <Text style={styles.metricRecentTitle} numberOfLines={1}>{n.title}</Text>
              <Text style={styles.meta}>{new Date(n.updatedAt).toLocaleString()}</Text>
            </View>
          ))}
        </ScrollView>
      )}

      {activeTab === 'notes' && (
        <Pressable style={styles.fab} onPress={() => setShowComposer(true)}>
          <Text style={styles.fabText}>+</Text>
        </Pressable>
      )}

      {showComposer && (
        <View style={styles.overlay}>
          <View style={styles.sheet}>
            <View style={styles.rowBetween}>
              <Text style={styles.section}>New</Text>
              <Pressable style={styles.actionBtn} onPress={resetComposer}>
                <Text style={styles.actionText}>Close</Text>
              </Pressable>
            </View>

            <ScrollView contentContainerStyle={styles.sheetBody}>
              <TextInput style={styles.input} placeholder="Title" value={title} onChangeText={setTitle} />

              {newChecklist.map((item) => (
                <View key={item.id} style={styles.checkRow}>
                  {item.kind === 'check' ? (
                    <Checkbox
                      value={!!item.checked}
                      onValueChange={() =>
                        setNewChecklist((prev) =>
                          prev.map((x) => (x.id === item.id ? { ...x, checked: !x.checked } : x)),
                        )
                      }
                      style={styles.checkbox}
                    />
                  ) : (
                    <Text style={styles.bulletMark}>•</Text>
                  )}
                  <TextInput
                    style={styles.checkInput}
                    value={item.text}
                    placeholder="List item"
                    onChangeText={(v) => setComposerChecklistText(item.id, v)}
                  />
                  <Pressable style={styles.kindToggle} onPress={() => toggleComposerKind(item.id)}>
                    <Text style={styles.kindToggleText}>{item.kind === 'bullet' ? '☑' : '•'}</Text>
                  </Pressable>
                  <Pressable style={styles.removePill} onPress={() => removeComposerChecklistItem(item.id)}>
                    <Text style={styles.removePillText}>X</Text>
                  </Pressable>
                </View>
              ))}
              <Pressable style={styles.actionBtn} onPress={addComposerChecklistItem}>
                <Text style={styles.actionText}>+ Item</Text>
              </Pressable>

              {selectedParentId ? (
                <View style={styles.selectedPillWrap}>
                  <View style={styles.selectedPill}>
                    <Text style={styles.selectedPillText}>{noteById.get(selectedParentId)?.title ?? 'Parent'}</Text>
                    <Pressable onPress={() => setSelectedParentId(null)}>
                      <Text style={styles.selectedPillX}>x</Text>
                    </Pressable>
                  </View>
                </View>
              ) : (
                <>
                  <TextInput
                    style={styles.input}
                    placeholder={notes.length ? 'Search parent' : 'Parent disabled for first note'}
                    editable={notes.length > 0}
                    value={parentSearch}
                    onChangeText={setParentSearch}
                  />
                  {composerParentCandidates.length > 0 && (
                    <View style={styles.lookupList}>
                      {composerParentCandidates.map((candidate) => (
                        <Pressable
                          key={candidate.id}
                          style={styles.lookupItem}
                          onPress={() => {
                            setSelectedParentId(candidate.id);
                            setParentSearch('');
                          }}
                        >
                          <Checkbox value={selectedParentId === candidate.id} onValueChange={() => {}} style={styles.checkbox} />
                          <Text style={styles.lookupText}>{candidate.title}</Text>
                        </Pressable>
                      ))}
                    </View>
                  )}
                </>
              )}

              <View style={styles.row}>
                <TextInput
                  style={[styles.input, styles.half]}
                  placeholder="MM/DD/YYYY"
                  keyboardType="numbers-and-punctuation"
                  value={startDate}
                  onChangeText={setStartDate}
                />
                <TextInput
                  style={[styles.input, styles.half]}
                  placeholder="MM/DD/YYYY"
                  keyboardType="numbers-and-punctuation"
                  value={endDate}
                  onChangeText={setEndDate}
                />
              </View>

              <View style={styles.rowBetween}>
                <Text style={styles.meta}>Time alert</Text>
                <Pressable style={[styles.smallToggle, alertEnabled && styles.smallToggleOn]} onPress={() => setAlertEnabled((v) => !v)}>
                  <Text style={styles.toggleText}>{alertEnabled ? 'ON' : 'OFF'}</Text>
                </Pressable>
              </View>
              {alertEnabled && (
                <View style={styles.row}>
                  <TextInput
                    style={[styles.input, styles.half]}
                    placeholder="MM/DD/YYYY"
                    keyboardType="numbers-and-punctuation"
                    value={alertDate}
                    onChangeText={setAlertDate}
                  />
                  <TextInput
                    style={[styles.input, styles.half]}
                    placeholder="h:mm AM/PM"
                    keyboardType="numbers-and-punctuation"
                    value={alertTime}
                    onChangeText={setAlertTime}
                  />
                </View>
              )}

              {settings.locationServicesEnabled && (
                <>
                  <View style={styles.rowBetween}>
                    <Text style={styles.meta}>Location alert</Text>
                    <Pressable
                      style={[styles.smallToggle, locationEnabled && styles.smallToggleOn]}
                      onPress={() => setLocationEnabled((v) => !v)}
                    >
                      <Text style={styles.toggleText}>{locationEnabled ? 'ON' : 'OFF'}</Text>
                    </Pressable>
                  </View>
                  {locationEnabled && (
                    <>
                      <View style={styles.rowBetween}>
                        <View style={styles.inlineCheck}>
                          <Checkbox value={locationOnEntry} onValueChange={setLocationOnEntry} style={styles.checkbox} />
                          <Text style={styles.meta}>On entry</Text>
                        </View>
                        <View style={styles.inlineCheck}>
                          <Checkbox value={locationOnExit} onValueChange={setLocationOnExit} style={styles.checkbox} />
                          <Text style={styles.meta}>On exit</Text>
                        </View>
                      </View>
                      <TextInput
                        style={styles.input}
                        placeholder="Store or address"
                        value={placeQuery}
                        onChangeText={(v) => {
                          setPlaceQuery(v);
                          setComposerCoords(null);
                        }}
                      />
                      {placeSuggestions.length > 0 && (
                        <View style={styles.lookupList}>
                          {placeSuggestions.map((s, idx) => (
                            <Pressable
                              key={`${s.placeId ?? 'noid'}_${s.label}_${idx}`}
                              style={styles.lookupItem}
                              onPress={async () => {
                                const coords = await resolveSuggestionCoords(s);
                                if (!coords) return;
                                setPlaceQuery(s.label);
                                setComposerCoords(coords);
                                setPlaceSuggestions([]);
                              }}
                            >
                              <Text style={styles.lookupText}>{s.label}</Text>
                            </Pressable>
                          ))}
                        </View>
                      )}
                      <View style={styles.row}>
                        <TextInput
                          style={[styles.input, styles.half]}
                          placeholder="Radius (m)"
                          keyboardType="number-pad"
                          value={radiusMeters}
                          onChangeText={setRadiusMeters}
                        />
                        <Pressable style={[styles.actionBtn, styles.halfBtn]} onPress={resolveComposerPlace}>
                          <Text style={styles.actionText}>{composerCoords ? 'Resolved' : 'Find place'}</Text>
                        </Pressable>
                      </View>
                    </>
                  )}
                </>
              )}

              <Pressable style={styles.primaryButton} onPress={addNote}>
                <Text style={styles.primaryButtonText}>Create</Text>
              </Pressable>
            </ScrollView>
          </View>
        </View>
      )}

      {detailNote && (
        <View style={styles.overlay}>
          <View style={styles.sheet}>
            <View style={styles.rowBetween}>
              <Text style={styles.section}>Edit</Text>
              <Pressable style={styles.actionBtn} onPress={closeDetailModal}>
                <Text style={styles.actionText}>Close</Text>
              </Pressable>
            </View>

            <ScrollView contentContainerStyle={styles.sheetBody}>
              <TextInput
                style={styles.input}
                value={detailNote.title}
                placeholder="Title"
                onChangeText={(v) => updateNote(detailNote.id, (n) => ({ ...n, title: v, updatedAt: nowIso() }))}
              />

              <View style={styles.row}>
                <Pressable
                  style={[styles.statusPill, detailNote.status === 'open' && styles.statusPillActive]}
                  onPress={() =>
                    updateNote(detailNote.id, (n) => ({ ...n, status: 'open', completedAt: undefined, updatedAt: nowIso() }))
                  }
                >
                  <Text style={styles.statusPillText}>Open</Text>
                </Pressable>
                <Pressable
                  style={[styles.statusPill, detailNote.status === 'completed' && styles.statusPillActive]}
                  onPress={() =>
                    updateNote(detailNote.id, (n) => ({ ...n, status: 'completed', completedAt: nowIso(), updatedAt: nowIso() }))
                  }
                >
                  <Text style={styles.statusPillText}>Completed</Text>
                </Pressable>
              </View>

              <View style={styles.row}>
                <TextInput
                  style={[styles.input, styles.half]}
                  value={detailNote.startDate}
                  placeholder="MM/DD/YYYY"
                  keyboardType="numbers-and-punctuation"
                  onChangeText={(v) => updateNote(detailNote.id, (n) => ({ ...n, startDate: v, updatedAt: nowIso() }))}
                />
                <TextInput
                  style={[styles.input, styles.half]}
                  value={detailNote.endDate}
                  placeholder="MM/DD/YYYY"
                  keyboardType="numbers-and-punctuation"
                  onChangeText={(v) => updateNote(detailNote.id, (n) => ({ ...n, endDate: v, updatedAt: nowIso() }))}
                />
              </View>

              {detailNote.parentId ? (
                <View style={styles.selectedPillWrap}>
                  <View style={styles.selectedPill}>
                    <Text style={styles.selectedPillText}>{noteById.get(detailNote.parentId)?.title ?? 'Parent'}</Text>
                    <Pressable
                      onPress={() =>
                        updateNote(detailNote.id, (n) => ({ ...n, parentId: null, updatedAt: nowIso() }))
                      }
                    >
                      <Text style={styles.selectedPillX}>x</Text>
                    </Pressable>
                  </View>
                </View>
              ) : (
                <>
                  <TextInput
                    style={styles.input}
                    placeholder="Search parent"
                    value={detailParentSearch}
                    onChangeText={setDetailParentSearch}
                  />
                  {detailParentCandidates.length > 0 && (
                    <View style={styles.lookupList}>
                      {detailParentCandidates.map((candidate) => (
                        <Pressable
                          key={candidate.id}
                          style={styles.lookupItem}
                          onPress={() => {
                            updateNote(detailNote.id, (n) => ({ ...n, parentId: candidate.id, updatedAt: nowIso() }));
                            setDetailParentSearch('');
                          }}
                        >
                          <Checkbox value={false} onValueChange={() => {}} style={styles.checkbox} />
                          <Text style={styles.lookupText}>{candidate.title}</Text>
                        </Pressable>
                      ))}
                    </View>
                  )}
                </>
              )}

              {detailNote.checklist.map((item) => (
                <View key={item.id} style={styles.checkRow}>
                  {item.kind === 'check' ? (
                    <Checkbox
                      value={!!item.checked}
                      onValueChange={() => toggleChecklistCheck(detailNote.id, item.id)}
                      style={styles.checkbox}
                    />
                  ) : (
                    <Text style={styles.bulletMark}>•</Text>
                  )}
                  <TextInput
                    style={styles.checkInput}
                    value={item.text}
                    placeholder="List item"
                    onChangeText={(v) => setChecklistText(detailNote.id, item.id, v)}
                  />
                  <Pressable style={styles.kindToggle} onPress={() => toggleChecklistKind(detailNote.id, item.id)}>
                    <Text style={styles.kindToggleText}>{item.kind === 'bullet' ? '☑' : '•'}</Text>
                  </Pressable>
                  <Pressable style={styles.removePill} onPress={() => removeChecklistItem(detailNote.id, item.id)}>
                    <Text style={styles.removePillText}>X</Text>
                  </Pressable>
                </View>
              ))}
              <Pressable style={styles.actionBtn} onPress={() => addChecklistItem(detailNote.id)}>
                <Text style={styles.actionText}>+ Item</Text>
              </Pressable>

              <View style={styles.rowBetween}>
                <Text style={styles.meta}>Time alert</Text>
                <Pressable
                  style={[styles.smallToggle, detailNote.alertEnabled && styles.smallToggleOn]}
                  onPress={() =>
                    updateNote(detailNote.id, (n) => ({ ...n, alertEnabled: !n.alertEnabled, updatedAt: nowIso() }))
                  }
                >
                  <Text style={styles.toggleText}>{detailNote.alertEnabled ? 'ON' : 'OFF'}</Text>
                </Pressable>
              </View>
              {detailNote.alertEnabled && (
                <View style={styles.row}>
                  <TextInput
                    style={[styles.input, styles.half]}
                    value={detailNote.alertDate ?? ''}
                    placeholder="MM/DD/YYYY"
                    keyboardType="numbers-and-punctuation"
                    onChangeText={(v) => updateNote(detailNote.id, (n) => ({ ...n, alertDate: v, updatedAt: nowIso() }))}
                  />
                  <TextInput
                    style={[styles.input, styles.half]}
                    value={detailNote.alertTime ?? ''}
                    placeholder="h:mm AM/PM"
                    keyboardType="numbers-and-punctuation"
                    onChangeText={(v) => updateNote(detailNote.id, (n) => ({ ...n, alertTime: v, updatedAt: nowIso() }))}
                  />
                </View>
              )}

              {settings.locationServicesEnabled && (
                <>
                  <View style={styles.rowBetween}>
                    <Text style={styles.meta}>Location alert</Text>
                    <Pressable
                      style={[styles.smallToggle, !!detailNote.locationAlert?.enabled && styles.smallToggleOn]}
                      onPress={() =>
                        updateNote(detailNote.id, (n) => ({
                          ...n,
                          locationAlert: n.locationAlert?.enabled
                            ? undefined
                            : { enabled: true, placeQuery: '', radiusMeters: 150, onEntry: true, onExit: true },
                          updatedAt: nowIso(),
                        }))
                      }
                    >
                      <Text style={styles.toggleText}>{detailNote.locationAlert?.enabled ? 'ON' : 'OFF'}</Text>
                    </Pressable>
                  </View>

                  {!!detailNote.locationAlert?.enabled && (
                    <>
                      <View style={styles.rowBetween}>
                        <View style={styles.inlineCheck}>
                          <Checkbox
                            value={detailNote.locationAlert.onEntry ?? true}
                            onValueChange={(v) =>
                              updateNote(detailNote.id, (n) => ({
                                ...n,
                                locationAlert: {
                                  ...(n.locationAlert ?? { enabled: true, placeQuery: '', radiusMeters: 150 }),
                                  onEntry: v,
                                  onExit: n.locationAlert?.onExit ?? true,
                                },
                                updatedAt: nowIso(),
                              }))
                            }
                            style={styles.checkbox}
                          />
                          <Text style={styles.meta}>On entry</Text>
                        </View>
                        <View style={styles.inlineCheck}>
                          <Checkbox
                            value={detailNote.locationAlert.onExit ?? true}
                            onValueChange={(v) =>
                              updateNote(detailNote.id, (n) => ({
                                ...n,
                                locationAlert: {
                                  ...(n.locationAlert ?? { enabled: true, placeQuery: '', radiusMeters: 150 }),
                                  onExit: v,
                                  onEntry: n.locationAlert?.onEntry ?? true,
                                },
                                updatedAt: nowIso(),
                              }))
                            }
                            style={styles.checkbox}
                          />
                          <Text style={styles.meta}>On exit</Text>
                        </View>
                      </View>
                      <TextInput
                        style={styles.input}
                        placeholder="Store or address"
                        value={detailNote.locationAlert.placeQuery}
                        onChangeText={(v) =>
                          updateNote(detailNote.id, (n) => ({
                            ...n,
                            locationAlert: {
                              ...(n.locationAlert ?? { enabled: true, placeQuery: '', radiusMeters: 150 }),
                              placeQuery: v,
                              lat: undefined,
                              lng: undefined,
                              onEntry: n.locationAlert?.onEntry ?? true,
                              onExit: n.locationAlert?.onExit ?? true,
                            },
                            updatedAt: nowIso(),
                          }))
                        }
                      />
                      {detailPlaceSuggestions.length > 0 && (
                        <View style={styles.lookupList}>
                          {detailPlaceSuggestions.map((s, idx) => (
                            <Pressable
                              key={`${s.placeId ?? 'noid'}_${s.label}_${idx}`}
                              style={styles.lookupItem}
                              onPress={async () => {
                                const coords = await resolveSuggestionCoords(s);
                                if (!coords) return;
                                updateNote(detailNote.id, (n) => ({
                                  ...n,
                                  locationAlert: {
                                    ...(n.locationAlert ?? { enabled: true, placeQuery: '', radiusMeters: 150 }),
                                    placeQuery: s.label,
                                    lat: coords.lat,
                                    lng: coords.lng,
                                    onEntry: n.locationAlert?.onEntry ?? true,
                                    onExit: n.locationAlert?.onExit ?? true,
                                  },
                                  updatedAt: nowIso(),
                                }));
                                setDetailPlaceSuggestions([]);
                              }}
                            >
                              <Text style={styles.lookupText}>{s.label}</Text>
                            </Pressable>
                          ))}
                        </View>
                      )}
                      <View style={styles.row}>
                        <TextInput
                          style={[styles.input, styles.half]}
                          value={String(detailNote.locationAlert.radiusMeters ?? 150)}
                          placeholder="Radius (m)"
                          keyboardType="number-pad"
                          onChangeText={(v) =>
                            updateNote(detailNote.id, (n) => ({
                              ...n,
                              locationAlert: {
                                ...(n.locationAlert ?? { enabled: true, placeQuery: '', radiusMeters: 150 }),
                                radiusMeters: parseNumber(v) || 150,
                                onEntry: n.locationAlert?.onEntry ?? true,
                                onExit: n.locationAlert?.onExit ?? true,
                              },
                              updatedAt: nowIso(),
                            }))
                          }
                        />
                        <Pressable style={[styles.actionBtn, styles.halfBtn]} onPress={() => resolveDetailPlace(detailNote)}>
                          <Text style={styles.actionText}>
                            {detailNote.locationAlert.lat != null ? 'Resolved' : 'Find place'}
                          </Text>
                        </Pressable>
                      </View>
                      {detailNote.locationAlert.lat != null && detailNote.locationAlert.lng != null && (
                        <Pressable style={styles.actionBtn} onPress={() => openInMaps(detailNote)}>
                          <Text style={styles.actionText}>Open in Maps</Text>
                        </Pressable>
                      )}
                    </>
                  )}
                </>
              )}

              <View style={styles.actionsRow}>
                <Pressable style={styles.actionBtn} onPress={() => attachMedia(detailNote)}>
                  <Text style={styles.actionText}>Attach</Text>
                </Pressable>
                <Pressable style={styles.actionBtn} onPress={() => duplicateNote(detailNote)}>
                  <Text style={styles.actionText}>Duplicate</Text>
                </Pressable>
              </View>

              {detailNote.attachments.length > 0 && (
                <View style={styles.galleryWrap}>
                  <Text style={styles.meta}>Attachments</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.galleryRow}>
                    {detailNote.attachments
                      .filter((a) => a.type === 'image')
                      .map((a) => (
                        <Pressable key={a.id} onPress={() => setImagePreviewUri(a.uri)}>
                          <Image source={{ uri: a.uri }} style={styles.thumb} />
                        </Pressable>
                      ))}
                    {detailNote.attachments.filter((a) => a.type === 'video').map((a) => (
                      <View key={a.id} style={styles.videoChip}>
                        <Text style={styles.videoChipText}>🎬 Video</Text>
                      </View>
                    ))}
                  </ScrollView>
                </View>
              )}

              <TextInput
                style={styles.input}
                placeholder="Completion note"
                value={detailCompletionNote}
                onChangeText={setDetailCompletionNote}
              />
              <TextInput
                style={styles.input}
                placeholder="Follow-up title"
                value={detailFollowUpTitle}
                onChangeText={setDetailFollowUpTitle}
              />
              <Pressable style={styles.primaryButton} onPress={markComplete}>
                <Text style={styles.primaryButtonText}>Complete with note</Text>
              </Pressable>

              {/* History section */}
              <Pressable
                style={styles.actionBtn}
                onPress={() => setShowHistory((v) => !v)}
              >
                <Text style={styles.actionText}>
                  {showHistory
                    ? 'Hide history'
                    : `Show history (${(detailNote.history ?? []).length})`}
                </Text>
              </Pressable>
              {showHistory && (
                <FlatList
                  scrollEnabled={false}
                  data={[...(detailNote.history ?? [])].reverse()}
                  keyExtractor={(item) => item.savedAt}
                  renderItem={({ item }) => (
                    <View style={styles.historyRow}>
                      <Text style={styles.historyText}>
                        {new Date(item.savedAt).toLocaleString()} • {item.status} • {item.title} • {item.checkedCount}/{item.checklistCount} checklist
                      </Text>
                    </View>
                  )}
                  ListEmptyComponent={<Text style={styles.meta}>No history yet.</Text>}
                />
              )}

              <Pressable style={styles.deleteButton} onPress={() => deleteNote(detailNote.id)}>
                <Text style={styles.deleteButtonText}>Delete</Text>
              </Pressable>
            </ScrollView>
          </View>
        </View>
      )}

      {linkerNote && (
        <View style={styles.overlay}>
          <View style={styles.linkerSheet}>
            <View style={styles.rowBetween}>
              <Text style={styles.section}>Link Parent</Text>
              <Pressable style={styles.actionBtn} onPress={() => setLinkerNoteId(null)}>
                <Text style={styles.actionText}>Close</Text>
              </Pressable>
            </View>

            {linkerNote.parentId ? (
              <View style={styles.selectedPillWrap}>
                <View style={styles.selectedPill}>
                  <Text style={styles.selectedPillText}>{noteById.get(linkerNote.parentId)?.title ?? 'Parent'}</Text>
                  <Pressable
                    onPress={() =>
                      updateNote(linkerNote.id, (n) => ({ ...n, parentId: null, updatedAt: nowIso() }))
                    }
                  >
                    <Text style={styles.selectedPillX}>x</Text>
                  </Pressable>
                </View>
              </View>
            ) : (
              <>
                <TextInput
                  style={styles.input}
                  placeholder="Search existing note"
                  value={linkerSearch}
                  onChangeText={setLinkerSearch}
                />
                {linkerCandidates.length > 0 && (
                  <View style={styles.lookupList}>
                    {linkerCandidates.map((candidate) => (
                      <Pressable
                        key={candidate.id}
                        style={styles.lookupItem}
                        onPress={() => {
                          updateNote(linkerNote.id, (n) => ({ ...n, parentId: candidate.id, updatedAt: nowIso() }));
                          setLinkerSearch('');
                          setLinkerNoteId(null);
                        }}
                      >
                        <Text style={styles.lookupText}>{candidate.title}</Text>
                      </Pressable>
                    ))}
                  </View>
                )}
              </>
            )}
          </View>
        </View>
      )}

      <Modal visible={!!imagePreviewUri} transparent animationType="fade" onRequestClose={() => setImagePreviewUri(null)}>
        <Pressable style={styles.previewOverlay} onPress={() => setImagePreviewUri(null)}>
          {imagePreviewUri && <Image source={{ uri: imagePreviewUri }} style={styles.previewImage} resizeMode="contain" />}
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f3f5f8', paddingTop: 12 },
  header: { fontSize: 24, fontWeight: '700', paddingHorizontal: 12, color: '#0f172a' },
  tabs: { flexDirection: 'row', paddingHorizontal: 12, gap: 8, marginTop: 10, marginBottom: 6 },
  tabBtn: { paddingVertical: 8, paddingHorizontal: 8, borderRadius: 999, backgroundColor: '#dce3ec' },
  tabBtnActive: { backgroundColor: '#0f172a' },
  tabText: { color: '#1f2937', fontWeight: '700', fontSize: 12 },
  tabTextActive: { color: '#f8fafc' },
  scrollBody: { padding: 12, paddingBottom: 120, gap: 8 },
  section: { fontSize: 18, fontWeight: '600', marginTop: 8, color: '#0f172a' },
  input: {
    borderWidth: 1,
    borderColor: '#cad4e2',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
    backgroundColor: '#fff',
    marginTop: 6,
  },
  row: { flexDirection: 'row', gap: 8 },
  half: { flex: 1 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 },
  inlineCheck: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  topControls: { flexDirection: 'row', gap: 8, marginTop: 6 },
  slimBtn: { borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: '#fff' },
  slimBtnText: { color: '#334155', fontSize: 12, fontWeight: '600' },
  meta: { color: '#475569', fontSize: 12 },
  smallToggle: {
    minWidth: 48,
    borderRadius: 999,
    paddingVertical: 5,
    paddingHorizontal: 10,
    alignItems: 'center',
    backgroundColor: '#cbd5e1',
  },
  smallToggleOn: { backgroundColor: '#10b981' },
  toggleText: { color: '#0f172a', fontWeight: '700', fontSize: 12 },
  sortRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  sortChip: { borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: '#fff' },
  sortChipActive: { borderColor: '#0f172a', backgroundColor: '#e2e8f0' },
  sortChipText: { color: '#334155', fontSize: 12, fontWeight: '600' },
  sortChipTextActive: { color: '#0f172a' },
  titleRow: { marginTop: 8, borderWidth: 1, borderColor: '#d6deea', borderRadius: 10, overflow: 'hidden', backgroundColor: '#fff', flexDirection: 'row' },
  titleAccent: { width: 3, backgroundColor: '#93c5fd' },
  titleRowInner: { flex: 1, paddingHorizontal: 10, paddingVertical: 8 },
  titleTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  titleTapArea: { flex: 1 },
  titleRowText: { color: '#0f172a', fontSize: 14, fontWeight: '700' },
  titleRowMeta: { marginTop: 2, color: '#64748b', fontSize: 11 },
  iconRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  iconText: { fontSize: 14 },
  inlineLinkBtn: { paddingHorizontal: 2, paddingVertical: 2 },
  inlineLinkText: { fontSize: 15 },
  alertStrip: { marginTop: 8, borderWidth: 1, borderColor: '#f5d08a', backgroundColor: '#fff8e6', borderRadius: 10, padding: 10, gap: 3 },
  alertStripTitle: { fontWeight: '700', color: '#7c2d12' },
  alertStripText: { color: '#7c2d12', fontSize: 12 },
  mergeStrip: { marginTop: 8, borderWidth: 1, borderColor: '#93c5fd', backgroundColor: '#eff6ff', borderRadius: 10, padding: 10, gap: 4 },
  mergeStripTitle: { fontWeight: '700', color: '#1d4ed8' },
  mergeStripText: { color: '#1e3a8a', fontSize: 12 },
  gridWrap: { marginTop: 12, borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 10, backgroundColor: '#fff' },
  gridRowHeader: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#e2e8f0', backgroundColor: '#f8fafc' },
  gridHeaderCell: { minWidth: 140, paddingHorizontal: 10, paddingVertical: 8, fontWeight: '700', color: '#0f172a' },
  gridRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#eef2f7', alignItems: 'center' },
  gridInput: {
    minWidth: 140,
    borderWidth: 1,
    borderColor: '#d5deea',
    borderRadius: 8,
    margin: 6,
    paddingHorizontal: 8,
    paddingVertical: 8,
    backgroundColor: '#fff',
  },
  gridTotalRow: { flexDirection: 'row', backgroundColor: '#eef2ff' },
  gridTotalCell: { minWidth: 140, paddingHorizontal: 10, paddingVertical: 8, color: '#1e293b', fontWeight: '700' },
  tableColumnPill: { borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: '#fff' },
  tableColumnPillText: { color: '#334155', fontSize: 12, fontWeight: '600' },
  fab: {
    position: 'absolute',
    right: 18,
    bottom: 22,
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: '#0f172a',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.22,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  fabText: { color: '#fff', fontSize: 30, marginTop: -1 },
  overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(2,6,23,0.35)', justifyContent: 'flex-end' },
  sheet: {
    maxHeight: '90%',
    backgroundColor: '#f8fafc',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 12,
    paddingBottom: 18,
  },
  linkerSheet: {
    maxHeight: '45%',
    backgroundColor: '#f8fafc',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 12,
    paddingBottom: 18,
  },
  sheetBody: { paddingBottom: 40 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
  checkbox: { borderRadius: 4, width: 20, height: 20 },
  bulletMark: { fontSize: 22, color: '#0f172a', width: 20, textAlign: 'center' },
  checkInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#cad4e2',
    borderRadius: 8,
    backgroundColor: '#fff',
    paddingHorizontal: 8,
    paddingVertical: 7,
  },
  kindToggle: { borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, backgroundColor: '#fff' },
  kindToggleText: { color: '#0f172a', fontWeight: '700' },
  removePill: { borderRadius: 8, backgroundColor: '#fee2e2', paddingHorizontal: 8, paddingVertical: 6 },
  removePillText: { color: '#991b1b', fontSize: 11, fontWeight: '700' },
  selectedPillWrap: { marginTop: 6, flexDirection: 'row' },
  selectedPill: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#e2e8f0', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  selectedPillText: { color: '#0f172a', fontSize: 12, fontWeight: '600' },
  selectedPillX: { color: '#334155', fontWeight: '700' },
  lookupList: { marginTop: 6, borderWidth: 1, borderColor: '#d6deea', borderRadius: 10, backgroundColor: '#fff' },
  lookupItem: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: '#eef2f7' },
  lookupText: { color: '#0f172a', fontSize: 13 },
  actionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  actionBtn: { borderWidth: 1, borderColor: '#cad4e2', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, backgroundColor: '#f8fafc' },
  actionText: { color: '#1e293b', fontSize: 12, fontWeight: '600' },
  galleryWrap: { marginTop: 8, gap: 6 },
  galleryRow: { gap: 8, alignItems: 'center' },
  thumb: { width: 84, height: 84, borderRadius: 10, backgroundColor: '#dbe4ee' },
  videoChip: { borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: '#fff' },
  videoChipText: { color: '#0f172a', fontWeight: '600', fontSize: 12 },
  halfBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', marginTop: 6 },
  statusPill: { borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7, backgroundColor: '#fff', marginTop: 6 },
  statusPillActive: { borderColor: '#0f172a', backgroundColor: '#e2e8f0' },
  statusPillText: { color: '#0f172a', fontWeight: '700', fontSize: 12 },
  primaryButton: { marginTop: 10, paddingVertical: 10, borderRadius: 8, backgroundColor: '#0f172a', alignItems: 'center' },
  primaryButtonText: { color: '#fff', fontWeight: '700' },
  deleteButton: { marginTop: 10, paddingVertical: 10, borderRadius: 8, backgroundColor: '#fee2e2', alignItems: 'center' },
  deleteButtonText: { color: '#991b1b', fontWeight: '700' },
  previewOverlay: { flex: 1, backgroundColor: 'rgba(2,6,23,0.92)', alignItems: 'center', justifyContent: 'center', padding: 16 },
  previewImage: { width: '100%', height: '88%' },
  metricsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  metricCard: { flex: 1, minWidth: '40%', backgroundColor: '#fff', borderWidth: 1, borderColor: '#d6deea', borderRadius: 10, padding: 12, alignItems: 'center' },
  metricCardOverdue: { borderColor: '#f87171', backgroundColor: '#fff5f5' },
  metricCardValue: { fontSize: 28, fontWeight: '700', color: '#0f172a' },
  metricCardLabel: { fontSize: 12, color: '#64748b', marginTop: 2 },
  metricRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 },
  metricValue: { fontWeight: '700', color: '#0f172a', fontSize: 14 },
  metricBig: { fontSize: 20, fontWeight: '700', color: '#0f172a', marginTop: 4 },
  metricRecentRow: { marginTop: 6, borderWidth: 1, borderColor: '#d6deea', borderRadius: 8, padding: 8, backgroundColor: '#fff' },
  metricRecentTitle: { fontWeight: '600', color: '#0f172a', fontSize: 13 },
  historyRow: { marginTop: 6, borderWidth: 1, borderColor: '#d6deea', borderRadius: 8, padding: 8, backgroundColor: '#f8fafc' },
  historyText: { color: '#334155', fontSize: 12 },
});
