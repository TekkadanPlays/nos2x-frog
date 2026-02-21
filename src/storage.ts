import browser from 'webextension-polyfill';
import { getPublicKey } from 'nostr-tools';

import {
  AuthorizationCondition,
  ConfigurationKeys,
  OpenPromptItem,
  PermissionConfig,
  ProfileConfig,
  ProfilesConfig,
  RelaysConfig,
  type Capability,
  type CapabilityGrant,
  type SitePermission,
  type SitePermissions,
  type SecurityPreferences,
  type SessionTokenEntry,
  type SessionTokenStore,
  type ClientIdStore,
  type RelayAuthGrant,
  type RelayAuthGrants,
  PermissionDuration,
  DEFAULT_SECURITY_PREFERENCES,
} from './types';
import {
  convertHexToUint8Array,
  isPrivateKeyEncrypted,
  derivePublicKeyFromPrivateKey,
  canDerivePublicKeyFromPrivateKey
} from './common';
import { encryptPrivateKey, decryptPrivateKey } from './pinEncryption';
import { clearStringReference } from './memoryUtils';

export async function readActivePrivateKey(): Promise<string> {
  const data = await browser.storage.local.get(ConfigurationKeys.PRIVATE_KEY);
  return data[ConfigurationKeys.PRIVATE_KEY] as string;
}

export async function updateActivePrivateKey(privateKey: string) {
  // Critical: If PIN protection is enabled, reject plain-text storage
  const pinEnabled = await isPinEnabled();
  if (pinEnabled && privateKey) {
    throw new Error(
      'Cannot store plain-text private key when PIN protection is enabled. Use setEncryptedPrivateKey() instead.'
    );
  }

  if (privateKey == null || privateKey == '') {
    console.log('Removing active profile (private key)');
    await removeActivePublicKey();
  } else {
    console.log('Storing new active pubKey');
    // Always store active public key for consistent profile lookup
    const publicKey = derivePublicKeyFromPrivateKey(privateKey);
    await setActivePublicKey(publicKey);
  }

  return browser.storage.local.set({
    [ConfigurationKeys.PRIVATE_KEY]: privateKey
  });
}

//#region PIN Protection >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

/**
 * Checks if PIN protection is enabled
 */
export async function isPinEnabled(): Promise<boolean> {
  const data = await browser.storage.local.get(ConfigurationKeys.PIN_ENABLED);
  return (data[ConfigurationKeys.PIN_ENABLED] as boolean) ?? false;
}

/**
 * Sets PIN protection enabled/disabled state
 */
export async function setPinEnabled(enabled: boolean): Promise<void> {
  await browser.storage.local.set({
    [ConfigurationKeys.PIN_ENABLED]: enabled
  });
}

/**
 * Gets the PIN cache duration in milliseconds
 * Default: 10 seconds (10000 ms)
 */
export async function getPinCacheDuration(): Promise<number> {
  const data = await browser.storage.local.get(ConfigurationKeys.PIN_CACHE_DURATION);
  return (data[ConfigurationKeys.PIN_CACHE_DURATION] as number) ?? 10 * 1000; // Default: 10 seconds
}

/**
 * Sets the PIN cache duration in milliseconds
 */
export async function setPinCacheDuration(durationMs: number): Promise<void> {
  await browser.storage.local.set({
    [ConfigurationKeys.PIN_CACHE_DURATION]: durationMs
  });
}

//#region Client ID Management >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

/**
 * Generate a random 16-byte (32 hex char) client ID.
 */
function generateClientId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Read the persisted client ID store.
 */
async function readClientIds(): Promise<ClientIdStore> {
  const data = await browser.storage.local.get(ConfigurationKeys.CLIENT_IDS);
  return (data[ConfigurationKeys.CLIENT_IDS] as ClientIdStore) ?? {};
}

/**
 * Get or create a persistent client ID for a given origin.
 * Each origin gets a unique random 32-hex-char ID, generated once and stored.
 */
export async function getOrCreateClientId(origin: string): Promise<string> {
  const store = await readClientIds();
  if (store[origin]) return store[origin];

  const id = generateClientId();
  store[origin] = id;
  await browser.storage.local.set({ [ConfigurationKeys.CLIENT_IDS]: store });
  return id;
}

/**
 * Get the client ID for an origin, or null if none exists yet.
 */
export async function getClientId(origin: string): Promise<string | null> {
  const store = await readClientIds();
  return store[origin] ?? null;
}

//#endregion Client ID Management <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<

//#region Session Token Storage >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

/** Composite key for origin-scoped token storage */
function tokenKey(relayUrl: string, origin: string): string {
  return `${relayUrl}|${origin}`;
}

/**
 * Read all stored session tokens.
 */
export async function readSessionTokens(): Promise<SessionTokenStore> {
  const data = await browser.storage.local.get(ConfigurationKeys.SESSION_TOKENS);
  return (data[ConfigurationKeys.SESSION_TOKENS] as SessionTokenStore) ?? {};
}

/**
 * Get a session token for a specific relay URL and origin.
 * Returns null if no token exists, the token is expired, or it belongs to a different origin.
 */
export async function getSessionToken(relayUrl: string, origin: string): Promise<SessionTokenEntry | null> {
  const tokens = await readSessionTokens();
  const key = tokenKey(relayUrl, origin);
  const entry = tokens[key];
  if (!entry) return null;

  // Origin isolation check
  if (entry.origin !== origin) return null;

  const now = Math.floor(Date.now() / 1000);
  if (entry.expiresAt <= now) {
    delete tokens[key];
    await browser.storage.local.set({ [ConfigurationKeys.SESSION_TOKENS]: tokens });
    return null;
  }

  return entry;
}

/**
 * Store a session token for a relay, scoped to the calling origin.
 */
export async function setSessionToken(entry: SessionTokenEntry): Promise<void> {
  const tokens = await readSessionTokens();
  const key = tokenKey(entry.relayUrl, entry.origin);
  tokens[key] = entry;
  await browser.storage.local.set({ [ConfigurationKeys.SESSION_TOKENS]: tokens });
}

/**
 * Remove a session token for a relay and origin.
 */
export async function removeSessionToken(relayUrl: string, origin: string): Promise<void> {
  const tokens = await readSessionTokens();
  const key = tokenKey(relayUrl, origin);
  delete tokens[key];
  await browser.storage.local.set({ [ConfigurationKeys.SESSION_TOKENS]: tokens });
}

/**
 * Purge all expired session tokens.
 */
export async function purgeExpiredSessionTokens(): Promise<number> {
  const tokens = await readSessionTokens();
  const now = Math.floor(Date.now() / 1000);
  let purged = 0;

  for (const key in tokens) {
    if (tokens[key].expiresAt <= now) {
      delete tokens[key];
      purged++;
    }
  }

  if (purged > 0) {
    await browser.storage.local.set({ [ConfigurationKeys.SESSION_TOKENS]: tokens });
  }
  return purged;
}

/**
 * Clear all session tokens (e.g. on browser startup or profile switch).
 */
export async function clearSessionTokens(): Promise<void> {
  await browser.storage.local.set({ [ConfigurationKeys.SESSION_TOKENS]: {} });
}

/**
 * Count active (non-expired) session tokens.
 */
export async function countActiveSessionTokens(): Promise<number> {
  const tokens = await readSessionTokens();
  const now = Math.floor(Date.now() / 1000);
  return Object.values(tokens).filter(t => t.expiresAt > now).length;
}

//#endregion Session Token Storage <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<

//#region Relay Auth Grants >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

/**
 * Read all relay auth grants.
 */
export async function readRelayAuthGrants(): Promise<RelayAuthGrants> {
  const data = await browser.storage.local.get(ConfigurationKeys.RELAY_AUTH_GRANTS);
  return (data[ConfigurationKeys.RELAY_AUTH_GRANTS] as RelayAuthGrants) ?? {};
}

/**
 * Check if a relay URL has an active auth grant.
 */
export async function hasRelayAuthGrant(relayUrl: string): Promise<RelayAuthGrant | null> {
  const grants = await readRelayAuthGrants();
  const grant = grants[relayUrl];
  if (!grant) return null;

  const now = Math.floor(Date.now() / 1000);
  if (grant.expiresAt !== null && grant.expiresAt <= now) {
    // Expired — clean it up
    delete grants[relayUrl];
    await browser.storage.local.set({ [ConfigurationKeys.RELAY_AUTH_GRANTS]: grants });
    return null;
  }

  return grant;
}

/**
 * Add a relay auth grant (auto-approve kind:22242 for this relay).
 */
export async function addRelayAuthGrant(
  relayUrl: string,
  duration: PermissionDuration
): Promise<void> {
  const grants = await readRelayAuthGrants();
  const now = Math.floor(Date.now() / 1000);

  let expiresAt: number | null = null;
  switch (duration) {
    case 'once':    expiresAt = now; break;
    case 'session': expiresAt = null; break;
    case '5m':      expiresAt = now + 5 * 60; break;
    case '30m':     expiresAt = now + 30 * 60; break;
    case '1h':      expiresAt = now + 60 * 60; break;
    case '8h':      expiresAt = now + 8 * 60 * 60; break;
    case '24h':     expiresAt = now + 24 * 60 * 60; break;
    case 'forever': expiresAt = null; break;
  }

  grants[relayUrl] = { relayUrl, grantedAt: now, expiresAt, duration };
  await browser.storage.local.set({ [ConfigurationKeys.RELAY_AUTH_GRANTS]: grants });
}

/**
 * Remove a relay auth grant.
 */
export async function removeRelayAuthGrant(relayUrl: string): Promise<void> {
  const grants = await readRelayAuthGrants();
  delete grants[relayUrl];
  await browser.storage.local.set({ [ConfigurationKeys.RELAY_AUTH_GRANTS]: grants });
}

/**
 * Clear all relay auth grants (e.g. on browser startup for session-scoped grants).
 */
export async function clearSessionRelayAuthGrants(): Promise<void> {
  const grants = await readRelayAuthGrants();
  for (const url in grants) {
    if (grants[url].duration === 'session') {
      delete grants[url];
    }
  }
  await browser.storage.local.set({ [ConfigurationKeys.RELAY_AUTH_GRANTS]: grants });
}

/**
 * Purge all expired relay auth grants.
 */
export async function purgeExpiredRelayAuthGrants(): Promise<number> {
  const grants = await readRelayAuthGrants();
  const now = Math.floor(Date.now() / 1000);
  let purged = 0;

  for (const url in grants) {
    if (grants[url].expiresAt !== null && grants[url].expiresAt <= now) {
      delete grants[url];
      purged++;
    }
  }

  if (purged > 0) {
    await browser.storage.local.set({ [ConfigurationKeys.RELAY_AUTH_GRANTS]: grants });
  }
  return purged;
}

//#endregion Relay Auth Grants <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<

/**
 * Gets the encrypted private key from storage
 */
export async function getEncryptedPrivateKey(): Promise<string | null> {
  const data = await browser.storage.local.get(ConfigurationKeys.ENCRYPTED_PRIVATE_KEY);
  return (data[ConfigurationKeys.ENCRYPTED_PRIVATE_KEY] as string) ?? null;
}

/**
 * Sets the encrypted private key in storage
 */
export async function setEncryptedPrivateKey(encryptedKey: string): Promise<void> {
  await browser.storage.local.set({
    [ConfigurationKeys.ENCRYPTED_PRIVATE_KEY]: encryptedKey
  });
}

/**
 * Enables PIN protection by encrypting all private keys
 * @param pin - The PIN to use for encryption
 */
export async function enablePinProtection(pin: string): Promise<void> {
  // Get all profiles
  const profiles = await readProfiles();
  const activePrivateKey = await readActivePrivateKey();

  if (!activePrivateKey) {
    throw new Error('No active private key to encrypt');
  }

  // Get active public key before encrypting (should already be stored, but ensure it)
  const activePublicKey = derivePublicKeyFromPrivateKey(activePrivateKey);
  await setActivePublicKey(activePublicKey);

  // Encrypt active private key
  const encryptedActiveKey = await encryptPrivateKey(pin, activePrivateKey);
  await setEncryptedPrivateKey(encryptedActiveKey);

  // Encrypt all profile private keys
  for (const pubKey in profiles) {
    const profile = profiles[pubKey];
    if (profile.privateKey) {
      profile.privateKey = await encryptPrivateKey(pin, profile.privateKey);
    }
  }
  await updateProfiles(profiles);

  // Clear plain-text private key
  await browser.storage.local.remove(ConfigurationKeys.PRIVATE_KEY);

  // Enable PIN protection
  await setPinEnabled(true);
}

/**
 * Enables PIN protection with an already encrypted key (used by background script)
 * @param pin - The PIN used for encryption
 * @param encryptedKey - The already encrypted private key
 */
export async function enablePinProtectionWithEncryptedKey(
  pin: string,
  encryptedKey: string
): Promise<void> {
  // Get all profiles
  const profiles = await readProfiles();
  const currentPrivateKey = await readActivePrivateKey();

  if (!currentPrivateKey) {
    throw new Error('No active private key found');
  }

  // Get active public key before encrypting (should already be stored, but ensure it)
  const activePublicKey = derivePublicKeyFromPrivateKey(currentPrivateKey);
  await setActivePublicKey(activePublicKey);

  // Store encrypted key
  await setEncryptedPrivateKey(encryptedKey);

  // Encrypt all profile private keys
  for (const pubKey in profiles) {
    const profile = profiles[pubKey];
    if (profile.privateKey && !isPrivateKeyEncrypted(profile.privateKey)) {
      // Encrypt profile private key
      profile.privateKey = await encryptPrivateKey(pin, profile.privateKey);
    }
  }
  await updateProfiles(profiles);

  // Clear plain-text private key
  await browser.storage.local.remove(ConfigurationKeys.PRIVATE_KEY);

  // Enable PIN protection
  await setPinEnabled(true);
}

/**
 * Gets the active public key (used when PIN protection is enabled)
 */
export async function getActivePublicKey(): Promise<string | null> {
  const data = await browser.storage.local.get(ConfigurationKeys.ACTIVE_PUBLIC_KEY);
  return (data[ConfigurationKeys.ACTIVE_PUBLIC_KEY] as string) ?? null;
}

/**
 * Sets the active public key (used when PIN protection is enabled)
 */
export async function setActivePublicKey(publicKey: string): Promise<void> {
  await browser.storage.local.set({
    [ConfigurationKeys.ACTIVE_PUBLIC_KEY]: publicKey
  });
}

/**
 * Removes the active public key
 */
export async function removeActivePublicKey(): Promise<void> {
  await browser.storage.local.remove(ConfigurationKeys.ACTIVE_PUBLIC_KEY);
}

/**
 * Disables PIN protection by decrypting all private keys
 * @param pin - The PIN to use for decryption
 */
export async function disablePinProtection(pin: string): Promise<void> {
  const encryptedKey = await getEncryptedPrivateKey();
  if (!encryptedKey) {
    throw new Error('No encrypted private key found');
  }

  // Decrypt active private key
  let decryptedActiveKey = await decryptPrivateKey(pin, encryptedKey);

  try {
    // Decrypt all profile private keys
    const profiles = await readProfiles();
    for (const pubKey in profiles) {
      const profile = profiles[pubKey];
      if (profile.privateKey) {
        try {
          profile.privateKey = await decryptPrivateKey(pin, profile.privateKey);
        } catch (error) {
          console.error(`Failed to decrypt profile ${pubKey}:`, error);
          throw new Error(`Failed to decrypt profile private key: ${error.message}`);
        }
      }
    }
    await updateProfiles(profiles);

    // Clear encrypted private key
    await browser.storage.local.remove(ConfigurationKeys.ENCRYPTED_PRIVATE_KEY);

    // Disable PIN protection BEFORE updating private key to allow plain-text storage
    await setPinEnabled(false);

    // Update active private key (this will also update active public key)
    // This must happen after disabling PIN protection to avoid the error
    await updateActivePrivateKey(decryptedActiveKey);
  } finally {
    // Clear decrypted active key reference from memory
    // Note: Strings are immutable, but we null the reference to minimize exposure
    decryptedActiveKey = clearStringReference(decryptedActiveKey) as any;
  }
}

/**
 * Gets the decrypted private key for a specific profile
 * This is used internally when PIN protection is enabled
 * @param pin - The PIN to decrypt with
 * @param publicKey - The public key of the profile (optional, defaults to active)
 */
export async function getDecryptedProfilePrivateKey(
  pin: string,
  publicKey?: string
): Promise<string> {
  const pinEnabled = await isPinEnabled();
  if (!pinEnabled) {
    // PIN not enabled, return plain key
    if (publicKey) {
      const profile = await getProfile(publicKey);
      return profile.privateKey;
    } else {
      return await readActivePrivateKey();
    }
  }

  // PIN enabled, decrypt
  if (publicKey) {
    const profile = await getProfile(publicKey);
    if (!profile.privateKey) {
      throw new Error('Profile private key not found');
    }
    return await decryptPrivateKey(pin, profile.privateKey);
  } else {
    const encryptedKey = await getEncryptedPrivateKey();
    if (!encryptedKey) {
      throw new Error('Encrypted private key not found');
    }
    return await decryptPrivateKey(pin, encryptedKey);
  }
}

//#endregion PIN Protection <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<

export async function readActiveRelays(): Promise<RelaysConfig> {
  const activeProfile = await getActiveProfile();
  return activeProfile.relays || {};
}
export async function updateRelays(
  profilePublicKey: string,
  newRelays
): Promise<ProfilesConfig | undefined> {
  if (newRelays) {
    const profile = await getProfile(profilePublicKey);
    if (!profile) {
      console.warn(`There is no profile with the key '${profilePublicKey}'`);
      return;
    }
    profile.relays = newRelays;
    return updateProfile(profile, profilePublicKey);
  }
}

export async function readActivePermissions(): Promise<PermissionConfig> {
  const activeProfile = await getActiveProfile();

  let permissions = activeProfile.permissions;
  // if no permissions defined, return empty
  if (!permissions) {
    return {};
  }

  // delete expired
  var needsUpdate = false;
  for (let host in permissions) {
    if (
      (permissions[host].condition === AuthorizationCondition.EXPIRABLE_5M &&
        permissions[host].created_at < Date.now() / 1000 - 5 * 60) ||
      (permissions[host].condition === AuthorizationCondition.EXPIRABLE_1H &&
        permissions[host].created_at < Date.now() / 1000 - 1 * 60 * 60) ||
      (permissions[host].condition === AuthorizationCondition.EXPIRABLE_8H &&
        permissions[host].created_at < Date.now() / 1000 - 8 * 60 * 60)
    ) {
      delete permissions[host];
      needsUpdate = true;
    }
  }
  if (needsUpdate) {
    // Create a new profile object with only the permissions updated
    // Preserve the private key as-is (encrypted if PIN enabled)
    const updatedProfile: ProfileConfig = {
      ...activeProfile,
      permissions
    };
    const activePublicKey = await getActivePublicKey();
    if (!activePublicKey) {
      throw new Error('Cannot update profile: active public key not found');
    }
    await updateProfile(updatedProfile, activePublicKey);
  }

  return permissions;
}
export async function addActivePermission(
  host: string,
  condition: string,
  level: number
): Promise<ProfilesConfig> {
  let storedPermissions = await readActivePermissions();

  storedPermissions = {
    ...storedPermissions,
    [host]: {
      condition,
      level,
      created_at: Math.round(Date.now() / 1000)
    }
  };

  // update the active profile
  const profile = await getActiveProfile();
  profile.permissions = storedPermissions;
  const activePublicKey = await getActivePublicKey();
  if (!activePublicKey) {
    throw new Error('Cannot update profile: active public key not found');
  }
  return updateProfile(profile, activePublicKey);
}
export async function removePermissions(
  profilePublicKey: string,
  host: string
): Promise<ProfilesConfig> {
  const profile = await getProfile(profilePublicKey);
  let permissions = profile.permissions;
  if (permissions) {
    delete permissions[host];
  }
  // update the profile
  profile.permissions = permissions;
  return updateProfile(profile, profilePublicKey);
}

//#region Profiles >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
export async function readProfiles(): Promise<ProfilesConfig> {
  const { profiles = {} } = (await browser.storage.local.get(ConfigurationKeys.PROFILES)) as {
    [ConfigurationKeys.PROFILES]: ProfilesConfig;
  };

  const pubKeys = Object.keys(profiles);
  // if there are no profiles, check if there's an active profile
  if (pubKeys.length == 0) {
    const pinEnabled = await isPinEnabled();

    if (pinEnabled) {
      // With PIN enabled, we can't decrypt without PIN, so skip initialization
      // The profile will be created when needed after PIN is entered
      return profiles;
    }

    // Without PIN, try to initialize from private key
    const privateKey = await readActivePrivateKey();
    if (privateKey) {
      // there is a private key, so I need to initialize the profiles
      const pubKey = derivePublicKeyFromPrivateKey(privateKey);
      const profile: ProfileConfig = {
        privateKey,
        relays: {},
        permissions: {}
      };

      profiles[pubKey] = profile;
      // save it (this will also store active public key via updateActivePrivateKey)
      await updateProfiles(profiles);
    }
  }

  return profiles;
}
export async function getProfile(publicKey: string): Promise<ProfileConfig> {
  const profiles = await readProfiles();
  return profiles[publicKey];
}
export async function updateProfiles(profiles: ProfilesConfig): Promise<ProfilesConfig> {
  await browser.storage.local.set({
    [ConfigurationKeys.PROFILES]: profiles
  });

  // if there's only one profile, then set it as the active one
  const activePrivateKey = await readActivePrivateKey();
  if (!activePrivateKey && Object.keys(profiles).length == 1) {
    const profilePubKey = Object.keys(profiles)[0];
    const profile = profiles[profilePubKey];
    const pinEnabled = await isPinEnabled();

    // Always store active public key first
    await setActivePublicKey(profilePubKey);

    // Then update private key based on PIN status
    if (pinEnabled) {
      // When PIN enabled, store encrypted private key if available
      if (profile.privateKey && isPrivateKeyEncrypted(profile.privateKey)) {
        await setEncryptedPrivateKey(profile.privateKey);
      }
    } else {
      // When PIN disabled, store private key
      await updateActivePrivateKey(profile.privateKey);
    }
  }

  return profiles;
}
export async function addProfile(
  profile: ProfileConfig,
  publicKey?: string
): Promise<ProfilesConfig> {
  const pinEnabled = await isPinEnabled();

  // If PIN is enabled, ensure private key is encrypted
  if (pinEnabled && profile.privateKey) {
    // Check if it's already encrypted (starts with {)
    if (!isPrivateKeyEncrypted(profile.privateKey)) {
      throw new Error(
        'Cannot add profile with plain-text private key when PIN protection is enabled'
      );
    }
  }

  const profiles = await readProfiles();

  // Derive public key: use provided publicKey, or derive from private key if not encrypted
  let profilePublicKey: string;
  if (publicKey) {
    profilePublicKey = publicKey;
  } else if (!canDerivePublicKeyFromPrivateKey(profile.privateKey, pinEnabled)) {
    // When PIN is enabled and private key is encrypted, we can't derive public key
    throw new Error('Public key must be provided when adding a profile with encrypted private key');
  } else {
    // Derive public key from plain-text private key
    profilePublicKey = derivePublicKeyFromPrivateKey(profile.privateKey);
  }

  profiles[profilePublicKey] = profile;

  await browser.storage.local.set({
    [ConfigurationKeys.PROFILES]: profiles
  });

  // if it's the first profile to be added, then set it as the active one
  const activePrivateKey = await readActivePrivateKey();
  if (!activePrivateKey && Object.keys(profiles).length == 1) {
    const profilePubKey = Object.keys(profiles)[0];

    // Always store active public key first
    await setActivePublicKey(profilePubKey);

    // Then update private key based on PIN status
    if (pinEnabled) {
      // If PIN enabled, store encrypted private key if available
      if (profile.privateKey && isPrivateKeyEncrypted(profile.privateKey)) {
        await setEncryptedPrivateKey(profile.privateKey);
      }
    } else {
      // If PIN disabled, store private key (which also ensures public key is stored)
      await updateActivePrivateKey(profile.privateKey);
    }
  }

  return profiles;
}
export async function updateProfile(
  profile: ProfileConfig,
  publicKey?: string
): Promise<ProfilesConfig> {
  const pinEnabled = await isPinEnabled();

  // If PIN is enabled, ensure private key is encrypted
  if (pinEnabled && profile.privateKey) {
    // Check if it's already encrypted (starts with {)
    if (!isPrivateKeyEncrypted(profile.privateKey)) {
      // If updating permissions/relays only, preserve the existing encrypted key from storage
      const existingProfiles = await readProfiles();
      let existingProfile: ProfileConfig | undefined;

      if (publicKey) {
        existingProfile = existingProfiles[publicKey];
      } else {
        // Try to find existing profile by matching other fields
        const activePublicKey = await getActivePublicKey();
        if (activePublicKey) {
          existingProfile = existingProfiles[activePublicKey];
        }
      }

      // If we found an existing profile with encrypted key, use it instead
      if (existingProfile?.privateKey && isPrivateKeyEncrypted(existingProfile.privateKey)) {
        profile.privateKey = existingProfile.privateKey;
      } else {
        throw new Error(
          'Cannot update profile with plain-text private key when PIN protection is enabled'
        );
      }
    }
  }

  const profiles = await readProfiles();

  // Determine which profile to update
  let profilePublicKey: string;
  if (publicKey) {
    profilePublicKey = publicKey;
  } else if (!canDerivePublicKeyFromPrivateKey(profile.privateKey, pinEnabled)) {
    // When PIN is enabled and private key is encrypted, try to find existing profile
    // by matching the encrypted private key (since we can't derive public key)
    const existingProfiles = Object.entries(profiles);
    const matchingProfile = existingProfiles.find(([_, p]) => p.privateKey === profile.privateKey);

    if (matchingProfile) {
      profilePublicKey = matchingProfile[0];
    } else if (existingProfiles.length === 1) {
      // If only one profile exists, update that one
      profilePublicKey = existingProfiles[0][0];
    } else {
      throw new Error(
        'Public key must be provided when updating a profile with encrypted private key and multiple profiles exist'
      );
    }
  } else {
    // Derive public key from plain-text private key
    profilePublicKey = derivePublicKeyFromPrivateKey(profile.privateKey);
  }

  profiles[profilePublicKey] = profile;

  await browser.storage.local.set({
    [ConfigurationKeys.PROFILES]: profiles
  });

  return profiles;
}
export async function deleteProfile(profilePublicKey: string): Promise<ProfilesConfig> {
  console.debug(`Deleting profile: ${profilePublicKey}...`);
  const profiles = await readProfiles();

  // Determine if the deleted profile was the active one
  // Always use active public key for comparison (it's always stored now)
  const activePublicKey = await getActivePublicKey();
  const isActiveProfile = activePublicKey === profilePublicKey;

  // delete from storage
  delete profiles[profilePublicKey];
  await browser.storage.local.set({
    [ConfigurationKeys.PROFILES]: profiles
  });

  // now change the active, if it was removed
  if (isActiveProfile) {
    const pinEnabled = await isPinEnabled();

    if (Object.keys(profiles).length > 0) {
      // Set the first remaining profile as active
      const newActivePublicKey = Object.keys(profiles)[0];
      const newActiveProfile = profiles[newActivePublicKey];

      // Always update active public key first
      await setActivePublicKey(newActivePublicKey);

      // Then update private key based on PIN status
      if (pinEnabled) {
        // When PIN enabled, update encrypted private key
        if (newActiveProfile.privateKey && isPrivateKeyEncrypted(newActiveProfile.privateKey)) {
          await setEncryptedPrivateKey(newActiveProfile.privateKey);
        } else {
          // No encrypted key in profile, clear encrypted key
          await browser.storage.local.remove(ConfigurationKeys.ENCRYPTED_PRIVATE_KEY);
        }
      } else {
        // When PIN disabled, update active private key
        await updateActivePrivateKey(newActiveProfile.privateKey || '');
      }
    } else {
      // No profiles left, clear active profile
      await removeActivePublicKey();
      if (pinEnabled) {
        await browser.storage.local.remove(ConfigurationKeys.ENCRYPTED_PRIVATE_KEY);
      } else {
        await updateActivePrivateKey('');
      }
    }
  }

  return profiles;
}
export async function getActiveProfile(): Promise<ProfileConfig> {
  // Always use stored active public key for consistent behavior
  let publicKey = await getActivePublicKey();

  if (!publicKey) {
    // Fallback: derive from private key if available (for migration)
    // Note: This fallback only works when PIN is disabled, as we can't derive from encrypted keys
    const privateKey = await readActivePrivateKey();
    if (privateKey) {
      publicKey = derivePublicKeyFromPrivateKey(privateKey);
      // Store it for future use
      await setActivePublicKey(publicKey);
    }

    // If still no public key, try single profile fallback
    if (!publicKey) {
      const profiles = await readProfiles();
      const profileKeys = Object.keys(profiles);
      if (profileKeys.length === 1) {
        publicKey = profileKeys[0];
        await setActivePublicKey(publicKey);
      } else {
        throw new Error('Cannot determine active profile.');
      }
    }
  }

  const profiles = await readProfiles();
  const profile = profiles[publicKey];
  if (!profile) {
    throw new Error(`Profile not found for public key: ${publicKey}`);
  }
  return profile;
}
//#endregion Profiles <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<

export async function readOpenPrompts(): Promise<OpenPromptItem[]> {
  const openPromptsData = await browser.storage.local.get(ConfigurationKeys.OPEN_PROMPTS);
  // parse from JSON string
  const openPromptStr = (openPromptsData[ConfigurationKeys.OPEN_PROMPTS] ?? '[]') as string;
  return JSON.parse(openPromptStr) as OpenPromptItem[];
}

export async function updateOpenPrompts(openPrompts: OpenPromptItem[]) {
  // stringify to JSON to make the change listeners fire (Firefox bug?)
  const openPromptsStr = JSON.stringify(openPrompts);
  await browser.storage.local.set({
    [ConfigurationKeys.OPEN_PROMPTS]: openPromptsStr
  });

  return openPrompts;
}

export function addOpenPromptChangeListener(callback: (newOpenPrompts: OpenPromptItem[]) => void) {
  return browser.storage.onChanged.addListener(changes => {
    // only notify if there's a change with Open Prompts
    if (changes[ConfigurationKeys.OPEN_PROMPTS]) {
      const newValueStr = (changes[ConfigurationKeys.OPEN_PROMPTS].newValue ?? '[]') as string;
      callback(JSON.parse(newValueStr) as OpenPromptItem[]);
    }
  });
}
export function removeOpenPromptChangeListener(listener) {
  return browser.storage.onChanged.removeListener(listener);
}

/**
 * Clear the entire configuration
 * @returns
 */
export async function empty(): Promise<void> {
  return await browser.storage.local.clear();
}

async function clearUnused(): Promise<void> {
  return await browser.storage.local.remove([
    'relays', // no longer used
    'permissions' // no longer used
  ]);
}

// clear unused
clearUnused()
  .then(() => console.debug('Storage cleared from unused.'))
  .catch(error => console.warn('There was a problem clearing the storage from unused.', error));

//#region Site Permissions (new granular model) >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

/**
 * Read all site permissions.
 */
export async function readSitePermissions(): Promise<SitePermissions> {
  const data = await browser.storage.local.get(ConfigurationKeys.SITE_PERMISSIONS);
  return (data[ConfigurationKeys.SITE_PERMISSIONS] as SitePermissions) ?? {};
}

/**
 * Write all site permissions.
 */
export async function writeSitePermissions(perms: SitePermissions): Promise<void> {
  await browser.storage.local.set({
    [ConfigurationKeys.SITE_PERMISSIONS]: perms,
  });
}

/**
 * Get or create a SitePermission record for a host.
 * Increments request_count and updates last_active.
 */
export async function touchSite(host: string): Promise<SitePermission> {
  const perms = await readSitePermissions();
  const now = Math.floor(Date.now() / 1000);

  if (!perms[host]) {
    perms[host] = {
      host,
      first_seen: now,
      last_active: now,
      request_count: 1,
      denied_count: 0,
      grants: [],
    };
  } else {
    perms[host].last_active = now;
    perms[host].request_count++;
  }

  await writeSitePermissions(perms);
  return perms[host];
}

/**
 * Increment the denied count for a host.
 */
export async function incrementDenied(host: string): Promise<void> {
  const perms = await readSitePermissions();
  if (perms[host]) {
    perms[host].denied_count++;
    await writeSitePermissions(perms);
  }
}

/**
 * Get the SitePermission for a host (without touching it).
 */
export async function getSitePermission(host: string): Promise<SitePermission | null> {
  const perms = await readSitePermissions();
  return perms[host] ?? null;
}

/**
 * Check if a host has an active (non-expired) grant for a capability.
 * For signEvent grants with allowedKinds, also checks the event kind.
 */
export async function hasActiveGrant(
  host: string,
  capability: Capability,
  eventKind?: number
): Promise<CapabilityGrant | null> {
  const perms = await readSitePermissions();
  const site = perms[host];
  if (!site) return null;

  const now = Math.floor(Date.now() / 1000);

  for (const grant of site.grants) {
    if (grant.capability !== capability) continue;

    // Check expiry
    if (grant.expires_at !== null && grant.expires_at <= now) continue;

    // For signEvent: check kind allowlist
    if (capability === 'signEvent' && grant.allowedKinds && grant.allowedKinds.length > 0) {
      if (eventKind !== undefined && !grant.allowedKinds.includes(eventKind)) continue;
    }

    return grant;
  }

  return null;
}

/**
 * Add a capability grant for a host.
 */
export async function addGrant(
  host: string,
  capability: Capability,
  duration: PermissionDuration,
  allowedKinds?: number[]
): Promise<void> {
  const perms = await readSitePermissions();
  const now = Math.floor(Date.now() / 1000);

  if (!perms[host]) {
    perms[host] = {
      host,
      first_seen: now,
      last_active: now,
      request_count: 0,
      denied_count: 0,
      grants: [],
    };
  }

  // Calculate expiry
  let expires_at: number | null = null;
  switch (duration) {
    case 'once':    expires_at = now; break; // will be consumed immediately
    case 'session': expires_at = null; break; // cleared on restart
    case '5m':      expires_at = now + 5 * 60; break;
    case '30m':     expires_at = now + 30 * 60; break;
    case '1h':      expires_at = now + 60 * 60; break;
    case '8h':      expires_at = now + 8 * 60 * 60; break;
    case '24h':     expires_at = now + 24 * 60 * 60; break;
    case 'forever': expires_at = null; break;
  }

  const grant: CapabilityGrant = {
    capability,
    granted_at: now,
    expires_at,
    duration,
    allowedKinds,
  };

  // Remove any existing grant for same capability (replace)
  perms[host].grants = perms[host].grants.filter(g => g.capability !== capability);
  perms[host].grants.push(grant);

  await writeSitePermissions(perms);
}

/**
 * Consume a one-time grant (remove it after use).
 */
export async function consumeOnceGrant(host: string, capability: Capability): Promise<void> {
  const perms = await readSitePermissions();
  const site = perms[host];
  if (!site) return;

  site.grants = site.grants.filter(
    g => !(g.capability === capability && g.duration === 'once')
  );
  await writeSitePermissions(perms);
}

/**
 * Revoke a specific capability grant for a host.
 */
export async function revokeGrant(host: string, capability: Capability): Promise<void> {
  const perms = await readSitePermissions();
  const site = perms[host];
  if (!site) return;

  site.grants = site.grants.filter(g => g.capability !== capability);
  await writeSitePermissions(perms);
}

/**
 * Revoke ALL grants for a host.
 */
export async function revokeAllGrants(host: string): Promise<void> {
  const perms = await readSitePermissions();
  const site = perms[host];
  if (!site) return;

  site.grants = [];
  await writeSitePermissions(perms);
}

/**
 * Remove a site entirely from the permissions store.
 */
export async function removeSite(host: string): Promise<void> {
  const perms = await readSitePermissions();
  delete perms[host];
  await writeSitePermissions(perms);
}

/**
 * Purge all expired grants across all sites.
 */
export async function purgeExpiredGrants(): Promise<number> {
  const perms = await readSitePermissions();
  const now = Math.floor(Date.now() / 1000);
  let purged = 0;

  for (const host in perms) {
    const before = perms[host].grants.length;
    perms[host].grants = perms[host].grants.filter(
      g => g.expires_at === null || g.expires_at > now
    );
    purged += before - perms[host].grants.length;
  }

  if (purged > 0) {
    await writeSitePermissions(perms);
  }
  return purged;
}

/**
 * Clear all session-scoped grants (called on browser startup).
 */
export async function clearSessionGrants(): Promise<void> {
  const perms = await readSitePermissions();
  for (const host in perms) {
    perms[host].grants = perms[host].grants.filter(g => g.duration !== 'session');
  }
  await writeSitePermissions(perms);
}

/**
 * Get the list of active (non-expired) capabilities for a host.
 */
export async function getActiveCapabilities(host: string): Promise<Capability[]> {
  const perms = await readSitePermissions();
  const site = perms[host];
  if (!site) return [];

  const now = Math.floor(Date.now() / 1000);
  return site.grants
    .filter(g => g.expires_at === null || g.expires_at > now)
    .map(g => g.capability);
}

//#endregion Site Permissions <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<

//#region Security Preferences >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

/**
 * Read security preferences.
 */
export async function readSecurityPreferences(): Promise<SecurityPreferences> {
  const data = await browser.storage.local.get(ConfigurationKeys.SECURITY_PREFERENCES);
  const stored = data[ConfigurationKeys.SECURITY_PREFERENCES] as Partial<SecurityPreferences> | undefined;
  return { ...DEFAULT_SECURITY_PREFERENCES, ...stored };
}

/**
 * Write security preferences.
 */
export async function writeSecurityPreferences(prefs: SecurityPreferences): Promise<void> {
  await browser.storage.local.set({
    [ConfigurationKeys.SECURITY_PREFERENCES]: prefs,
  });
}

/**
 * Update a single security preference.
 */
export async function updateSecurityPreference<K extends keyof SecurityPreferences>(
  key: K,
  value: SecurityPreferences[K]
): Promise<void> {
  const prefs = await readSecurityPreferences();
  prefs[key] = value;
  await writeSecurityPreferences(prefs);
}

//#endregion Security Preferences <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<

//#region Legacy Permission Migration >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

/**
 * Migrate old numeric-level permissions to the new granular model.
 * Called once on startup if old permissions exist.
 */
export async function migrateOldPermissions(): Promise<boolean> {
  const profiles = await readProfiles();
  let migrated = false;

  for (const pubKey in profiles) {
    const profile = profiles[pubKey];
    if (!profile.permissions || Object.keys(profile.permissions).length === 0) continue;

    for (const [host, perm] of Object.entries(profile.permissions)) {
      // Map old numeric levels to capabilities
      const capabilities: Capability[] = [];
      if (perm.level >= 1) capabilities.push('getPublicKey');
      if (perm.level >= 5) capabilities.push('getRelays');
      if (perm.level >= 10) capabilities.push('signEvent');
      if (perm.level >= 20) {
        capabilities.push('nip04.encrypt', 'nip04.decrypt', 'nip44.encrypt', 'nip44.decrypt');
      }

      // Map old condition to duration
      let duration: PermissionDuration = PermissionDuration.FOREVER;
      if (perm.condition === 'expirable_5m') duration = PermissionDuration.MINUTES_5;
      else if (perm.condition === 'expirable_1h') duration = PermissionDuration.HOURS_1;
      else if (perm.condition === 'expirable_8h') duration = PermissionDuration.HOURS_8;
      else if (perm.condition === 'single') duration = PermissionDuration.ONCE;

      // Create grants
      for (const cap of capabilities) {
        await addGrant(host, cap, duration);
      }

      migrated = true;
    }

    // Clear old permissions from profile
    delete profile.permissions;
  }

  if (migrated) {
    await updateProfiles(profiles);
    console.log('[Migration] Old permissions migrated to new granular model.');
  }

  return migrated;
}

//#endregion Legacy Permission Migration <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<
