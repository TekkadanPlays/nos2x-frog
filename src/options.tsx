import { createElement } from 'inferno-create-element';
import { Component, render } from 'inferno';
import browser from 'webextension-polyfill';
import { getPublicKey, generateSecretKey, nip19 } from 'nostr-tools';
import { format, formatDistance } from 'date-fns';

import { Alert, Modal } from './components';

import {
  type ProfileConfig,
  type ProfilesConfig,
  type RelaysConfig,
  type SitePermissions,
  type SitePermission,
  type AuditLogEntry,
  type Capability,
  CAPABILITY_INFO,
} from './types';
import * as Storage from './storage';
import {
  convertHexToUint8Array,
  convertUint8ArrayToHex,
  isHexadecimal,
  isValidRelayURL,
  truncatePublicKeys,
  isPrivateKeyEncrypted,
  derivePublicKeyFromPrivateKey,
  canDerivePublicKeyFromPrivateKey,
  formatPrivateKeyForDisplay,
  validatePrivateKeyFormat
} from './common';
import AddCircleIcon from './assets/icons/add-circle-outline.svg';
import ArrowUpCircleIcon from './assets/icons/arrow-up-circle-outline.svg';
import CopyIcon from './assets/icons/copy-outline.svg';
import DiceIcon from './assets/icons/dice-outline.svg';
import EyeIcon from './assets/icons/eye-outline.svg';
import EyeOffIcon from './assets/icons/eye-off-outline.svg';
import DownloadIcon from './assets/icons/download-outline.svg';
import PencilIcon from './assets/icons/pencil-outline.svg';
import RadioIcon from './assets/icons/radio-outline.svg';
import TrashIcon from './assets/icons/trash-outline.svg';
import WarningIcon from './assets/icons/warning-outline.svg';

type RelayConfig = {
  url: string;
  policy: { read: boolean; write: boolean };
};

/** Simple debounce helper to replace use-debounce */
function debounce<T extends (...args: any[]) => any>(fn: T, ms: number): T {
  let timer: any;
  return ((...args: any[]) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as any;
}

type OptionsSection = 'profiles' | 'security' | 'relays' | 'permissions' | 'danger';

interface OptionsState {
  activeSection: OptionsSection;
  selectedProfilePubKey: string;
  profiles: ProfilesConfig;
  isLoadingProfile: boolean;
  isCreatingProfile: boolean;
  newProfileName: string;
  newProfileKey: string;
  profileExportJson: string;
  profileImportJson: string;
  isExportModalShown: boolean;
  isImportModalShown: boolean;
  editingName: string;
  privateKey: string;
  isKeyHidden: boolean;
  relays: RelayConfig[];
  newRelayURL: string;
  isNewRelayURLValid: boolean;
  sitePermissions: SitePermissions;
  expandedSiteHost: string | null;
  siteAuditEntries: AuditLogEntry[];
  message: string;
  messageType: string;
  version: string;
  pinEnabled: boolean;
  pinCacheDuration: number;
  relayAuthGrants: any;
  sessionTokenCount: number;
}

class Options extends Component<{}, OptionsState> {
  state: OptionsState = {
    activeSection: 'profiles',
    selectedProfilePubKey: '',
    profiles: {},
    isLoadingProfile: false,
    isCreatingProfile: false,
    newProfileName: '',
    newProfileKey: '',
    profileExportJson: '',
    profileImportJson: '',
    isExportModalShown: false,
    isImportModalShown: false,
    editingName: '',
    privateKey: '',
    isKeyHidden: true,
    relays: [],
    newRelayURL: '',
    isNewRelayURLValid: true,
    sitePermissions: {},
    expandedSiteHost: null,
    siteAuditEntries: [],
    message: '',
    messageType: 'info',
    version: '0.0.0',
    pinEnabled: false,
    pinCacheDuration: 10 * 1000,
    relayAuthGrants: {},
    sessionTokenCount: 0,
  };

  private messageTimer: any = null;
  private relaysSaveDebounced = debounce(() => this.saveRelaysInStorage(), 700);

  componentDidMount() {
    // Load profiles
    Storage.readProfiles().then(profiles => {
      if (profiles) {
        const keys = Object.keys(profiles);
        const selectedPubKey = keys.length > 0 ? keys[0] : '';
        this.setState({ profiles, selectedProfilePubKey: selectedPubKey }, () => {
          if (selectedPubKey) this.loadAndSelectProfile(selectedPubKey);
        });
      }
    });

    // Load version
    fetch('./manifest.json')
      .then(response => response.json())
      .then(json => this.setState({ version: json.version }));

    // Check PIN protection status
    Storage.isPinEnabled().then(enabled => this.setState({ pinEnabled: enabled }));
    Storage.getPinCacheDuration().then(duration => this.setState({ pinCacheDuration: duration }));
    Storage.readRelayAuthGrants().then(grants => this.setState({ relayAuthGrants: grants }));
    Storage.readSessionTokens().then(tokens => this.setState({ sessionTokenCount: Object.keys(tokens).length }));

    // Load site permissions (global, not per-profile)
    Storage.readSitePermissions().then(perms => this.setState({ sitePermissions: perms }));
  }

  showMessage = (msg: string, type: string = 'info', timeout: number = 3000) => {
    if (this.messageTimer) clearTimeout(this.messageTimer);
    this.setState({ messageType: type, message: msg });
    if (timeout > 0) {
      this.messageTimer = setTimeout(() => this.setState({ message: '' }), timeout);
    }
  };

  //#region Profiles

  /**
   * Select and load a profile's data into the editing fields.
   * All state updates are batched into a single setState call.
   */
  async loadAndSelectProfile(pubKey: string) {
    const profile: ProfileConfig = this.state.profiles[pubKey];
    if (!profile) {
      console.warn(`[profiles] pubkey '${pubKey}' not found — ignoring.`);
      return;
    }
    this.setState({ isLoadingProfile: true });
    const currentPinEnabled = await Storage.isPinEnabled();
    this.setState({
      selectedProfilePubKey: pubKey,
      editingName: profile.name || '',
      relays: this.convertRelaysToUIArray(profile.relays),
      pinEnabled: currentPinEnabled,
      privateKey: formatPrivateKeyForDisplay(profile.privateKey || '', currentPinEnabled),
      isKeyHidden: true,
      isLoadingProfile: false,
      isCreatingProfile: false,
    });
  }

  reloadSelectedProfile = () => {
    this.loadAndSelectProfile(this.state.selectedProfilePubKey);
  };

  /** Select a different profile pill. */
  handleSelectProfile = (pubKey: string) => {
    if (pubKey === this.state.selectedProfilePubKey && !this.state.isCreatingProfile) return;
    this.loadAndSelectProfile(pubKey);
  };

  /** Enter new-profile creation mode (no sentinel key in profiles). */
  handleNewProfileClick = () => {
    this.setState({
      isCreatingProfile: true,
      newProfileName: '',
      newProfileKey: '',
      privateKey: '',
      isKeyHidden: true,
    });
  };

  /** Cancel new-profile creation and return to the selected profile. */
  handleCancelNewProfile = () => {
    const { selectedProfilePubKey } = this.state;
    this.setState({ isCreatingProfile: false, newProfileName: '', newProfileKey: '' });
    if (selectedProfilePubKey) this.loadAndSelectProfile(selectedProfilePubKey);
  };

  getSelectedProfile = (): ProfileConfig | null => {
    const { selectedProfilePubKey, profiles } = this.state;
    return (selectedProfilePubKey && selectedProfilePubKey in profiles)
      ? profiles[selectedProfilePubKey]
      : null;
  };

  /** Inline name editing — update local state only. */
  handleEditingNameChange = (e: any) => {
    this.setState({ editingName: e.target.value });
  };

  /** Persist name on blur (immutable update). */
  handleEditingNameBlur = async () => {
    const { editingName, selectedProfilePubKey, profiles } = this.state;
    const profile = profiles[selectedProfilePubKey];
    if (!profile) return;
    const newName = editingName.trim() || undefined;
    if (newName === profile.name) return;
    const updatedProfile = { ...profile, name: newName };
    const updatedProfiles = { ...profiles, [selectedProfilePubKey]: updatedProfile };
    this.setState({ profiles: updatedProfiles });
    await Storage.updateProfile(updatedProfile, selectedProfilePubKey);
  };

  handleEditingNameKeyDown = (e: any) => {
    if (e.key === 'Enter') e.target.blur();
    if (e.key === 'Escape') {
      const profile = this.getSelectedProfile();
      this.setState({ editingName: profile?.name || '' });
      e.target.blur();
    }
  };

  handleExportProfileClick = () => {
    const profile = this.getSelectedProfile();
    if (!profile) return;
    this.setState({ profileExportJson: JSON.stringify(profile), isExportModalShown: true });
  };

  handleExportProfileCopyClick = () => {
    navigator.clipboard.writeText(this.state.profileExportJson);
    this.showMessage('Copied!', 'success');
  };

  handleExportModalClose = () => { this.setState({ isExportModalShown: false }); };

  handleImportProfileClick = () => { this.setState({ profileImportJson: '', isImportModalShown: true }); };

  handleChangeProfileImportJson = (e: any) => {
    this.setState({ profileImportJson: e.target.value });
  };

  handleImportProfileImportClick = async () => {
    let newProfile: ProfileConfig;
    try {
      newProfile = JSON.parse(this.state.profileImportJson);
    } catch (error: any) {
      this.showMessage(`Invalid JSON: ${error?.message}`, 'warning');
      return;
    }
    if (!newProfile || !newProfile.privateKey) {
      this.showMessage('Imported profile must contain a privateKey.', 'warning');
      return;
    }

    const pinEnabled = await Storage.isPinEnabled();
    let newPubKey: string;

    if (!canDerivePublicKeyFromPrivateKey(newProfile.privateKey, pinEnabled)) {
      const existingProfiles = await Storage.readProfiles();
      const matchingProfile = Object.entries(existingProfiles).find(
        ([_, p]) => p.privateKey === newProfile.privateKey
      );
      if (matchingProfile) {
        newPubKey = matchingProfile[0];
      } else {
        this.showMessage(
          'Cannot import encrypted key without a matching profile. Decrypt first.',
          'warning'
        );
        return;
      }
    } else {
      newPubKey = derivePublicKeyFromPrivateKey(newProfile.privateKey);
    }

    await Storage.addProfile(newProfile, newPubKey);
    const updatedProfiles = { ...this.state.profiles, [newPubKey]: newProfile };
    this.setState({
      profiles: updatedProfiles,
      isImportModalShown: false,
      isCreatingProfile: false,
    }, () => this.loadAndSelectProfile(newPubKey));
    this.showMessage('Profile imported!', 'success');
  };

  handleImportModalClose = () => { this.setState({ isImportModalShown: false }); };

  handleDeleteProfileClick = async (e: any) => {
    e.preventDefault();
    const { selectedProfilePubKey, profiles } = this.state;
    if (!selectedProfilePubKey || !(selectedProfilePubKey in profiles)) return;
    const npub = nip19.npubEncode(selectedProfilePubKey);
    const name = profiles[selectedProfilePubKey].name;
    if (!window.confirm(`Delete "${name || npub}"? This cannot be undone.`)) return;

    await Storage.deleteProfile(selectedProfilePubKey);
    const updatedProfiles = { ...profiles };
    delete updatedProfiles[selectedProfilePubKey];
    const remainingKeys = Object.keys(updatedProfiles);
    const nextPubKey = remainingKeys.length > 0 ? remainingKeys[0] : '';
    this.setState({ profiles: updatedProfiles, selectedProfilePubKey: nextPubKey }, () => {
      if (nextPubKey) this.loadAndSelectProfile(nextPubKey);
    });
    this.showMessage('Profile deleted.', 'info');
  };

  //#endregion Profiles

  //#region Private key

  /**
   * Save a new profile (from the creation flow).
   * Builds a fresh profiles clone — never mutates state in place.
   */
  saveNewProfile = async () => {
    const { newProfileKey, newProfileName, profiles } = this.state;
    if (!newProfileKey) {
      this.showMessage('Enter or generate a private key first.', 'warning');
      return;
    }
    if (!validatePrivateKeyFormat(newProfileKey)) {
      this.showMessage('Invalid key format. Use nsec1... or 64-char hex.', 'warning');
      return;
    }

    try {
      let privateKeyIntArray: Uint8Array | undefined;
      if (isHexadecimal(newProfileKey)) {
        privateKeyIntArray = convertHexToUint8Array(newProfileKey);
      } else {
        const { type, data } = nip19.decode(newProfileKey);
        if (type === 'nsec') privateKeyIntArray = data as Uint8Array;
      }
      if (!privateKeyIntArray) {
        this.showMessage('Could not parse private key.', 'warning');
        return;
      }

      const hexPrivateKey = convertUint8ArrayToHex(privateKeyIntArray);
      const newPubKey = derivePublicKeyFromPrivateKey(hexPrivateKey);

      if (newPubKey in profiles) {
        this.showMessage('A profile with this key already exists.', 'warning');
        return;
      }

      const newProfile: ProfileConfig = { privateKey: '' };
      const trimmedName = newProfileName.trim();
      if (trimmedName) newProfile.name = trimmedName;

      const pinEnabled = await Storage.isPinEnabled();
      if (pinEnabled) {
        const resp: any = await browser.runtime.sendMessage({
          type: 'encryptPrivateKey',
          privateKey: hexPrivateKey,
        });
        if (!resp?.success || !resp?.encryptedKey) {
          this.showMessage(resp?.error || 'PIN encryption failed.', 'warning');
          return;
        }
        newProfile.privateKey = resp.encryptedKey;
      } else {
        newProfile.privateKey = hexPrivateKey;
      }

      const updatedProfiles = { ...profiles, [newPubKey]: newProfile };
      try {
        await Storage.updateProfiles(updatedProfiles);
      } catch (storageErr: any) {
        if (storageErr?.message?.includes('uota')) {
          // Quota exceeded — surgical clear: save essentials, nuke storage, restore + new profile
          console.warn('[profiles] Quota exceeded — clearing non-essential storage and retrying');
          const keysToKeep = [
            'private_key', 'profiles', 'pin_enabled', 'encrypted_private_key',
            'active_public_key', 'pin_cache_duration',
            'session_tokens', 'relay_auth_grants',
            'site_permissions', 'security_preferences',
          ];
          const essentials = await browser.storage.local.get(keysToKeep);
          await browser.storage.local.clear();
          const toRestore: Record<string, any> = {};
          for (const [k, v] of Object.entries(essentials)) {
            if (v !== undefined && v !== null) toRestore[k] = v;
          }
          if (Object.keys(toRestore).length > 0) {
            await browser.storage.local.set(toRestore);
          }
          await Storage.updateProfiles(updatedProfiles);
        } else {
          throw storageErr;
        }
      }
      this.setState({ profiles: updatedProfiles, isCreatingProfile: false }, () => {
        this.loadAndSelectProfile(newPubKey);
      });
      this.showMessage('Profile saved!', 'success');
    } catch (error: any) {
      console.error('[profiles] saveNewProfile error:', error);
      this.showMessage('Save failed: ' + (error?.message || 'unknown error'), 'warning');
    }
  };

  isNewKeyValid = () => {
    const key = this.state.newProfileKey;
    return key !== '' && validatePrivateKeyFormat(key);
  };

  handlePrivateKeyChange = (e: any) => {
    this.setState({ privateKey: e.target.value.toLowerCase().trim() });
  };

  generateRandomPrivateKey = () => {
    const key = nip19.nsecEncode(generateSecretKey());
    // Target the correct field depending on whether we're creating or viewing
    if (this.state.isCreatingProfile) {
      this.setState({ newProfileKey: key });
    } else {
      this.setState({ privateKey: key });
    }
  };

  handlePrivateKeyShowClick = () => {
    this.setState({ isKeyHidden: !this.state.isKeyHidden });
  };

  handleProtectWithPinClick = async () => {
    const mode = this.state.pinEnabled ? 'disable' : 'setup';
    try {
      await browser.runtime.sendMessage({ type: 'openPinPrompt', mode });
      setTimeout(async () => {
        const enabled = await Storage.isPinEnabled();
        this.setState({ pinEnabled: enabled });
      }, 1000);
    } catch (error) {
      console.error('Error opening PIN prompt:', error);
    }
  };

  handlePinCacheDurationChange = async (e: any) => {
    const duration = parseInt(e.target.value, 10);
    this.setState({ pinCacheDuration: duration });
    await Storage.setPinCacheDuration(duration);
    this.showMessage('PIN cache duration updated', 'success');
  };

  handleClearSessionTokens = async () => {
    await Storage.clearSessionTokens();
    this.setState({ sessionTokenCount: 0 });
    this.showMessage('All session tokens cleared. You will need to re-authenticate with relays.', 'info');
  };

  handleRemoveRelayAuthGrant = async (relayUrl: string) => {
    await Storage.removeRelayAuthGrant(relayUrl);
    const grants = await Storage.readRelayAuthGrants();
    this.setState({ relayAuthGrants: grants });
    this.showMessage(`Auth grant removed for ${relayUrl}`, 'info');
  };

  //#endregion Private key

  //#region Site Permissions

  reloadSitePermissions = async () => {
    const perms = await Storage.readSitePermissions();
    this.setState({ sitePermissions: perms });
  };

  handleRevokeGrant = async (host: string, capability: Capability) => {
    await Storage.revokeGrant(host, capability);
    this.showMessage(`Revoked ${CAPABILITY_INFO[capability]?.label || capability} from ${host}`);
    this.reloadSitePermissions();
  };

  handleRevokeAllGrants = async (host: string) => {
    if (window.confirm(`Revoke all permissions from ${host}?`)) {
      await Storage.revokeAllGrants(host);
      this.showMessage(`Revoked all permissions from ${host}`);
      this.reloadSitePermissions();
    }
  };

  handleRemoveSite = async (host: string) => {
    if (window.confirm(`Remove ${host} from known sites?`)) {
      await Storage.removeSite(host);
      this.showMessage(`Removed ${host}`);
      this.setState({ expandedSiteHost: null, siteAuditEntries: [] });
      this.reloadSitePermissions();
    }
  };

  handleExpandSite = async (host: string) => {
    if (this.state.expandedSiteHost === host) {
      this.setState({ expandedSiteHost: null, siteAuditEntries: [] });
      return;
    }
    try {
      const r: any = await browser.runtime.sendMessage({ type: 'getActivityLogByHost', host });
      this.setState({ expandedSiteHost: host, siteAuditEntries: r?.entries || [] });
    } catch {
      this.setState({ expandedSiteHost: host, siteAuditEntries: [] });
    }
  };

  //#endregion Site Permissions

  //#region Relays

  convertRelaysToUIArray(relays?: RelaysConfig): RelayConfig[] {
    if (!relays) return [];
    let relaysList: RelayConfig[] = [];
    for (let url in relays) {
      relaysList.push({ url, policy: relays[url] });
    }
    return relaysList;
  }

  saveRelaysInStorage = async () => {
    const { selectedProfilePubKey, relays } = this.state;
    if (selectedProfilePubKey) {
      let relaysToSave = {};
      if (relays && relays.length) {
        relaysToSave = Object.fromEntries(
          relays
            .filter(({ url }) => url.trim() !== '')
            .map(({ url, policy }) => [url.trim(), policy])
        );
      }
      console.debug('Relays to save', relaysToSave);
      await Storage.updateRelays(selectedProfilePubKey, relaysToSave);
      this.showMessage('Saved relays!', 'success');
    }
  };

  setRelaysAndSave = (newRelays: RelayConfig[]) => {
    this.setState({ relays: newRelays }, () => {
      if (!this.state.isLoadingProfile) {
        this.relaysSaveDebounced();
      }
    });
  };

  handleChangeRelayURL = (i: number, ev: any) => {
    const { relays } = this.state;
    this.setRelaysAndSave([
      ...relays.slice(0, i),
      { url: ev.target.value, policy: relays[i].policy },
      ...relays.slice(i + 1)
    ]);
  };

  handleToggleRelayPolicy = (i: number, cat: string) => {
    const { relays } = this.state;
    this.setRelaysAndSave([
      ...relays.slice(0, i),
      { url: relays[i].url, policy: { ...relays[i].policy, [cat]: !(relays[i].policy as any)[cat] } },
      ...relays.slice(i + 1)
    ]);
  };

  handleNewRelayURLChange = (e: any) => {
    this.setState({ newRelayURL: e.target.value });
    if (!isValidRelayURL(e.target.value)) {
      this.setState({ isNewRelayURLValid: false });
    }
  };

  handleAddRelayClick = () => {
    if (!this.isRelayURLValid()) return;
    const { relays, newRelayURL } = this.state;
    this.setState({ isNewRelayURLValid: true, newRelayURL: '' });
    this.setRelaysAndSave([...relays, { url: newRelayURL, policy: { read: true, write: true } }]);
  };

  handleRemoveRelayClick = (event: any) => {
    const relayUrl = event.currentTarget.id;
    this.setRelaysAndSave(this.state.relays.filter(relay => relay.url != relayUrl));
  };

  isRelayURLValid = (url?: string) => {
    return isValidRelayURL(url ? url : this.state.newRelayURL);
  };

  //#endregion Relays

  handleClearStorageClick = async () => {
    if (confirm('Are you sure you want to delete everything from this browser?')) {
      await Storage.empty();
      window.location.reload();
    }
  };

  setSection = (s: OptionsSection) => { this.setState({ activeSection: s }); };

  renderSidebar() {
    const { activeSection, version } = this.state;
    const items: { id: OptionsSection; label: string }[] = [
      { id: 'profiles',    label: 'Profiles' },
      { id: 'security',    label: 'Security' },
      { id: 'relays',      label: 'Relays' },
      { id: 'permissions', label: 'Permissions' },
      { id: 'danger',      label: 'Danger Zone' },
    ];
    return (
      <aside className="opts-sidebar">
        <div className="opts-sidebar-logo">
          <span className="opts-logo-icon">{'\u{1F438}'}</span>
          <span className="opts-logo-name">nos2x-frog</span>
        </div>
        <nav className="opts-nav">
          {items.map(it => (
            <button
              key={it.id}
              className={`opts-nav-item${activeSection === it.id ? ' opts-nav-active' : ''}${it.id === 'danger' ? ' opts-nav-danger' : ''}`}
              onClick={() => this.setSection(it.id)}
            >
              {it.label}
            </button>
          ))}
        </nav>
        <div className="opts-sidebar-footer">v{version}</div>
      </aside>
    );
  }

  renderContent() {
    const { activeSection } = this.state;
    switch (activeSection) {
      case 'profiles':    return this.renderProfilesSection();
      case 'security':    return this.renderSecuritySection();
      case 'relays':      return this.renderRelaysSection();
      case 'permissions': return this.renderPermissionsSection();
      case 'danger':      return this.renderDangerSection();
    }
  }

  renderProfilesSection() {
    const {
      selectedProfilePubKey, profiles, isCreatingProfile,
      editingName, privateKey, isKeyHidden,
      newProfileName, newProfileKey,
    } = this.state;
    const profileKeys = Object.keys(profiles);
    const isExisting = selectedProfilePubKey !== '' && selectedProfilePubKey in profiles;
    const selectedNpub = isExisting ? nip19.npubEncode(selectedProfilePubKey) : '';

    return (
      <div className="opts-section">
        <div className="prof-header">
          <div>
            <h2 className="opts-section-title">Profiles</h2>
            <p className="opts-section-desc">Signing identities. Each profile has its own key, relays, and permissions.</p>
          </div>
          {!isCreatingProfile && (
            <button className="prof-add-btn" onClick={this.handleNewProfileClick}>
              <AddCircleIcon /> New
            </button>
          )}
        </div>

        {/* Profile selector — compact horizontal pills */}
        {profileKeys.length > 0 && (
          <div className="prof-selector">
            {profileKeys.map(pk => {
              const p = profiles[pk];
              const active = pk === selectedProfilePubKey && !isCreatingProfile;
              return (
                <button
                  key={pk}
                  className={`prof-pill${active ? ' prof-pill-active' : ''}`}
                  onClick={() => this.handleSelectProfile(pk)}
                >
                  <span className={`prof-pill-dot${active ? ' prof-pill-dot-active' : ''}`} />
                  <span className="prof-pill-name">{p.name || 'Unnamed'}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* New profile creation flow */}
        {isCreatingProfile && (
          <div className="card prof-detail-card">
            <div className="card-body">
              <div className="prof-detail-header">
                <span className="prof-detail-badge">New Profile</span>
              </div>
              <div className="form-control">
                <span className="form-label">Profile name</span>
                <input
                  type="text"
                  value={newProfileName}
                  onInput={(e: any) => this.setState({ newProfileName: e.target.value })}
                  placeholder="e.g. Main, Work, Burner..."
                />
                <span className="form-hint">Optional. You can change this later.</span>
              </div>
              <div className="form-control">
                <span className="form-label">Private key</span>
                <div className="input-group">
                  <input
                    id="new-profile-key"
                    type={isKeyHidden ? 'password' : 'text'}
                    value={newProfileKey}
                    onInput={(e: any) => this.setState({ newProfileKey: e.target.value.toLowerCase().trim() })}
                    placeholder="nsec1... or hex"
                  />
                  <button onClick={this.handlePrivateKeyShowClick} title={isKeyHidden ? 'Show' : 'Hide'}>
                    {isKeyHidden ? <EyeIcon /> : <EyeOffIcon />}
                  </button>
                </div>
                <span className="form-hint">Paste an existing key or generate a new one.</span>
              </div>
              <div className="prof-detail-actions">
                <button onClick={this.generateRandomPrivateKey}>
                  <DiceIcon /> Generate
                </button>
                <button onClick={this.handleImportProfileClick}>
                  <ArrowUpCircleIcon /> Import
                </button>
                <span className="opts-toolbar-spacer" />
                <button onClick={this.handleCancelNewProfile}>Cancel</button>
                <button className="button-primary" disabled={!this.isNewKeyValid()} onClick={this.saveNewProfile}>
                  Save
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Selected profile detail card */}
        {isExisting && !isCreatingProfile && (
          <div className="card prof-detail-card">
            <div className="card-body">
              {/* Editable name */}
              <div className="prof-detail-name-row">
                <input
                  className="prof-detail-name"
                  type="text"
                  value={editingName}
                  placeholder="Click to name this profile..."
                  onInput={this.handleEditingNameChange}
                  onBlur={this.handleEditingNameBlur}
                  onKeyDown={this.handleEditingNameKeyDown}
                />
                <PencilIcon />
              </div>

              {/* Public key */}
              <div className="prof-detail-field">
                <span className="prof-detail-label">Public key</span>
                <div className="prof-detail-value">
                  <code>{truncatePublicKeys(selectedNpub, 16, 12)}</code>
                  <button className="button-onlyicon" onClick={() => { navigator.clipboard.writeText(selectedNpub); this.showMessage('Copied npub!', 'success'); }} title="Copy npub">
                    <CopyIcon />
                  </button>
                </div>
              </div>

              {/* Private key */}
              <div className="prof-detail-field">
                <span className="prof-detail-label">Private key</span>
                <div className="prof-detail-value">
                  <code>{isKeyHidden ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' : truncatePublicKeys(privateKey, 16, 12)}</code>
                  <button className="button-onlyicon" onClick={this.handlePrivateKeyShowClick} title={isKeyHidden ? 'Show' : 'Hide'}>
                    {isKeyHidden ? <EyeIcon /> : <EyeOffIcon />}
                  </button>
                </div>
              </div>

              <hr className="separator" />

              {/* Actions */}
              <div className="prof-detail-actions">
                <button onClick={this.handleExportProfileClick}>
                  <DownloadIcon /> Export
                </button>
                <span className="opts-toolbar-spacer" />
                <button className="button-danger-outline" onClick={this.handleDeleteProfileClick}>
                  <TrashIcon /> Delete
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Empty state */}
        {profileKeys.length === 0 && !isCreatingProfile && (
          <div className="card">
            <div className="card-body">
              <p className="opts-empty">No profiles yet. Create one to get started.</p>
            </div>
          </div>
        )}
      </div>
    );
  }

  renderSecuritySection() {
    const { pinEnabled, pinCacheDuration, relayAuthGrants, sessionTokenCount } = this.state;
    const grantEntries = Object.values(relayAuthGrants || {}) as any[];
    return (
      <div className="opts-section">
        <h2 className="opts-section-title">Security</h2>
        <p className="opts-section-desc">PIN encryption, relay authentication, and session tokens.</p>

        <div className="card">
          <div className="card-body">
            <div className="switch-row">
              <div className="switch-label">
                <strong>PIN Protection</strong>
                <span>Encrypt all private keys with a PIN. You'll be asked to enter it once per session.</span>
              </div>
              <input type="checkbox" className="toggle" checked={pinEnabled} onChange={this.handleProtectWithPinClick} />
            </div>
            {pinEnabled && (
              <div className="form-control switch-sub-control">
                <span className="form-label">Cache duration</span>
                <select id="pin-cache-duration" value={pinCacheDuration} onChange={this.handlePinCacheDurationChange}>
                  <option value={10 * 1000}>10 seconds</option>
                  <option value={30 * 1000}>30 seconds</option>
                  <option value={5 * 60 * 1000}>5 minutes</option>
                  <option value={10 * 60 * 1000}>10 minutes</option>
                </select>
                <span className="form-hint">How long the PIN is remembered after entry.</span>
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-body">
            <strong>Session Tokens</strong>
            <p className="form-hint">
              Session tokens let you authenticate with relays once, then reconnect without re-signing.
              Tokens are shared across all Nostr client apps using this extension.
            </p>
            <p className="form-hint">
              Active tokens: <strong>{sessionTokenCount}</strong>
            </p>
            {sessionTokenCount > 0 && (
              <button className="button button-danger" style={{ 'margin-top': '8px' }} onClick={this.handleClearSessionTokens}>
                Clear all session tokens
              </button>
            )}
          </div>
        </div>

        {grantEntries.length > 0 && (
          <div className="card">
            <div className="card-body">
              <strong>Trusted Relays (Auto-Auth)</strong>
              <p className="form-hint">
                These relays are trusted to receive your identity proof automatically.
                Auth challenges (kind:22242) from these relays are signed without prompting.
              </p>
              <div className="relays-list" style={{ 'margin-top': '8px' }}>
                {grantEntries.map((grant: any) => (
                  <div key={grant.relayUrl} className="relay-row">
                    <div className="relay-url">
                      <RadioIcon />
                      <span>{grant.relayUrl}</span>
                    </div>
                    <div className="relay-controls">
                      <span className="form-hint" style={{ 'margin-right': '8px' }}>
                        {grant.duration === 'forever' ? 'forever' : grant.duration}
                      </span>
                      <button
                        className="button-onlyicon icon-btn-danger"
                        onClick={() => this.handleRemoveRelayAuthGrant(grant.relayUrl)}
                        title="Remove trust"
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  renderRelaysSection() {
    const { relays, newRelayURL, isNewRelayURLValid } = this.state;
    return (
      <div className="opts-section">
        <h2 className="opts-section-title">Relays</h2>
        <p className="opts-section-desc">Preferred relays for this profile. Clients may request these via NIP-07.</p>

        {relays.length > 0 && (
          <div className="card">
            <div className="card-body">
              <div className="relays-list">
                {relays.map(({ url, policy }, i) => (
                  <div key={i} className="relay-row">
                    <div className="relay-url">
                      <RadioIcon />
                      <input value={url} onInput={this.handleChangeRelayURL.bind(this, i)} />
                    </div>
                    <div className="relay-controls">
                      <label className="relay-toggle">
                        <input type="checkbox" className="toggle" checked={policy.read} onChange={this.handleToggleRelayPolicy.bind(this, i, 'read')} />
                        <span>R</span>
                      </label>
                      <label className="relay-toggle">
                        <input type="checkbox" className="toggle" checked={policy.write} onChange={this.handleToggleRelayPolicy.bind(this, i, 'write')} />
                        <span>W</span>
                      </label>
                      <button className="button-onlyicon icon-btn-danger" onClick={this.handleRemoveRelayClick} title="Remove relay" id={url}>
                        <TrashIcon />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="card">
          <div className="card-body">
            {relays.length === 0 && (
              <p className="opts-empty">No relays configured. Add one below.</p>
            )}
            <div className="form-control">
              <span className="form-label">Add relay</span>
              <div className="input-group">
                <input
                  id="new-relay-url"
                  placeholder="wss://relay.example.com"
                  value={newRelayURL}
                  onInput={this.handleNewRelayURLChange}
                  className={!isNewRelayURLValid ? 'input-error' : ''}
                />
                <button className="button-primary" disabled={!this.isRelayURLValid()} onClick={this.handleAddRelayClick}>
                  Add
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  renderPermissionsSection() {
    const { sitePermissions, expandedSiteHost, siteAuditEntries } = this.state;
    const sites = Object.values(sitePermissions);
    const now = Math.floor(Date.now() / 1000);
    return (
      <div className="opts-section">
        <h2 className="opts-section-title">Site Permissions</h2>
        <p className="opts-section-desc">Sites that have requested signing access. Click a site to view its audit log.</p>

        {sites.length === 0 ? (
          <div className="card">
            <div className="card-body">
              <p className="opts-empty">No sites have requested access yet. Visit a Nostr app to get started.</p>
            </div>
          </div>
        ) : (
          <div className="sites-list">
            {sites.map((site: SitePermission) => {
              const activeGrants = site.grants.filter(g => g.expires_at === null || g.expires_at > now);
              const isExpanded = expandedSiteHost === site.host;
              const auditList = isExpanded ? [...siteAuditEntries].reverse() : [];
              return (
                <div key={site.host} className={`card${isExpanded ? ' card-expanded' : ''}`}>
                  <div className="card-body">
                    <div className="site-perm-header" onClick={() => this.handleExpandSite(site.host)} style={{ cursor: 'pointer' }}>
                      <strong>{site.host}</strong>
                      <div className="site-perm-stats">
                        <span className="site-perm-stat">{site.request_count} requests</span>
                        {site.denied_count > 0 && <span className="site-perm-stat site-perm-stat-warn">{site.denied_count} denied</span>}
                        <span className="site-perm-stat">First seen {formatDistance(new Date(site.first_seen * 1000), new Date(), { addSuffix: true })}</span>
                      </div>
                      <button className="button-onlyicon icon-btn-danger" onClick={(e: any) => { e.stopPropagation(); this.handleRevokeAllGrants(site.host); }} title="Revoke all">
                        <TrashIcon />
                      </button>
                    </div>
                    {activeGrants.length > 0 ? (
                      <div className="site-grants">
                        {activeGrants.map(grant => (
                          <div key={grant.capability} className="site-grant-row">
                            <div className="site-grant-info">
                              <span className="site-grant-cap">{CAPABILITY_INFO[grant.capability]?.label || grant.capability}</span>
                              <span className="site-grant-meta">
                                {grant.duration} · {formatDistance(new Date(grant.granted_at * 1000), new Date(), { addSuffix: true })}
                              </span>
                            </div>
                            <button className="link-btn link-btn-danger" onClick={() => this.handleRevokeGrant(site.host, grant.capability)}>
                              Revoke
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="site-perm-empty">No active grants</p>
                    )}

                    {isExpanded && (
                      <div className="site-audit-section">
                        <div className="site-audit-header">
                          <strong>Audit Log</strong>
                          <span className="site-perm-stat">{auditList.length} entries</span>
                        </div>
                        {auditList.length === 0 ? (
                          <p className="site-perm-empty">No audit entries for this site.</p>
                        ) : (
                          <div className="site-audit-list">
                            {auditList.slice(0, 50).map(entry => (
                              <div key={entry.id} className="site-audit-row">
                                <div className="site-audit-info">
                                  <span className="site-audit-summary">{entry.summary}</span>
                                  {entry.eventKindName && <span className="site-audit-kind">{entry.eventKindName}</span>}
                                </div>
                                <div className="site-audit-right">
                                  <span className={`site-audit-disp site-audit-disp-${entry.disposition}`}>{entry.disposition}</span>
                                  <span className="site-audit-time">{format(new Date(entry.timestamp), 'MMM d, HH:mm')}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  handleClearAuditLogClick = async () => {
    if (!window.confirm('Clear the audit log and free storage space? Your profiles, keys, and permissions are preserved.')) return;
    try {
      // Read essential data into memory first
      const keysToKeep = [
        'private_key', 'profiles', 'pin_enabled', 'encrypted_private_key',
        'active_public_key', 'pin_cache_duration',
        'session_tokens', 'relay_auth_grants',
        'site_permissions', 'security_preferences',
      ];
      const essentials = await browser.storage.local.get(keysToKeep);

      // Nuclear clear — this always succeeds regardless of quota
      await browser.storage.local.clear();

      // Restore only the essential data (without the bloated audit log)
      const toRestore: Record<string, any> = {};
      for (const [k, v] of Object.entries(essentials)) {
        if (v !== undefined && v !== null) toRestore[k] = v;
      }
      if (Object.keys(toRestore).length > 0) {
        await browser.storage.local.set(toRestore);
      }

      this.showMessage('Audit log cleared — storage freed!', 'success');
    } catch (err: any) {
      this.showMessage('Failed: ' + err?.message, 'warning');
    }
  };

  renderDangerSection() {
    return (
      <div className="opts-section">
        <h2 className="opts-section-title opts-section-title-danger">Danger Zone</h2>
        <p className="opts-section-desc">Irreversible actions. Proceed with caution.</p>

        <div className="card card-danger-outline">
          <div className="card-body">
            <div className="danger-row">
              <div className="danger-info">
                <strong>Clear audit log</strong>
                <span>Remove all request history. Frees storage space if the extension is running low on quota.</span>
              </div>
              <button className="button-danger-outline" onClick={this.handleClearAuditLogClick}>
                <TrashIcon /> Clear
              </button>
            </div>
          </div>
        </div>

        <div className="card card-danger-outline">
          <div className="card-body">
            <div className="danger-row">
              <div className="danger-info">
                <strong>Delete all data</strong>
                <span>Permanently remove all profiles, private keys, relay lists, site permissions, and settings from this browser. This cannot be undone.</span>
              </div>
              <button className="button-danger" onClick={this.handleClearStorageClick}>
                <TrashIcon /> Delete
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  render() {
    const {
      profileExportJson, profileImportJson,
      isExportModalShown, isImportModalShown,
      message, messageType,
    } = this.state;

    return (
      <>
        <div className="opts-layout">
          {this.renderSidebar()}
          <div className="opts-main">
            {message && <Alert message={message} type={messageType} />}
            {this.renderContent()}
          </div>
        </div>

        <Modal show={isExportModalShown} className="export-modal" onClose={this.handleExportModalClose}>
          <p>Profile JSON (contains your private key):</p>
          <code>{profileExportJson}</code>
          <button onClick={this.handleExportProfileCopyClick}><CopyIcon /> Copy</button>
        </Modal>

        <Modal show={isImportModalShown} className="import-modal" onClose={this.handleImportModalClose}>
          <p>Paste the profile JSON:</p>
          <textarea value={profileImportJson} onInput={this.handleChangeProfileImportJson}></textarea>
          <button onClick={this.handleImportProfileImportClick}>Import</button>
        </Modal>
      </>
    );
  }
}

try {
  console.log('[Ribbit Signer] Options page loading...');
  const root = document.getElementById('main');
  if (!root) {
    console.error('[Ribbit Signer] #main element not found!');
  } else {
    render(<Options />, root);
    console.log('[Ribbit Signer] Options page rendered.');
  }
} catch (err) {
  console.error('[Ribbit Signer] Options page render error:', err);
  document.body.innerHTML = `<pre style="color:red;padding:2em">${err}\n${(err as any)?.stack}</pre>`;
}
