/**
 * AuditLog — persistent audit trail of all signer requests.
 *
 * Uses a write-through cache: entries are kept in memory for fast access
 * and periodically flushed to browser.storage.local for persistence across
 * restarts. The in-memory buffer is the source of truth during a session;
 * storage is loaded once on init and written back on every mutation.
 */

import browser from 'webextension-polyfill';
import {
  type AuditLogEntry,
  type AuditDisposition,
  type KindRiskTier,
  type PermissionDuration,
  type PromptParams,
  ConfigurationKeys,
  getKindName,
  getKindRisk,
} from './types';

// Re-export types that other modules import from here
export type { AuditDisposition, AuditLogEntry };
// Legacy alias so existing imports of RequestDisposition still work during migration
export type RequestDisposition = AuditDisposition;

/** Maximum entries retained in storage */
const MAX_ENTRIES = 500;

/** Auto-incrementing ID — restored from storage on init */
let nextId = 1;

/** In-memory buffer (source of truth during session) */
let entries: AuditLogEntry[] = [];

/** Count of silent (suppressed) entries since last badge clear */
let suppressedCount = 0;

/** Whether we've loaded from storage yet */
let initialized = false;

/** Listeners for real-time updates */
const listeners: Set<() => void> = new Set();

/** Debounce timer for storage writes */
let flushTimer: any = null;
const FLUSH_DELAY_MS = 1000;

//#region Storage I/O --------------------------------------------------------

async function loadFromStorage(): Promise<void> {
  try {
    const data = await browser.storage.local.get([
      ConfigurationKeys.AUDIT_LOG,
      'audit_log_next_id',
      'audit_log_suppressed',
    ]);
    const stored = data[ConfigurationKeys.AUDIT_LOG];
    if (Array.isArray(stored)) {
      entries = stored;
    }
    if (typeof data['audit_log_next_id'] === 'number') {
      nextId = data['audit_log_next_id'];
    } else if (entries.length > 0) {
      nextId = entries[entries.length - 1].id + 1;
    }
    if (typeof data['audit_log_suppressed'] === 'number') {
      suppressedCount = data['audit_log_suppressed'];
    }
    initialized = true;
  } catch (err) {
    console.error('[AuditLog] Failed to load from storage:', err);
    initialized = true;
  }
}

function scheduleFlush(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flushToStorage, FLUSH_DELAY_MS);
}

async function flushToStorage(): Promise<void> {
  try {
    await browser.storage.local.set({
      [ConfigurationKeys.AUDIT_LOG]: entries,
      'audit_log_next_id': nextId,
      'audit_log_suppressed': suppressedCount,
    });
  } catch (err: any) {
    // Quota exceeded — aggressively trim and retry once
    if (err?.message?.includes('quota') || err?.message?.includes('Quota')) {
      console.warn('[AuditLog] Quota exceeded — trimming to', Math.floor(MAX_ENTRIES / 4), 'entries');
      entries = entries.slice(-Math.floor(MAX_ENTRIES / 4));
      try {
        await browser.storage.local.set({
          [ConfigurationKeys.AUDIT_LOG]: entries,
          'audit_log_next_id': nextId,
          'audit_log_suppressed': suppressedCount,
        });
      } catch (retryErr) {
        // Still failing — nuke the log entirely to free space
        console.error('[AuditLog] Still over quota — clearing log entirely');
        entries = [];
        suppressedCount = 0;
        await browser.storage.local.remove([
          ConfigurationKeys.AUDIT_LOG,
          'audit_log_next_id',
          'audit_log_suppressed',
        ]).catch(() => {});
      }
    } else {
      console.error('[AuditLog] Failed to flush to storage:', err);
    }
  }
}

//#endregion Storage I/O -----------------------------------------------------

// Initialize on module load
loadFromStorage();

//#region Public API ----------------------------------------------------------

/**
 * Record a request in the audit log.
 */
export function logRequest(
  type: string,
  host: string,
  disposition: AuditDisposition,
  summary: string,
  silent: boolean,
  extra?: {
    eventKind?: number;
    eventKindName?: string;
    riskTier?: KindRiskTier;
    peer?: string;
    profilePubKey?: string;
    grantDuration?: PermissionDuration;
  }
): AuditLogEntry {
  const entry: AuditLogEntry = {
    id: nextId++,
    timestamp: new Date().toISOString(),
    type,
    host,
    disposition,
    summary,
    silent,
    ...extra,
  };

  entries.push(entry);

  // Trim to max size
  while (entries.length > MAX_ENTRIES) {
    entries.shift();
  }

  if (silent) {
    suppressedCount++;
  }

  // Notify listeners
  for (const fn of listeners) {
    try { fn(); } catch (_) {}
  }

  scheduleFlush();
  return entry;
}

/**
 * Get all log entries (newest last).
 */
export function getEntries(): AuditLogEntry[] {
  return [...entries];
}

/**
 * Get entries filtered by host.
 */
export function getEntriesByHost(host: string): AuditLogEntry[] {
  return entries.filter(e => e.host === host);
}

/**
 * Get the count of suppressed (silent) requests since last clear.
 */
export function getSuppressedCount(): number {
  return suppressedCount;
}

/**
 * Reset the suppressed count.
 */
export function clearSuppressedCount(): void {
  suppressedCount = 0;
  scheduleFlush();
}

/**
 * Clear all log entries.
 */
export function clearLog(): void {
  entries.length = 0;
  suppressedCount = 0;
  for (const fn of listeners) {
    try { fn(); } catch (_) {}
  }
  scheduleFlush();
}

/**
 * Immediately clear the audit log from storage to free quota.
 * Returns a promise so callers can await the space being freed.
 */
export async function clearLogFromStorage(): Promise<void> {
  entries = [];
  suppressedCount = 0;
  nextId = 1;
  await browser.storage.local.remove([
    ConfigurationKeys.AUDIT_LOG,
    'audit_log_next_id',
    'audit_log_suppressed',
  ]);
}

/**
 * Subscribe to log changes.
 */
export function onLogChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

//#endregion Public API -------------------------------------------------------

//#region Summary Builders ----------------------------------------------------

/**
 * Build a human-readable summary for a request.
 */
export function buildSummary(type: string, params: PromptParams | any): string {
  if (type === 'getPublicKey') return 'Read public key';
  if (type === 'getRelays') return 'Read relay list';

  if (type === 'signEvent' && params?.event) {
    const kind = params.event.kind;
    const name = getKindName(kind);
    return `Sign: ${name}`;
  }

  if (type === 'nip04.encrypt') return `NIP-04 encrypt → ${shortHex(params?.peer)}`;
  if (type === 'nip04.decrypt') return `NIP-04 decrypt ← ${shortHex(params?.peer)}`;
  if (type === 'nip44.encrypt') return `NIP-44 encrypt → ${shortHex(params?.peer)}`;
  if (type === 'nip44.decrypt') return `NIP-44 decrypt ← ${shortHex(params?.peer)}`;

  return type;
}

/**
 * Build extra metadata for an audit log entry from request params.
 */
export function buildAuditExtra(type: string, params: PromptParams | any): {
  eventKind?: number;
  eventKindName?: string;
  riskTier?: KindRiskTier;
  peer?: string;
  profilePubKey?: string;
} {
  const extra: any = {};

  if (type === 'signEvent' && params?.event) {
    const kind = params.event.kind;
    extra.eventKind = kind;
    extra.eventKindName = getKindName(kind);
    extra.riskTier = getKindRisk(kind);
  }

  if (params?.peer) {
    extra.peer = shortHex(params.peer);
  }

  return extra;
}

function shortHex(hex?: string): string {
  if (!hex) return '???';
  return hex.substring(0, 8) + '…';
}

//#endregion Summary Builders -------------------------------------------------
