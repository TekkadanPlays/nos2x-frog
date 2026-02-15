import browser from 'webextension-polyfill';
import { validateEvent, finalizeEvent, getPublicKey, nip44 } from 'nostr-tools';
import { nip04 } from 'nostr-tools';

import * as Storage from './storage';
import {
  type Capability,
  type ContentMessageArgs,
  type ContentScriptMessageResponse,
  type OpenPromptItem,
  type PinMessage,
  type PinMessageResponse,
  type PromptParams,
  type PromptResponse,
  type AuditDisposition,
  type SecurityPreferences,
  PermissionDuration,
  getKindRisk,
  getKindName,
  ALL_CAPABILITIES,
} from './types';
import {
  convertHexToUint8Array,
  openPopupWindow,
  derivePublicKeyFromPrivateKey
} from './common';
import { LRUCache } from './LRUCache';
import PromptManager from './PromptManager';
import { getCachedPin, setCachedPin, clearCachedPin } from './pinCache';
import { decryptPrivateKey, encryptPrivateKey } from './pinEncryption';
import { clearUint8Array, clearStringReference } from './memoryUtils';
import {
  logRequest, buildSummary, buildAuditExtra, getEntries, getEntriesByHost,
  getSuppressedCount, clearSuppressedCount, clearLog,
} from './requestLog';

//#region Prompt & PIN Maps --------------------------------------------------

const openPromptMap: Record<
  string,
  { id: string; windowId?: number; resolve: Function; reject: Function }
> = {};

// Gate to prevent multiple popup windows from opening concurrently.
// When the first request starts creating a window, subsequent requests
// await this same promise instead of spawning additional popups.
let pendingWindowPromise: Promise<browser.Windows.Window | browser.Tabs.Tab> | null = null;

const pinPromptMap: Record<
  string,
  { id: string; windowId?: number; resolve: Function; reject: Function; mode: string }
> = {};

//#endregion Prompt & PIN Maps -----------------------------------------------

//#region Anti-Spam Protection -----------------------------------------------

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 5000;
const PROMPT_QUEUE_CAP = 25;
const REJECTION_COOLDOWN_MS = 30000;

const requestTimestamps: Record<string, number[]> = {};
const rejectionCooldowns: Record<string, number> = {};

function checkRateLimit(host: string): 'cooldown' | 'rate-limited' | null {
  const now = Date.now();
  if (rejectionCooldowns[host] && now < rejectionCooldowns[host]) return 'cooldown';
  if (!requestTimestamps[host]) requestTimestamps[host] = [];
  requestTimestamps[host] = requestTimestamps[host].filter(ts => now - ts < RATE_LIMIT_WINDOW_MS);
  if (requestTimestamps[host].length >= RATE_LIMIT_MAX) return 'rate-limited';
  requestTimestamps[host].push(now);
  return null;
}

function isPromptQueueFull(): boolean {
  return Object.keys(openPromptMap).length >= PROMPT_QUEUE_CAP;
}

function setRejectionCooldown(host: string): void {
  rejectionCooldowns[host] = Date.now() + REJECTION_COOLDOWN_MS;
}

//#endregion Anti-Spam Protection --------------------------------------------

//#region Deduplication ------------------------------------------------------

const pendingSignRequests: Map<string, Promise<ContentScriptMessageResponse>> = new Map();
const DEDUP_TTL_MS = 30000;

function requestFingerprint(type: string, params: PromptParams): string | null {
  if (type === 'signEvent' && params.event) {
    const e = params.event;
    return `signEvent:${e.kind}:${e.created_at}:${e.pubkey}:${e.content}:${JSON.stringify(e.tags)}`;
  }
  if ((type === 'nip04.decrypt' || type === 'nip44.decrypt') && params.peer && params.ciphertext) {
    return `${type}:${params.peer}:${params.ciphertext}`;
  }
  if ((type === 'nip04.encrypt' || type === 'nip44.encrypt') && params.peer && params.plaintext) {
    return `${type}:${params.peer}:${params.plaintext}`;
  }
  return null;
}

//#endregion Deduplication ---------------------------------------------------

//#region Badge --------------------------------------------------------------

function updateBadge() {
  const count = getSuppressedCount();
  if (count > 0) {
    browser.browserAction.setBadgeText({ text: String(count > 99 ? '99+' : count) });
    browser.browserAction.setBadgeBackgroundColor({ color: '#e04040' });
  } else {
    browser.browserAction.setBadgeText({ text: '' });
  }
}

//#endregion Badge -----------------------------------------------------------

//#region Capability Mapping -------------------------------------------------

/** Map request type string to Capability */
function typeToCapability(type: string): Capability | null {
  if (ALL_CAPABILITIES.includes(type as Capability)) return type as Capability;
  return null;
}

/** Request types that are read-only and low-risk — skip anti-spam AND auto-approve */
const AUTO_APPROVE_TYPES = new Set<string>(['getPublicKey', 'getRelays']);

//#endregion Capability Mapping ----------------------------------------------

//#region Message Router -----------------------------------------------------

browser.runtime.onMessage.addListener(async (message: any, sender: any) => {
  // Activity log queries from popup
  if (message.type === 'getActivityLog') {
    return { entries: getEntries(), suppressedCount: getSuppressedCount() };
  }
  if (message.type === 'getActivityLogByHost') {
    return { entries: getEntriesByHost(message.host) };
  }
  if (message.type === 'clearActivityLog') {
    clearLog();
    updateBadge();
    return { success: true };
  }
  if (message.type === 'clearSuppressedCount') {
    clearSuppressedCount();
    updateBadge();
    return { success: true };
  }

  // Site permission queries from popup/options
  if (message.type === 'getSitePermissions') {
    return { permissions: await Storage.readSitePermissions() };
  }
  if (message.type === 'revokeGrant') {
    await Storage.revokeGrant(message.host, message.capability);
    return { success: true };
  }
  if (message.type === 'revokeAllGrants') {
    await Storage.revokeAllGrants(message.host);
    return { success: true };
  }
  if (message.type === 'removeSite') {
    await Storage.removeSite(message.host);
    return { success: true };
  }

  // Security preferences
  if (message.type === 'getSecurityPreferences') {
    return await Storage.readSecurityPreferences();
  }
  if (message.type === 'updateSecurityPreference') {
    await Storage.updateSecurityPreference(message.key, message.value);
    return { success: true };
  }

  // PIN messages
  if (message.type === 'setupPin' || message.type === 'verifyPin' || message.type === 'disablePin') {
    return handlePinMessage(message as PinMessage, sender);
  }
  if (message.type === 'openPinPrompt') {
    const mode = message.mode as 'setup' | 'unlock' | 'disable';
    if (mode && ['setup', 'unlock', 'disable'].includes(mode)) {
      await promptPin(mode);
      return { success: true };
    }
    return { success: false, error: 'Invalid PIN mode' };
  }

  // Encrypt private key
  if (message.type === 'encryptPrivateKey') {
    return handleEncryptPrivateKey(message);
  }

  // Get cached PIN
  if (message.type === 'getCachedPin') {
    const pin = await getCachedPin();
    return { success: true, pin };
  }

  // Prompt response
  let { prompt } = message as PromptResponse;
  if (prompt) {
    handlePromptMessage(message as PromptResponse, sender);
  } else {
    return handleContentScriptMessage(message as ContentMessageArgs);
  }
});

browser.runtime.onMessageExternal.addListener(async (message: any, sender: any) => {
  const { type, params } = message as ContentMessageArgs;
  let extensionId = new URL(sender.url ?? '').host;
  return handleContentScriptMessage({ type, params, host: extensionId });
});

//#endregion Message Router --------------------------------------------------

//#region Lifecycle ----------------------------------------------------------

browser.runtime.onStartup.addListener(async () => {
  console.debug('Browser startup. Clearing stale prompts and session grants.');
  await PromptManager.clear();
  await Storage.clearSessionGrants();
  await Storage.purgeExpiredGrants();
  // Migrate old permissions if they exist
  await Storage.migrateOldPermissions();
});

browser.runtime.onInstalled.addListener(async () => {
  console.debug('Extension installed/updated. Clearing stale prompts.');
  await PromptManager.clear();
  await Storage.migrateOldPermissions();
});

browser.windows.onRemoved.addListener((_windowId: number) => {
  // Handle closed prompt windows as rejections
  const openPrompts = Object.values(openPromptMap).filter(({ windowId }) => windowId === _windowId);
  const closeAllAsync = async () => {
    for (const openPrompt of openPrompts) {
      await handlePromptMessage(
        {
          id: openPrompt.id,
          prompt: true,
          decision: { action: 'reject', capabilities: [], duration: PermissionDuration.ONCE, remember: false },
          host: null,
        },
        null
      );
    }
  };
  closeAllAsync();

  // Handle closed PIN prompts
  const pinPrompts = Object.values(pinPromptMap).filter(({ windowId }) => windowId === _windowId);
  for (const pinPrompt of pinPrompts) {
    pinPrompt.reject(new Error('PIN prompt window closed'));
    delete pinPromptMap[pinPrompt.id];
  }
});

//#endregion Lifecycle -------------------------------------------------------

//#region Permission Checking ------------------------------------------------

/**
 * Check if a host has permission for a capability.
 * Returns the grant if authorized, or null if a prompt is needed.
 */
async function checkExistingGrant(
  host: string,
  capability: Capability,
  params: PromptParams,
  secPrefs: SecurityPreferences
): Promise<{ authorized: boolean; disposition?: AuditDisposition }> {
  const eventKind = params.event?.kind;

  // NIP-42 auto-sign
  if (capability === 'signEvent' && eventKind === 22242 && secPrefs.nip42AutoSign) {
    return { authorized: true, disposition: 'auto-signed' };
  }

  // Always prompt for critical-risk kinds if preference is set
  if (secPrefs.alwaysPromptCritical && capability === 'signEvent' && eventKind !== undefined) {
    const risk = getKindRisk(eventKind);
    if (risk === 'critical') {
      return { authorized: false };
    }
  }

  // Check for an active grant
  const grant = await Storage.hasActiveGrant(host, capability, eventKind);
  if (grant) {
    // Consume one-time grants
    if (grant.duration === PermissionDuration.ONCE) {
      await Storage.consumeOnceGrant(host, capability);
    }
    return { authorized: true, disposition: 'auto-approved' };
  }

  return { authorized: false };
}

/**
 * Prompt the user for permission. Returns true if granted.
 */
async function promptForPermission(
  host: string,
  capability: Capability,
  params: PromptParams
): Promise<boolean> {
  // Get site info for the prompt UI
  const siteInfo = await Storage.getSitePermission(host);
  const activeCapabilities = siteInfo ? await Storage.getActiveCapabilities(host) : [];

  const eventKind = params.event?.kind;
  const riskTier = capability === 'signEvent' && eventKind !== undefined
    ? getKindRisk(eventKind) : undefined;
  const eventKindName = capability === 'signEvent' && eventKind !== undefined
    ? getKindName(eventKind) : undefined;

  const id = Math.random().toString().slice(4);

  return new Promise((resolve, reject) => {
    const promptPageURL = `${browser.runtime.getURL('prompt.html')}`;

    // Determine how to get a window: reuse existing, join pending creation, or create new.
    let windowPromise: Promise<browser.Windows.Window | browser.Tabs.Tab>;

    const existingEntry = Object.values(openPromptMap).find(({ windowId }) => windowId);
    if (existingEntry) {
      // A prompt window already exists and is tracked — reuse it.
      windowPromise = browser.windows
        ? browser.windows.get(existingEntry.windowId as number)
        : browser.tabs.get(existingEntry.windowId as number);
    } else if (pendingWindowPromise) {
      // Another request is already creating a window — wait for it instead of spawning a second.
      windowPromise = pendingWindowPromise;
    } else {
      // First request — create the popup and store the promise as a gate.
      if (browser.windows) {
        pendingWindowPromise = browser.windows.create({
          url: promptPageURL,
          type: 'popup',
          width: 640,
          height: 520,
        });
      } else {
        pendingWindowPromise = browser.tabs.create({ url: promptPageURL, active: true });
      }
      windowPromise = pendingWindowPromise;
    }

    windowPromise.then(win => {
      // Clear the gate once the window is known.
      pendingWindowPromise = null;

      openPromptMap[id] = { id, windowId: win.id, resolve, reject };
      PromptManager.add({
        id,
        windowId: win.id,
        host,
        capability,
        params,
        siteInfo: siteInfo ? {
          first_seen: siteInfo.first_seen,
          request_count: siteInfo.request_count,
          denied_count: siteInfo.denied_count,
          existingGrants: activeCapabilities,
        } : undefined,
        riskTier,
        eventKindName,
      });
    }).catch(err => {
      pendingWindowPromise = null;
      console.error('[Ribbit Signer] Failed to open prompt window:', err);
      reject(err);
    });
  });
}

//#endregion Permission Checking ---------------------------------------------

//#region Content Script Message Handling -------------------------------------

async function handleContentScriptMessage({
  type,
  params,
  host
}: ContentMessageArgs): Promise<ContentScriptMessageResponse> {
  const summary = buildSummary(type, params);
  const auditExtra = buildAuditExtra(type, params);

  // Touch the site record (track first_seen, request_count, last_active)
  await Storage.touchSite(host);

  // Auto-approve read-only types (getPublicKey, getRelays) — no prompt needed
  if (AUTO_APPROVE_TYPES.has(type)) {
    logRequest(type, host, 'auto-approved', summary, true, auditExtra);
    return processRequest({ type, params, host });
  }

  // Anti-spam for non-auto-approve types
  const rateLimitResult = checkRateLimit(host);
  if (rateLimitResult) {
    logRequest(type, host, rateLimitResult, summary, true, auditExtra);
    updateBadge();
    return { error: { message: `[Ribbit Signer] Request blocked: too many requests from ${host}. Try again shortly.` } };
  }
  if (isPromptQueueFull()) {
    logRequest(type, host, 'queue-full', summary, true, auditExtra);
    updateBadge();
    return { error: { message: `[Ribbit Signer] Request blocked: too many pending prompts. Please respond to existing prompts first.` } };
  }

  // Dedup
  const fp = requestFingerprint(type, params);
  if (fp) {
    const existing = pendingSignRequests.get(fp);
    if (existing) {
      logRequest(type, host, 'deduped', summary, true, auditExtra);
      updateBadge();
      return existing;
    }
    const resultPromise = processRequest({ type, params, host });
    pendingSignRequests.set(fp, resultPromise);
    const cleanup = () => { pendingSignRequests.delete(fp); };
    resultPromise.then(cleanup, cleanup);
    setTimeout(cleanup, DEDUP_TTL_MS);
    return resultPromise;
  }

  return processRequest({ type, params, host });
}

async function processRequest({
  type,
  params,
  host
}: ContentMessageArgs): Promise<ContentScriptMessageResponse> {
  const summary = buildSummary(type, params);
  const auditExtra = buildAuditExtra(type, params);
  const capability = typeToCapability(type);

  if (!capability) {
    logRequest(type, host, 'error', `Unknown type: ${type}`, false, auditExtra);
    return { error: { message: `Unknown request type "${type}"` } };
  }

  // Read-only types are auto-approved — skip permission checks entirely
  if (AUTO_APPROVE_TYPES.has(type)) {
    // Fall through to execution below
  } else {
    // Load security preferences
    const secPrefs = await Storage.readSecurityPreferences();

    // Check existing grants
    const grantCheck = await checkExistingGrant(host, capability, params, secPrefs);

    if (grantCheck.authorized) {
      // Log the auto-approval
      if (grantCheck.disposition) {
        logRequest(type, host, grantCheck.disposition, summary, true, auditExtra);
        updateBadge();
      }
    } else {
      // Need to prompt
      try {
        const allowed = await promptForPermission(host, capability, params);
        if (!allowed) {
          await Storage.incrementDenied(host);
          setRejectionCooldown(host);
          logRequest(type, host, 'rejected', summary, false, auditExtra);
          return { error: { message: `Permission denied by user` } };
        }
        logRequest(type, host, 'approved', summary, false, auditExtra);
      } catch (error: any) {
        console.error('[Ribbit Signer] Prompt error:', error);
        logRequest(type, host, 'error', summary, false, auditExtra);
        return { error: { message: error?.message || 'Permission prompt failed' } };
      }
    }
  }

  // Get decrypted private key
  let privateKey = await getDecryptedPrivateKey();
  if (!privateKey) {
    return { error: { message: 'No private key found' } };
  }

  const activePubKey = derivePublicKeyFromPrivateKey(privateKey);
  const sk = convertHexToUint8Array(privateKey);
  privateKey = clearStringReference(privateKey) as any;

  let result: ContentScriptMessageResponse;
  try {
    switch (type) {
      case 'getPublicKey':
        result = activePubKey;
        break;
      case 'getRelays':
        result = (await Storage.readActiveRelays()) || {};
        break;
      case 'signEvent': {
        if (!params.event) {
          result = { error: { message: 'Empty event' } };
          break;
        }
        if (params.event?.pubkey && params.event.pubkey !== activePubKey) {
          throw new Error(`Public key mismatch: event pubkey doesn't match active profile.`);
        }
        const event = finalizeEvent(params.event, sk);
        result = validateEvent(event) ? event : { error: { message: 'Invalid event' } };
        break;
      }
      case 'nip04.encrypt':
        result = await nip04.encrypt(sk, params.peer, params.plaintext as string);
        break;
      case 'nip04.decrypt':
        result = await nip04.decrypt(sk, params.peer, params.ciphertext as string);
        break;
      case 'nip44.encrypt': {
        const key = getSharedSecret(sk, params.peer);
        result = nip44.v2.encrypt(params.plaintext as string, key);
        break;
      }
      case 'nip44.decrypt': {
        const key = getSharedSecret(sk, params.peer);
        result = nip44.v2.decrypt(params.ciphertext as string, key);
        break;
      }
      default:
        result = { error: { message: `Unknown type "${type}"` } };
        break;
    }
  } catch (error: any) {
    logRequest(type, host, 'error', summary, false, auditExtra);
    return { error: { message: error?.message, stack: error?.stack } };
  } finally {
    clearUint8Array(sk);
  }

  return result;
}

//#endregion Content Script Message Handling ----------------------------------

//#region Prompt Response Handling --------------------------------------------

async function handlePromptMessage(
  { id, decision, host }: PromptResponse,
  sender: any
): Promise<void> {
  const openPrompt = openPromptMap[id];
  if (!openPrompt) {
    console.warn('Message from unrecognized prompt:', id);
    await PromptManager.remove(id);
    return;
  }

  try {
    if (decision.action === 'approve') {
      openPrompt.resolve?.(true);

      // Store grants if user chose to remember
      if (decision.remember && host) {
        for (const cap of decision.capabilities) {
          await Storage.addGrant(host, cap, decision.duration, decision.allowedKinds);
        }
      }
    } else {
      openPrompt.resolve?.(false);
      if (host) {
        setRejectionCooldown(host);
        await Storage.incrementDenied(host);
      }
    }

    delete openPromptMap[id];

    // Close prompt window if no more prompts
    if (sender) {
      const openPrompts = await PromptManager.get();
      if (openPrompts.length === 1) {
        if (browser.windows) {
          await browser.windows.remove(sender.tab.windowId);
        } else {
          await browser.tabs.remove(sender.tab.id);
        }
      }
    }
    await PromptManager.remove(id);
  } catch (error) {
    console.error('Error handling prompt response.', error);
    openPrompt.reject?.(error);
  }
}

//#endregion Prompt Response Handling -----------------------------------------

//#region PIN Handling -------------------------------------------------------

async function getDecryptedPrivateKey(): Promise<string | null> {
  const pinEnabled = await Storage.isPinEnabled();

  if (!pinEnabled) {
    return await Storage.readActivePrivateKey();
  }

  let pin = await getCachedPin();
  if (!pin) {
    pin = await promptPin('unlock');
    if (!pin) return null;
    await setCachedPin(pin);
  }

  let decryptedKey: string | null = null;
  try {
    const encryptedKey = await Storage.getEncryptedPrivateKey();
    if (!encryptedKey) throw new Error('Encrypted private key not found');
    decryptedKey = await decryptPrivateKey(pin, encryptedKey);
    return decryptedKey;
  } catch (error) {
    clearCachedPin();
    throw error;
  } finally {
    pin = clearStringReference(pin) as any;
  }
}

function promptPin(mode: 'setup' | 'unlock' | 'disable'): Promise<string | null> {
  let id = Math.random().toString().slice(4);

  return new Promise((resolve, reject) => {
    let openPinPromise: Promise<browser.Windows.Window | browser.Tabs.Tab>;

    const existingPinPrompt = Object.values(pinPromptMap).find(p => p.mode === mode);
    if (existingPinPrompt) {
      openPinPromise = new Promise((res, rej) => {
        if (existingPinPrompt.windowId) {
          browser.windows.get(existingPinPrompt.windowId as number).then(win => res(win));
        } else {
          rej();
        }
      });
    } else {
      const pinPageURL = `pin.html?mode=${mode}&id=${id}`;
      openPinPromise = openPopupWindow(pinPageURL, { width: 400, height: 300 });
    }

    openPinPromise
      .then(win => { pinPromptMap[id] = { id, windowId: win.id, resolve, reject, mode }; })
      .catch(reject);
  });
}

async function handlePinMessage(
  message: PinMessage,
  sender: browser.Runtime.MessageSender
): Promise<PinMessageResponse> {
  const { type, pin, encryptedKey, id } = message;
  const pinPrompt = id ? pinPromptMap[id] : pinPromptMap[Object.keys(pinPromptMap)[0]];

  if (!pinPrompt) {
    return { success: false, error: 'PIN prompt not found' };
  }

  let localPin = pin;

  try {
    switch (type) {
      case 'setupPin': {
        if (!localPin || !encryptedKey) return { success: false, error: 'Missing PIN or encrypted key' };
        await Storage.setEncryptedPrivateKey(encryptedKey);
        await Storage.enablePinProtectionWithEncryptedKey(localPin, encryptedKey);
        await setCachedPin(localPin);
        pinPrompt.resolve(localPin);
        delete pinPromptMap[pinPrompt.id];
        await closePinWindow(sender);
        return { success: true };
      }
      case 'verifyPin': {
        if (!localPin) return { success: false, error: 'Missing PIN' };
        const storedEncryptedKey = await Storage.getEncryptedPrivateKey();
        if (!storedEncryptedKey) return { success: false, error: 'No encrypted key found' };
        try {
          await decryptPrivateKey(localPin, storedEncryptedKey);
          await setCachedPin(localPin);
          pinPrompt.resolve(localPin);
          delete pinPromptMap[pinPrompt.id];
          await closePinWindow(sender);
          return { success: true };
        } catch {
          return { success: false, error: 'Incorrect PIN' };
        }
      }
      case 'disablePin': {
        if (!localPin) return { success: false, error: 'Missing PIN' };
        await Storage.disablePinProtection(localPin);
        clearCachedPin();
        pinPrompt.resolve(localPin);
        delete pinPromptMap[pinPrompt.id];
        await closePinWindow(sender);
        return { success: true };
      }
      default:
        return { success: false, error: 'Unknown PIN message type' };
    }
  } catch (error: any) {
    pinPrompt.reject(error);
    delete pinPromptMap[pinPrompt.id];
    return { success: false, error: error?.message };
  } finally {
    localPin = clearStringReference(localPin) as any;
  }
}

async function closePinWindow(sender: any): Promise<void> {
  if (sender?.tab) {
    if (browser.windows && sender.tab.windowId !== undefined) {
      await browser.windows.remove(sender.tab.windowId);
    } else if (sender.tab.id !== undefined) {
      await browser.tabs.remove(sender.tab.id);
    }
  }
}

async function handleEncryptPrivateKey(message: any): Promise<any> {
  const pinEnabled = await Storage.isPinEnabled();
  if (!pinEnabled) return { success: false, error: 'PIN protection is not enabled' };

  const { privateKey } = message;
  if (!privateKey) return { success: false, error: 'Private key is required' };

  let pin = await getCachedPin();
  if (!pin) {
    pin = await promptPin('unlock');
    if (!pin) return { success: false, error: 'PIN is required to encrypt private key' };
    await setCachedPin(pin);
  }

  try {
    const encrypted = await encryptPrivateKey(pin, privateKey);
    return { success: true, encryptedKey: encrypted };
  } catch (error: any) {
    return { success: false, error: error?.message };
  } finally {
    pin = clearStringReference(pin) as any;
  }
}

//#endregion PIN Handling ----------------------------------------------------

//#region Shared Secret Cache ------------------------------------------------

const secretsCache = new LRUCache<string, Uint8Array>(100);
let previousSk: Uint8Array | null = null;

function getSharedSecret(sk: Uint8Array, peer: string) {
  if (previousSk !== sk) {
    secretsCache.clear();
  }
  let key = secretsCache.get(peer);
  if (!key) {
    key = nip44.v2.utils.getConversationKey(sk, peer);
    secretsCache.set(peer, key);
  }
  return key;
}

//#endregion Shared Secret Cache ---------------------------------------------
