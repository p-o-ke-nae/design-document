import type { ActionsEvent, ActionsStatus, TrackerUpdate } from '@ddv/services';
import { api, workspace } from './backend/index.ts';

export type { ActionsEvent, ActionsRunDetail, ActionsRunList, ActionsRunRow, ActionsStatus, TrackerUpdate } from '@ddv/services';

/** `GET /api/actions` of a server without Actions (or an error): the feature is not shown. */
const HIDDEN: ActionsStatus = { state: 'hidden', reason: '', workflow: null, canInit: false };

/** Actions calls of the current workspace's Backend (HttpBackend: `/api/actions/...`; PagesBackend: the target's ActionsService). */
export const actionsApi = {
  status: (refresh = false) => api.actionsStatus(refresh),
  runs: () => api.actionsRuns(),
  dispatch: (body: { ids?: string[]; runner?: string }) => api.actionsDispatch(body),
  run: (id: string) => api.actionsRun(id),
  approve: (id: string, ids: string[]) => api.actionsApprove(id, ids),
  init: (force = false) => api.actionsInit(force),
  /** A file of the run on the results branch (`runs/<id>/<path>`): a URL (Pages: `blob:`). */
  file: (id: string, path: string) => api.actionsFile(id, path),
  /** The same file's contents. */
  blob: (id: string, path: string) => api.actionsBlob(id, path),
};

// --- ActionsStatus shared by the tests tab and the matrices (one request per workspace at a time) ---

let statusCache: { ws: string; at: number; p: Promise<ActionsStatus> } | null = null;
const statusListeners = new Set<(s: ActionsStatus) => void>();
const STATUS_CACHE_MS = 30_000;

export function loadActionsStatus(refresh = false): Promise<ActionsStatus> {
  const ws = workspace();
  if (!refresh && statusCache && statusCache.ws === ws && Date.now() - statusCache.at < STATUS_CACHE_MS) return statusCache.p;
  const p = actionsApi.status(refresh).catch(() => HIDDEN);
  statusCache = { ws, at: Date.now(), p };
  void p.then((s) => {
    if (statusCache?.p === p) for (const l of statusListeners) l(s);
  });
  return p;
}

export function onActionsStatus(listener: (s: ActionsStatus) => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

/** Forgets the cached status (Pages: the target was loaded again, e.g. after the PAT changed). */
export function resetActionsStatus(): void {
  statusCache = null;
}

// --- SSE `actions` (received by the app's /api/events connection, kept here so that screens opened later see the replay) ---

const trackers = new Map<string, TrackerUpdate>();
const eventListeners = new Set<(e: ActionsEvent) => void>();

/** Called when the app's event stream (re)connects: the server replays the trackers. */
export function resetActionsEvents(): void {
  trackers.clear();
}

export function emitActionsEvent(e: ActionsEvent): void {
  if (e.type === 'tracker') trackers.set(e.request, e);
  for (const l of eventListeners) l(e);
}

export function trackerOf(request: string): TrackerUpdate | undefined {
  return trackers.get(request);
}

export function onActionsEvent(listener: (e: ActionsEvent) => void): () => void {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

/** Splits the ids field (comma / space separated). */
export function splitIds(text: string): string[] {
  return text
    .split(/[\s,、]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
