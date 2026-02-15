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
  profileName: string | undefined;
  profileExportJson: string;
  profileImportJson: string;
  isExportModalShown: boolean;
  isImportModalShown: boolean;
  privateKey: string;
  isKeyHidden: boolean;
  relays: RelayConfig[];
  newRelayURL: string;
  isNewRelayURLValid: boolean;
  sitePermissions: SitePermissions;
  message: string;
  messageType: string;
  version: string;
  pinEnabled: boolean;
  pinCacheDuration: number;
  nip42AutoSign: boolean;
}

class Options extends Component<{}, OptionsState> {
  state: OptionsState = {
    activeSection: 'profiles',
    selectedProfilePubKey: '',
    profiles: {},
    isLoadingProfile: false,
    profileName: undefined,
    profileExportJson: '',
    profileImportJson: '',
    isExportModalShown: false,
    isImportModalShown: false,
    privateKey: '',
    isKeyHidden: true,
    relays: [],
    newRelayURL: '',
    isNewRelayURLValid: true,
    sitePermissions: {},
    message: '',
    messageType: 'info',
    version: '0.0.0',
    pinEnabled: false,
    pinCacheDuration: 10 * 1000,
    nip42AutoSign: false,
  };

  private messageTimer: any = null;
  private relaysSaveDebounced = debounce(() => this.saveRelaysInStorage(), 700);

  componentDidMount() {
    // Load profiles
    Storage.readProfiles().then(profiles => {
      if (profiles) {
        let selectedPubKey = Object.keys(profiles)[0];
        this.setState({ profiles, selectedProfilePubKey: selectedPubKey }, () => {
          this.loadAndSelectProfile(selectedPubKey);
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
    Storage.isNip42AutoSignEnabled().then(enabled => this.setState({ nip42AutoSign: enabled }));

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

  async loadAndSelectProfile(pubKey: string) {
    const profile: ProfileConfig = this.state.profiles[pubKey];
    if (!profile) {
      console.warn(`The profile for pubkey '${pubKey}' does not exist.`);
      return;
    }
    this.setState({ isLoadingProfile: true });
    const currentPinEnabled = await Storage.isPinEnabled();
    this.setState({
      profileName: profile.name,
      relays: this.convertRelaysToUIArray(profile.relays),
      pinEnabled: currentPinEnabled,
      privateKey: formatPrivateKeyForDisplay(profile.privateKey || '', currentPinEnabled),
      isLoadingProfile: false,
    });
    console.log(`The profile for pubkey '${pubKey}' was loaded.`);
  }

  reloadSelectedProfile = () => {
    this.loadAndSelectProfile(this.state.selectedProfilePubKey);
  };

  handleSelectedProfileChange = (event: any) => {
    const pubKey = event.target.value;
    this.setState({ selectedProfilePubKey: pubKey }, () => {
      this.loadAndSelectProfile(pubKey);
    });
  };

  handleNewProfileClick = () => {
    const newProfile: ProfileConfig = { privateKey: '' };
    this.setState({
      profiles: { ...this.state.profiles, ['']: newProfile },
      selectedProfilePubKey: '',
      relays: [],
      privateKey: '',
    });
  };

  isNewProfilePending = () => {
    return Object.keys(this.state.profiles).includes('');
  };

  getSelectedProfile = (): ProfileConfig | null => {
    const { selectedProfilePubKey, profiles } = this.state;
    return selectedProfilePubKey ? profiles[selectedProfilePubKey] : null;
  };

  handleProfileNameChange = (e: any) => {
    this.setState({ profileName: e.target.value });
  };

  handleProfileNameBlur = async () => {
    const profile = this.getSelectedProfile();
    const { profileName, selectedProfilePubKey } = this.state;
    if (profile && profileName != profile.name) {
      profile.name = profileName?.trim() != '' ? profileName : undefined;
      await Storage.updateProfile(profile, selectedProfilePubKey);
      const profiles = { ...this.state.profiles };
      profiles[selectedProfilePubKey] = { ...profile };
      this.setState({ profiles });
    }
  };

  handleProfileNameKeyDown = (e: any) => {
    if (e.key === 'Enter') { e.target.blur(); }
    if (e.key === 'Escape') {
      const profile = this.getSelectedProfile();
      this.setState({ profileName: profile?.name });
      e.target.blur();
    }
  };

  handleExportProfileClick = () => {
    const profile = this.getSelectedProfile();
    this.setState({ profileExportJson: JSON.stringify(profile), isExportModalShown: true });
  };

  handleExportProfileCopyClick = () => {
    navigator.clipboard.writeText(this.state.profileExportJson);
  };

  handleExportModalClose = () => { this.setState({ isExportModalShown: false }); };

  handleImportProfileClick = () => { this.setState({ isImportModalShown: true }); };

  handleChangeProfileImportJson = (e: any) => {
    this.setState({ profileImportJson: e.target.value });
  };

  handleImportProfileImportClick = async () => {
    let newProfile: ProfileConfig;
    try {
      newProfile = JSON.parse(this.state.profileImportJson);
    } catch (error: any) {
      console.warn(`Error parsing the entered JSON`, error);
      this.showMessage(`There was an error parsing the JSON. ${error?.message}`, 'warning');
      return;
    }
    if (!newProfile) {
      console.warn(`The imported profile is empty.`);
      this.showMessage(`The imported profile is invalid.`, 'warning');
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
          'Cannot import profile with encrypted private key without public key. Please decrypt first or provide public key.',
          'warning'
        );
        return;
      }
    } else {
      newPubKey = derivePublicKeyFromPrivateKey(newProfile.privateKey);
    }

    await Storage.addProfile(newProfile, newPubKey);
    this.setState({
      profiles: { ...this.state.profiles, [newPubKey]: newProfile },
      privateKey: formatPrivateKeyForDisplay(newProfile.privateKey || '', pinEnabled),
      selectedProfilePubKey: newPubKey,
      isImportModalShown: false,
    });
  };

  handleImportModalClose = () => { this.setState({ isImportModalShown: false }); };

  handleDeleteProfileClick = async (e: any) => {
    e.preventDefault();
    const { selectedProfilePubKey, profiles } = this.state;
    if (window.confirm(`Delete the profile "${nip19.npubEncode(selectedProfilePubKey)}"?`)) {
      await Storage.deleteProfile(selectedProfilePubKey);
      const updateProfiles = { ...profiles };
      delete updateProfiles[selectedProfilePubKey];
      this.setState({ profiles: updateProfiles });
    }
  };

  saveProfiles = async () => {
    await Storage.updateProfiles(this.state.profiles);
  };

  //#endregion Profiles

  //#region Private key

  savePrivateKey = async () => {
    const { privateKey, profiles, selectedProfilePubKey } = this.state;
    if (!this.isKeyValid()) return;

    if (privateKey == '') {
      console.warn("Won't save an empty private key");
      return;
    }

    let privateKeyIntArray: Uint8Array | undefined = undefined;

    if (isHexadecimal(privateKey)) {
      privateKeyIntArray = convertHexToUint8Array(privateKey);
    } else {
      try {
        let { type, data } = nip19.decode(privateKey);
        if (type === 'nsec') privateKeyIntArray = data as Uint8Array;
      } catch (err) {
        console.error('Converting key to hexa (decode NIP19)', err);
      }
    }

    if (privateKeyIntArray) {
      const privKeyNip19 = nip19.nsecEncode(privateKeyIntArray);
      this.setState({ privateKey: privKeyNip19 });

      const hexPrivateKey = convertUint8ArrayToHex(privateKeyIntArray);
      const newPubKey = derivePublicKeyFromPrivateKey(hexPrivateKey);
      profiles[newPubKey] = profiles[selectedProfilePubKey];

      const pinEnabled = await Storage.isPinEnabled();
      if (pinEnabled) {
        try {
          const encryptResponse: { success: boolean; encryptedKey?: string; error?: string } =
            (await browser.runtime.sendMessage({
              type: 'encryptPrivateKey',
              privateKey: hexPrivateKey
            })) as any;

          if (!encryptResponse || !encryptResponse.success) {
            this.showMessage(
              encryptResponse?.error ||
                'Failed to encrypt private key. PIN is required when PIN protection is enabled.',
              'warning'
            );
            return;
          }
          if (!encryptResponse.encryptedKey) {
            this.showMessage('Failed to encrypt private key: no encrypted key returned', 'warning');
            return;
          }
          profiles[newPubKey].privateKey = encryptResponse.encryptedKey;
        } catch (error: any) {
          console.error('Error encrypting private key:', error);
          this.showMessage('Failed to encrypt private key. ' + error?.message, 'warning');
          return;
        }
      } else {
        profiles[newPubKey].privateKey = hexPrivateKey;
      }

      delete profiles[selectedProfilePubKey];
      this.setState({ selectedProfilePubKey: newPubKey, profiles }, () => {
        this.loadAndSelectProfile(newPubKey);
      });

      await this.saveProfiles();
    } else {
      console.warn('Saving and empty private key');
    }

    this.showMessage('Saved private key!', 'success');
  };

  isKeyValid = () => {
    return validatePrivateKeyFormat(this.state.privateKey);
  };

  handlePrivateKeyChange = (e: any) => {
    this.setState({ privateKey: e.target.value.toLowerCase().trim() });
  };

  generateRandomPrivateKey = () => {
    this.setState({ privateKey: nip19.nsecEncode(generateSecretKey()) });
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

  handleNip42AutoSignToggle = async () => {
    const newValue = !this.state.nip42AutoSign;
    await Storage.setNip42AutoSign(newValue);
    this.setState({ nip42AutoSign: newValue });
    this.showMessage(
      newValue
        ? 'NIP-42 auto-sign enabled. Relay AUTH events will be signed automatically.'
        : 'NIP-42 auto-sign disabled. You will be prompted for each relay AUTH.',
      'info'
    );
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
      this.reloadSitePermissions();
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
    const { selectedProfilePubKey, profiles, profileName, privateKey, isKeyHidden } = this.state;
    const profileKeys = Object.keys(profiles);
    const isNewPending = this.isNewProfilePending();
    const isExisting = selectedProfilePubKey !== '';

    return (
      <div className="opts-section">
        <h2 className="opts-section-title">Profiles</h2>
        <p className="opts-section-desc">Your signing identities. Each profile has its own key, relays, and permissions.</p>

        {/* Profile list */}
        <div className="profile-list">
          {profileKeys.filter(pk => pk !== '').map(pk => {
            const p = profiles[pk];
            const isActive = pk === selectedProfilePubKey;
            const npub = nip19.npubEncode(pk);
            return (
              <div
                key={pk}
                className={`profile-card${isActive ? ' profile-card-active' : ''}`}
                onClick={() => { if (!isActive) { this.setState({ selectedProfilePubKey: pk }); this.loadAndSelectProfile(pk); } }}
              >
                <div className="profile-card-left">
                  <span className={`profile-dot${isActive ? ' profile-dot-active' : ''}`} />
                  <div className="profile-card-info">
                    {isActive ? (
                      <input
                        className="profile-card-name-input"
                        type="text"
                        value={profileName ?? ''}
                        placeholder="Profile name"
                        onInput={this.handleProfileNameChange}
                        onBlur={this.handleProfileNameBlur}
                        onKeyDown={this.handleProfileNameKeyDown}
                        onClick={(e: any) => e.stopPropagation()}
                      />
                    ) : (
                      <span className="profile-card-name">{p.name || 'Unnamed'}</span>
                    )}
                    <code className="profile-card-npub">{truncatePublicKeys(npub, 12, 8)}</code>
                  </div>
                </div>
                <div className="profile-card-actions">
                  {isActive && (
                    <>
                      <button className="button-onlyicon" onClick={this.handleExportProfileClick} title="Export">
                        <DownloadIcon />
                      </button>
                      <button className="button-onlyicon icon-btn-danger" onClick={this.handleDeleteProfileClick} title="Delete">
                        <TrashIcon />
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* New profile flow */}
        {isNewPending ? (
          <div className="card profile-new-card">
            <div className="card-body">
              <span className="profile-new-badge">New Profile</span>
              <div className="form-control">
                <span className="form-label">Private key</span>
                <div className="input-group">
                  <input
                    id="private-key"
                    type={isKeyHidden ? 'password' : 'text'}
                    value={privateKey}
                    onInput={this.handlePrivateKeyChange}
                    placeholder="nsec1... or hex"
                  />
                  <button onClick={this.handlePrivateKeyShowClick} title={isKeyHidden ? 'Show' : 'Hide'}>
                    {isKeyHidden ? <EyeIcon /> : <EyeOffIcon />}
                  </button>
                </div>
                <span className="form-hint">Paste an existing key or generate a new one.</span>
              </div>
              <div className="opts-toolbar">
                <button onClick={this.generateRandomPrivateKey}>
                  <DiceIcon /> Generate
                </button>
                <button onClick={this.handleImportProfileClick}>
                  <ArrowUpCircleIcon /> Import JSON
                </button>
                <span className="opts-toolbar-spacer" />
                <button className="button-primary" disabled={!this.isKeyValid()} onClick={this.savePrivateKey}>
                  Save Profile
                </button>
              </div>
            </div>
          </div>
        ) : (
          <button className="profile-add-btn" onClick={this.handleNewProfileClick}>
            <AddCircleIcon /> Add new profile
          </button>
        )}

        {/* Active profile key display (existing profiles) */}
        {isExisting && (
          <div className="card mt-4">
            <div className="card-body">
              <div className="form-control">
                <span className="form-label">Private key</span>
                <div className="input-group">
                  <input
                    id="private-key"
                    type={isKeyHidden ? 'password' : 'text'}
                    value={privateKey}
                    readOnly
                  />
                  <button onClick={this.handlePrivateKeyShowClick} title={isKeyHidden ? 'Show' : 'Hide'}>
                    {isKeyHidden ? <EyeIcon /> : <EyeOffIcon />}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  renderSecuritySection() {
    const { pinEnabled, pinCacheDuration, nip42AutoSign } = this.state;
    return (
      <div className="opts-section">
        <h2 className="opts-section-title">Security</h2>
        <p className="opts-section-desc">PIN encryption and relay authentication.</p>

        <div className="card">
          <div className="card-body">
            <div className="switch-row">
              <div className="switch-label">
                <strong>PIN Protection</strong>
                <span>Encrypt all private keys with a PIN. Required each session.</span>
              </div>
              <input type="checkbox" className="toggle" checked={pinEnabled} onChange={this.handleProtectWithPinClick} />
            </div>
            {pinEnabled && (
              <div className="form-control">
                <span className="form-label">Cache duration</span>
                <select id="pin-cache-duration" value={pinCacheDuration} onChange={this.handlePinCacheDurationChange}>
                  <option value={10 * 1000}>10 seconds</option>
                  <option value={30 * 1000}>30 seconds</option>
                  <option value={5 * 60 * 1000}>5 minutes</option>
                  <option value={10 * 60 * 1000}>10 minutes</option>
                </select>
              </div>
            )}

            <hr className="separator" />

            <div className="switch-row">
              <div className="switch-label">
                <strong>NIP-42 Auto-Sign</strong>
                <span>Auto-sign relay AUTH challenges. Cannot post or spend on your behalf.</span>
              </div>
              <input type="checkbox" className="toggle" checked={nip42AutoSign} onChange={this.handleNip42AutoSignToggle} />
            </div>
          </div>
        </div>
      </div>
    );
  }

  renderRelaysSection() {
    const { relays, newRelayURL, isNewRelayURLValid } = this.state;
    return (
      <div className="opts-section">
        <h2 className="opts-section-title">Relays</h2>
        <p className="opts-section-desc">Preferred relays for this profile. Clients may request these.</p>

        <div className="card">
          <div className="card-body">
            {relays.length === 0 ? (
              <p className="opts-empty">No relays configured yet.</p>
            ) : (
              <div className="relays-list">
                {relays.map(({ url, policy }, i) => (
                  <div key={i} className="relay-row">
                    <div className="relay-url">
                      <input value={url} onInput={this.handleChangeRelayURL.bind(this, i)} />
                    </div>
                    <div className="relay-controls">
                      <label className="relay-toggle">
                        <input type="checkbox" className="toggle" checked={policy.read} onChange={this.handleToggleRelayPolicy.bind(this, i, 'read')} />
                        <span>Read</span>
                      </label>
                      <label className="relay-toggle">
                        <input type="checkbox" className="toggle" checked={policy.write} onChange={this.handleToggleRelayPolicy.bind(this, i, 'write')} />
                        <span>Write</span>
                      </label>
                      <button className="button-onlyicon icon-btn-danger" onClick={this.handleRemoveRelayClick} title="Remove relay" id={url}>
                        <TrashIcon />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <hr className="separator" />

            <div className="form-control">
              <span className="form-label">Add relay</span>
              <div className="input-group">
                <input
                  id="new-relay-url"
                  placeholder="wss://..."
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
    const { sitePermissions } = this.state;
    const sites = Object.values(sitePermissions);
    const now = Math.floor(Date.now() / 1000);
    return (
      <div className="opts-section">
        <h2 className="opts-section-title">Site Permissions</h2>
        <p className="opts-section-desc">Sites that have requested signing access.</p>

        {sites.length === 0 ? (
          <div className="card">
            <div className="card-body">
              <p className="opts-empty">No sites have requested access yet.</p>
            </div>
          </div>
        ) : (
          <div className="sites-list">
            {sites.map((site: SitePermission) => {
              const activeGrants = site.grants.filter(g => g.expires_at === null || g.expires_at > now);
              return (
                <div key={site.host} className="card card-compact">
                  <div className="card-body">
                    <div className="site-perm-header">
                      <strong>{site.host}</strong>
                      <span className="site-perm-meta">{site.request_count} req · {site.denied_count} denied</span>
                      <button className="button-onlyicon icon-btn-danger" onClick={() => this.handleRevokeAllGrants(site.host)} title="Revoke all">
                        <TrashIcon />
                      </button>
                    </div>
                    {activeGrants.length > 0 ? (
                      <table className="site-grants-table">
                        <thead>
                          <tr><th>Capability</th><th>Duration</th><th>Granted</th><th></th></tr>
                        </thead>
                        <tbody>
                          {activeGrants.map(grant => (
                            <tr key={grant.capability}>
                              <td>{CAPABILITY_INFO[grant.capability]?.label || grant.capability}</td>
                              <td>{grant.duration}</td>
                              <td className="help-cursor" title={format(new Date(grant.granted_at * 1000), 'yyyy-MM-dd HH:mm:ss')}>
                                {formatDistance(new Date(grant.granted_at * 1000), new Date(), { addSuffix: true })}
                              </td>
                              <td>
                                <button className="link-btn link-btn-danger" onClick={() => this.handleRevokeGrant(site.host, grant.capability)}>
                                  Revoke
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <p className="site-perm-empty">No active grants</p>
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

  renderDangerSection() {
    return (
      <div className="opts-section">
        <h2 className="opts-section-title opts-section-title-danger">Danger Zone</h2>
        <p className="opts-section-desc">Irreversible actions.</p>

        <div className="card card-danger-outline">
          <div className="card-body">
            <p className="card-description">Permanently delete all profiles, keys, permissions, and settings from this browser.</p>
            <div className="opts-toolbar">
              <button className="button-danger" onClick={this.handleClearStorageClick}>
                <TrashIcon /> Delete all data
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
