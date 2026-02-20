import { Event, VerifiedEvent } from 'nostr-tools';

//#region Event Kind Registry ------------------------------------------------

/** Human-readable names for known Nostr event kinds */
export const KIND_NAMES: Record<number, string> = {
  0: 'Profile Metadata',
  1: 'Short Text Note',
  2: 'Recommend Relay',
  3: 'Contact List',
  4: 'Encrypted DM (NIP-04)',
  5: 'Event Deletion',
  6: 'Repost',
  7: 'Reaction',
  8: 'Badge Award',
  16: 'Generic Repost',
  40: 'Channel Creation',
  41: 'Channel Metadata',
  42: 'Channel Message',
  43: 'Channel Hide Message',
  44: 'Channel Mute User',
  1063: 'File Metadata',
  1984: 'Report',
  9734: 'Zap Request',
  9735: 'Zap Receipt',
  10000: 'Mute List',
  10001: 'Pin List',
  10002: 'Relay List (NIP-65)',
  13194: 'Wallet Info',
  22242: 'Relay Auth (NIP-42)',
  23194: 'Wallet Request',
  23195: 'Wallet Response',
  24133: 'Nostr Connect (NIP-46)',
  27235: 'HTTP Auth (NIP-98)',
  30000: 'Follow Sets',
  30001: 'Generic Lists',
  30008: 'Profile Badges',
  30009: 'Badge Definition',
  30023: 'Long-form Article',
  30078: 'App-specific Data',
  31234: 'Draft Events',
};

/** Risk tiers for event kinds — determines how much scrutiny a signing request gets */
export type KindRiskTier = 'low' | 'medium' | 'high' | 'critical';

export const KIND_RISK: Record<number, KindRiskTier> = {
  // Low: read-only metadata, reactions, reposts
  0: 'medium',    // profile metadata changes are medium — identity modification
  1: 'low',       // text notes
  2: 'low',       // recommend relay
  5: 'high',      // deletion — destructive
  6: 'low',       // repost
  7: 'low',       // reaction
  16: 'low',      // generic repost
  // Medium: contact lists, relay lists, channel ops
  3: 'medium',    // contact list — social graph modification
  40: 'medium',   // channel creation
  41: 'medium',   // channel metadata
  42: 'low',      // channel message
  10002: 'medium', // relay list — affects connectivity
  // High: encrypted comms, financial, destructive
  4: 'high',      // encrypted DMs — privacy sensitive
  1984: 'high',   // reports — reputation affecting
  9734: 'critical', // zap request — financial
  9735: 'critical', // zap receipt — financial
  13194: 'critical', // wallet info
  23194: 'critical', // wallet request
  23195: 'critical', // wallet response
  // Auth: special handling
  22242: 'low',   // relay auth — identity proof only, no content
  27235: 'medium', // HTTP auth — grants access to services
  // NIP-46: remote signing — critical
  24133: 'critical',
};

/** Get the risk tier for a kind, defaulting to 'medium' for unknown kinds */
export function getKindRisk(kind: number): KindRiskTier {
  if (KIND_RISK[kind]) return KIND_RISK[kind];
  // Range-based defaults
  if (kind >= 20000 && kind < 30000) return 'low';    // ephemeral
  if (kind >= 10000 && kind < 20000) return 'medium';  // replaceable
  if (kind >= 30000 && kind < 40000) return 'medium';  // parameterized replaceable
  return 'medium';
}

/** Get human-readable name for a kind */
export function getKindName(kind: number): string {
  if (KIND_NAMES[kind]) return KIND_NAMES[kind];
  if (kind >= 1000 && kind < 10000) return `Regular Event (kind ${kind})`;
  if (kind >= 10000 && kind < 20000) return `Replaceable Event (kind ${kind})`;
  if (kind >= 20000 && kind < 30000) return `Ephemeral Event (kind ${kind})`;
  if (kind >= 30000 && kind < 40000) return `Param. Replaceable (kind ${kind})`;
  return `Unknown (kind ${kind})`;
}

/** Legacy compat — old code references KindNames as string-keyed object */
export const KindNames = KIND_NAMES;

//#endregion Event Kind Registry ---------------------------------------------

//#region Capabilities -------------------------------------------------------

/** Individual capabilities that can be granted to a host */
export type Capability =
  | 'getPublicKey'
  | 'getRelays'
  | 'signEvent'
  | 'nip04.encrypt'
  | 'nip04.decrypt'
  | 'nip44.encrypt'
  | 'nip44.decrypt';

export const ALL_CAPABILITIES: Capability[] = [
  'getPublicKey', 'getRelays', 'signEvent',
  'nip04.encrypt', 'nip04.decrypt', 'nip44.encrypt', 'nip44.decrypt',
];

/** Human-readable descriptions for each capability */
export const CAPABILITY_INFO: Record<Capability, { label: string; description: string; risk: KindRiskTier }> = {
  getPublicKey:    { label: 'Read Public Key',     description: 'See your Nostr public identity',                  risk: 'low' },
  getRelays:       { label: 'Read Relay List',     description: 'See your preferred relay servers',                risk: 'low' },
  signEvent:       { label: 'Sign Events',         description: 'Create posts, reactions, and other events as you', risk: 'high' },
  'nip04.encrypt': { label: 'Encrypt (NIP-04)',    description: 'Encrypt private messages to other users',         risk: 'high' },
  'nip04.decrypt': { label: 'Decrypt (NIP-04)',    description: 'Read your encrypted private messages',            risk: 'high' },
  'nip44.encrypt': { label: 'Encrypt (NIP-44)',    description: 'Encrypt messages with modern encryption',         risk: 'high' },
  'nip44.decrypt': { label: 'Decrypt (NIP-44)',    description: 'Decrypt messages with modern encryption',         risk: 'high' },
};

//#endregion Capabilities ----------------------------------------------------

//#region Permission Model ---------------------------------------------------

/** Duration options for temporary permissions */
export enum PermissionDuration {
  ONCE = 'once',              // single use, then revoked
  SESSION = 'session',        // until browser restart
  MINUTES_5 = '5m',
  MINUTES_30 = '30m',
  HOURS_1 = '1h',
  HOURS_8 = '8h',
  HOURS_24 = '24h',
  FOREVER = 'forever',        // until manually revoked
}

/** A single capability grant for a specific host */
export type CapabilityGrant = {
  /** Which capability is granted */
  capability: Capability;
  /** When this grant was created (unix seconds) */
  granted_at: number;
  /** When this grant expires (unix seconds), or null for forever */
  expires_at: number | null;
  /** Duration setting that was chosen */
  duration: PermissionDuration;
  /** For signEvent: optional allowlist of event kinds. Empty = all kinds allowed */
  allowedKinds?: number[];
};

/** Per-host permission record — replaces the old numeric level system */
export type SitePermission = {
  /** The host domain (e.g. "iris.to", "snort.social") */
  host: string;
  /** When this site first made a request (unix seconds) */
  first_seen: number;
  /** When this site last made a request (unix seconds) */
  last_active: number;
  /** Total number of requests from this site */
  request_count: number;
  /** Total number of requests that were denied */
  denied_count: number;
  /** Individual capability grants */
  grants: CapabilityGrant[];
};

/** Map of host -> SitePermission */
export type SitePermissions = {
  [host: string]: SitePermission;
};

//#endregion Permission Model ------------------------------------------------

//#region Audit Log ----------------------------------------------------------

/** What happened to a request */
export type AuditDisposition =
  | 'approved'       // user or auto-policy approved
  | 'rejected'       // user explicitly rejected
  | 'auto-approved'  // approved by existing grant (no prompt)
  | 'relay-auth'     // auto-approved relay auth (per-relay grant)
  | 'rate-limited'   // anti-spam blocked
  | 'cooldown'       // post-rejection cooldown
  | 'queue-full'     // too many pending prompts
  | 'deduped'        // duplicate request coalesced
  | 'error';         // processing error

/** A single audit log entry — persisted to storage */
export type AuditLogEntry = {
  /** Unique incrementing ID */
  id: number;
  /** ISO timestamp */
  timestamp: string;
  /** Request type: signEvent, nip04.decrypt, etc. */
  type: Capability | string;
  /** Originating host */
  host: string;
  /** What happened */
  disposition: AuditDisposition;
  /** Human-readable summary */
  summary: string;
  /** Whether this was handled silently (no popup) */
  silent: boolean;
  /** For signEvent: the event kind */
  eventKind?: number;
  /** For signEvent: the event kind name */
  eventKindName?: string;
  /** For signEvent: risk tier of the event kind */
  riskTier?: KindRiskTier;
  /** For encrypt/decrypt: the peer pubkey (truncated) */
  peer?: string;
  /** Which profile (pubkey) was used */
  profilePubKey?: string;
  /** Duration of the grant if permission was given */
  grantDuration?: PermissionDuration;
};

//#endregion Audit Log -------------------------------------------------------

//#region Configuration Keys -------------------------------------------------

export enum ConfigurationKeys {
  PRIVATE_KEY = 'private_key',
  PROFILES = 'profiles',
  OPEN_PROMPTS = 'open_prompts',
  PIN_ENABLED = 'pin_enabled',
  ENCRYPTED_PRIVATE_KEY = 'encrypted_private_key',
  ACTIVE_PUBLIC_KEY = 'active_public_key',
  PIN_CACHE_DURATION = 'pin_cache_duration',
  SESSION_TOKENS = 'session_tokens',
  RELAY_AUTH_GRANTS = 'relay_auth_grants',
  SITE_PERMISSIONS = 'site_permissions',
  AUDIT_LOG = 'audit_log',
  SECURITY_PREFERENCES = 'security_preferences',
}

//#endregion Configuration Keys ----------------------------------------------

//#region Security Preferences -----------------------------------------------

/** Global security settings */
export type SecurityPreferences = {
  /** Always prompt for critical-risk event kinds regardless of grants */
  alwaysPromptCritical: boolean;
  /** Show event content preview in prompts */
  showEventPreview: boolean;
  /** Maximum audit log entries to retain */
  maxAuditLogEntries: number;
  /** Default permission duration for new grants */
  defaultDuration: PermissionDuration;
};

export const DEFAULT_SECURITY_PREFERENCES: SecurityPreferences = {
  alwaysPromptCritical: true,
  showEventPreview: true,
  maxAuditLogEntries: 500,
  defaultDuration: PermissionDuration.ONCE,
};

//#endregion Security Preferences --------------------------------------------

//#region Profile Configuration ----------------------------------------------

export type RelaysConfig = {
  [url: string]: { read: boolean; write: boolean };
};

/** Legacy PermissionConfig — kept for migration, replaced by SitePermissions */
export type PermissionConfig = {
  [host: string]: {
    condition: string;
    created_at: number;
    level: number;
  };
};

export type ProfileConfig = {
  privateKey: string;
  name?: string;
  relays?: RelaysConfig;
  /** @deprecated — use SitePermissions in top-level storage instead */
  permissions?: PermissionConfig;
};

export type ProfilesConfig = {
  [pubKey: string]: ProfileConfig;
};

//#endregion Profile Configuration -------------------------------------------

//#region Prompt Types -------------------------------------------------------

/** What the user chose in the prompt */
export type PromptDecision = {
  /** Approve or reject */
  action: 'approve' | 'reject';
  /** Which capabilities to grant (for approve) */
  capabilities: Capability[];
  /** How long the grant lasts */
  duration: PermissionDuration;
  /** For signEvent: restrict to specific kinds */
  allowedKinds?: number[];
  /** Remember this decision for the host */
  remember: boolean;
};

export type PromptResponse = {
  /** ID assigned to the prompt */
  id: string;
  /** Indicates this is a prompt response message */
  prompt: boolean;
  /** The user's decision */
  decision: PromptDecision;
  /** The originating host */
  host: string | null;
};

/** Legacy AuthorizationCondition — kept for migration */
export enum AuthorizationCondition {
  REJECT = 'no',
  FOREVER = 'forever',
  EXPIRABLE_5M = 'expirable_5m',
  EXPIRABLE_1H = 'expirable_1h',
  EXPIRABLE_8H = 'expirable_8h',
  SINGLE = 'single'
}

export type PromptParams = {
  peer: string;
  plaintext?: string;
  ciphertext?: string;
  event?: Event;
};

export type ContentMessageArgs = {
  type: string;
  params: PromptParams;
  host: string;
};

export type ContentScriptMessageResponseError = {
  error: {
    message: string;
    stack?: any;
  };
};
export type ContentScriptMessageResponse =
  | ContentScriptMessageResponseError
  | string
  | VerifiedEvent
  | RelaysConfig;

export type OpenPromptItem = {
  id: string;
  windowId?: number;
  host: string;
  /** The capability being requested */
  capability: Capability;
  params: PromptParams;
  /** Site trust info passed to the prompt UI */
  siteInfo?: {
    first_seen: number;
    request_count: number;
    denied_count: number;
    existingGrants: Capability[];
  };
  /** Risk tier of the request */
  riskTier?: KindRiskTier;
  /** Event kind name if applicable */
  eventKindName?: string;
};

//#endregion Prompt Types ----------------------------------------------------

//#region PIN Types ----------------------------------------------------------

export type PinMessage = {
  type: 'setupPin' | 'verifyPin' | 'disablePin';
  pin?: string;
  encryptedKey?: string;
  id?: string;
};

export type PinMessageResponse = {
  success: boolean;
  error?: string;
};

//#endregion PIN Types -------------------------------------------------------

//#region Session Token Types -----------------------------------------------

/** A cached session token for a relay */
export type SessionTokenEntry = {
  /** The relay WebSocket URL (e.g. "wss://relay.example.com") */
  relayUrl: string;
  /** The hex-encoded session token */
  token: string;
  /** When this token expires (unix seconds) */
  expiresAt: number;
  /** The pubkey this token authenticates as (hex) */
  pubkey: string;
};

/** Map of relay URL -> SessionTokenEntry */
export type SessionTokenStore = {
  [relayUrl: string]: SessionTokenEntry;
};

/** A per-relay auth grant — allows auto-signing kind:22242 for trusted relays */
export type RelayAuthGrant = {
  /** The relay URL pattern (e.g. "wss://relay.example.com") */
  relayUrl: string;
  /** When this grant was created (unix seconds) */
  grantedAt: number;
  /** When this grant expires (unix seconds), or null for forever */
  expiresAt: number | null;
  /** Duration setting that was chosen */
  duration: PermissionDuration;
};

/** Map of relay URL -> RelayAuthGrant */
export type RelayAuthGrants = {
  [relayUrl: string]: RelayAuthGrant;
};

//#endregion Session Token Types --------------------------------------------
