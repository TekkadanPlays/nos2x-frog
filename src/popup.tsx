import { createElement } from 'inferno-create-element';
import { Component, render } from 'inferno';
import browser from 'webextension-polyfill';
import { nip19 } from 'nostr-tools';

import {
  type ProfilesConfig,
  type SitePermissions,
  type AuditLogEntry,
  type Capability,
  CAPABILITY_INFO,
} from './types';
import * as Storage from './storage';
import { truncatePublicKeys } from './common';

import CopyIcon from './assets/icons/copy-outline.svg';
import CogIcon from './assets/icons/cog-outline.svg';
import TrashIcon from './assets/icons/trash-outline.svg';
import CloseCircleIcon from './assets/icons/close-circle-outline.svg';

//#region Helpers >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

const DISPOSITION_STYLE: Record<string, { label: string; cls: string }> = {
  'approved':      { label: 'Approved',      cls: 'disp-approved' },
  'auto-approved': { label: 'Auto',          cls: 'disp-auto' },
  'rejected':      { label: 'Denied',        cls: 'disp-rejected' },
  'rate-limited':  { label: 'Rate Limited',  cls: 'disp-blocked' },
  'cooldown':      { label: 'Cooldown',      cls: 'disp-blocked' },
  'queue-full':    { label: 'Queue Full',    cls: 'disp-blocked' },
  'deduped':       { label: 'Dedup',         cls: 'disp-muted' },
  'relay-auth':    { label: 'Relay Auth',     cls: 'disp-auto' },
  'error':         { label: 'Error',         cls: 'disp-error' },
};

function DispChip({ disposition }: { disposition: string }) {
  const s = DISPOSITION_STYLE[disposition] ?? { label: disposition, cls: '' };
  return <span className={`disp-chip ${s.cls}`}>{s.label}</span>;
}

function timeAgo(iso: string): string {
  try {
    const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (sec < 5) return 'now';
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
    return `${Math.floor(sec / 86400)}d`;
  } catch { return ''; }
}

//#endregion Helpers <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<

//#region Audit Panel >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

interface AuditPanelState {
  entries: AuditLogEntry[];
  suppressedCount: number;
  expandedGroups: Set<string>;
  profiles: ProfilesConfig;
}

const PREVIEW_COUNT = 3;

class AuditPanel extends Component<{}, AuditPanelState> {
  state: AuditPanelState = { entries: [], suppressedCount: 0, expandedGroups: new Set(), profiles: {} };
  private poll: any = null;

  componentDidMount() {
    this.load();
    Storage.readProfiles().then(p => { if (p) this.setState({ profiles: p }); });
    browser.runtime.sendMessage({ type: 'clearSuppressedCount' }).catch(() => {});
    this.poll = setInterval(() => this.load(), 2500);
  }
  componentWillUnmount() { if (this.poll) clearInterval(this.poll); }

  load = async () => {
    try {
      const r: any = await browser.runtime.sendMessage({ type: 'getActivityLog' });
      if (r?.entries) this.setState({ entries: r.entries, suppressedCount: r.suppressedCount ?? 0 });
    } catch {}
  };

  clear = async () => {
    await browser.runtime.sendMessage({ type: 'clearActivityLog' });
    this.setState({ entries: [], suppressedCount: 0, expandedGroups: new Set() });
  };

  toggleGroup = (key: string) => {
    const next = new Set(this.state.expandedGroups);
    if (next.has(key)) next.delete(key); else next.add(key);
    this.setState({ expandedGroups: next });
  };

  profileLabel(pubkey: string): string {
    const prof = this.state.profiles[pubkey];
    if (prof?.name) return prof.name;
    try { return truncatePublicKeys(nip19.npubEncode(pubkey), 10, 10) as string; } catch { return pubkey.substring(0, 12) + '…'; }
  }

  render() {
    const { entries, expandedGroups, profiles } = this.state;
    const list = [...entries].reverse();

    // Group: npub → host → entries
    const byProfile: Record<string, Record<string, AuditLogEntry[]>> = {};
    for (const e of list) {
      const pk = e.profilePubKey || '_unknown';
      const host = e.host || 'unknown';
      if (!byProfile[pk]) byProfile[pk] = {};
      if (!byProfile[pk][host]) byProfile[pk][host] = [];
      byProfile[pk][host].push(e);
    }
    const pubkeys = Object.keys(byProfile);

    return (
      <div className="panel audit-panel">
        {list.length === 0 ? (
          <p className="panel-empty">No activity yet</p>
        ) : (
          <>
            <div className="audit-toolbar">
              <button className="link-btn" onClick={this.clear}>Clear all</button>
            </div>
            <div className="audit-list">
              {pubkeys.map(pk => {
                const hostMap = byProfile[pk];
                const hosts = Object.keys(hostMap);
                const totalForProfile = hosts.reduce((n, h) => n + hostMap[h].length, 0);
                return (
                  <div key={pk} className="audit-profile-group">
                    {pubkeys.length > 1 && (
                      <div className="audit-profile-header">
                        <span className="audit-profile-label">{pk === '_unknown' ? 'Unknown profile' : this.profileLabel(pk)}</span>
                        <span className="audit-group-count">{totalForProfile}</span>
                      </div>
                    )}
                    {hosts.map(host => {
                      const hostEntries = hostMap[host];
                      const groupKey = `${pk}:${host}`;
                      const isExpanded = expandedGroups.has(groupKey);
                      const visible = isExpanded ? hostEntries : hostEntries.slice(0, PREVIEW_COUNT);
                      const hasMore = hostEntries.length > PREVIEW_COUNT;
                      return (
                        <div key={host} className="audit-group">
                          <div className="audit-group-header" onClick={() => this.toggleGroup(groupKey)} style={{ cursor: 'pointer' }}>
                            <span className="audit-group-host">{host}</span>
                            <span className="audit-group-count">{hostEntries.length}</span>
                          </div>
                          {visible.map(e => (
                            <div key={e.id} className={`audit-row${e.silent ? ' audit-silent' : ''}`}>
                              <div className="audit-left">
                                <span className="audit-summary">{e.summary}</span>
                              </div>
                              <div className="audit-right">
                                <DispChip disposition={e.disposition} />
                                <span className="audit-age">{timeAgo(e.timestamp)}</span>
                              </div>
                            </div>
                          ))}
                          {hasMore && !isExpanded && (
                            <button className="link-btn audit-expand-btn" onClick={() => this.toggleGroup(groupKey)}>
                              Show {hostEntries.length - PREVIEW_COUNT} more
                            </button>
                          )}
                          {hasMore && isExpanded && (
                            <button className="link-btn audit-expand-btn" onClick={() => this.toggleGroup(groupKey)}>
                              Collapse
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    );
  }
}

//#endregion Audit Panel <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<

//#region Sites Panel >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

interface SitesPanelState { permissions: SitePermissions; }

class SitesPanel extends Component<{}, SitesPanelState> {
  state: SitesPanelState = { permissions: {} };

  componentDidMount() { this.load(); }

  load = async () => {
    try {
      const r: any = await browser.runtime.sendMessage({ type: 'getSitePermissions' });
      if (r?.permissions) this.setState({ permissions: r.permissions });
    } catch {}
  };

  revokeGrant = async (host: string, cap: Capability) => {
    await browser.runtime.sendMessage({ type: 'revokeGrant', host, capability: cap });
    this.load();
  };
  revokeAll = async (host: string) => {
    await browser.runtime.sendMessage({ type: 'revokeAllGrants', host });
    this.load();
  };
  removeSite = async (host: string) => {
    await browser.runtime.sendMessage({ type: 'removeSite', host });
    this.load();
  };

  render() {
    const sites = Object.values(this.state.permissions);
    const now = Math.floor(Date.now() / 1000);

    if (!sites.length) {
      return <div className="panel"><p className="panel-empty">No connected sites</p></div>;
    }

    return (
      <div className="panel sites-panel">
        {sites.map(site => {
          const active = site.grants.filter(g => g.expires_at === null || g.expires_at > now);
          return (
            <div key={site.host} className="site-card">
              <div className="site-card-top">
                <div className="site-card-identity">
                  <span className="site-host">{site.host}</span>
                  <span className="site-stats">{site.request_count} req · {site.denied_count} denied</span>
                </div>
                <button className="icon-btn icon-btn-danger" onClick={() => this.removeSite(site.host)} title="Remove site">
                  <TrashIcon />
                </button>
              </div>
              {active.length > 0 ? (
                <div className="grant-chips">
                  {active.map(g => {
                    const info = CAPABILITY_INFO[g.capability];
                    return (
                      <span key={g.capability} className="grant-chip">
                        {info?.label || g.capability}
                        <button className="grant-chip-x" onClick={() => this.revokeGrant(site.host, g.capability)} title="Revoke">×</button>
                      </span>
                    );
                  })}
                  {active.length > 1 && (
                    <button className="link-btn link-btn-danger" onClick={() => this.revokeAll(site.host)}>Revoke all</button>
                  )}
                </div>
              ) : (
                <span className="site-no-grants">No active permissions</span>
              )}
            </div>
          );
        })}
      </div>
    );
  }
}

//#endregion Sites Panel <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<

//#region Identity Panel >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

interface IdentityPanelState {
  pubHex: string | undefined;
  pubNpub: string | undefined;
  keyFmt: 'npub' | 'hex';
  profiles: ProfilesConfig;
  copied: boolean;
}

class IdentityPanel extends Component<{}, IdentityPanelState> {
  state: IdentityPanelState = {
    pubHex: undefined, pubNpub: undefined, keyFmt: 'npub', profiles: {}, copied: false,
  };
  private copyTimer: any = null;

  componentDidMount() {
    Storage.getActivePublicKey().then(pk => {
      if (pk) this.setState({ pubHex: pk, pubNpub: nip19.npubEncode(pk) });
    });
    Storage.readProfiles().then(p => { if (p) this.setState({ profiles: p }); });
  }

  componentWillUnmount() { if (this.copyTimer) clearTimeout(this.copyTimer); }

  openOptions = (e?: any) => {
    if (e) e.preventDefault();
    browser.runtime.openOptionsPage().catch(() => {
      browser.tabs.create({ url: browser.runtime.getURL('options.html'), active: true });
    }).finally(() => window.close());
  };

  switchProfile = async (e: any) => {
    const pk = e.target.value;
    this.setState({ pubHex: pk, pubNpub: nip19.npubEncode(pk) });
    const profile = this.state.profiles[pk];
    if (!profile) return;
    await Storage.setActivePublicKey(pk);
    const pinOn = await Storage.isPinEnabled();
    if (pinOn) {
      if (profile.privateKey) await Storage.setEncryptedPrivateKey(profile.privateKey);
    } else {
      await Storage.updateActivePrivateKey(profile.privateKey);
    }
  };

  copyKey = () => {
    const { keyFmt, pubHex, pubNpub } = this.state;
    navigator.clipboard.writeText((keyFmt === 'hex' ? pubHex : pubNpub) ?? '');
    this.setState({ copied: true });
    if (this.copyTimer) clearTimeout(this.copyTimer);
    this.copyTimer = setTimeout(() => this.setState({ copied: false }), 1500);
  };

  toggleFmt = () => {
    this.setState({ keyFmt: this.state.keyFmt === 'npub' ? 'hex' : 'npub' });
  };

  render() {
    const { pubHex, pubNpub, keyFmt, profiles, copied } = this.state;

    if (!pubHex) {
      return (
        <div className="panel identity-panel identity-empty">
          <p>No key configured — open settings to add one.</p>
        </div>
      );
    }

    const displayKey = keyFmt === 'hex' ? pubHex : pubNpub;
    const profileKeys = Object.keys(profiles);

    return (
      <div className="panel identity-panel">
        <div className="id-key-row">
          <button className="id-key-format" onClick={this.toggleFmt} title="Toggle format">
            {keyFmt}
          </button>
          <code className="id-key-value">{truncatePublicKeys(displayKey ?? '', 14, 14)}</code>
          <button className={`icon-btn${copied ? ' icon-btn-ok' : ''}`} onClick={this.copyKey} title="Copy">
            {copied ? '✓' : <CopyIcon />}
          </button>
        </div>

        {profileKeys.length > 1 && (
          <div className="id-profile-switch">
            <select value={pubHex} onChange={this.switchProfile}>
              {profileKeys.map(pk => (
                <option value={pk} key={pk}>
                  {profiles[pk].name || truncatePublicKeys(nip19.npubEncode(pk), 12, 12)}
                </option>
              ))}
            </select>
          </div>
        )}

      </div>
    );
  }
}

//#endregion Identity Panel <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<

//#region Main Popup >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

type Tab = 'identity' | 'sites' | 'audit';

interface PopupState { tab: Tab; badge: number; }

class Popup extends Component<{}, PopupState> {
  state: PopupState = { tab: 'identity', badge: 0 };

  componentDidMount() {
    browser.runtime.sendMessage({ type: 'getActivityLog' }).then((r: any) => {
      if (r?.suppressedCount) this.setState({ badge: r.suppressedCount });
    }).catch(() => {});
  }

  setTab = (t: Tab) => {
    this.setState({ tab: t, badge: t === 'audit' ? 0 : this.state.badge });
  };

  openOptions = () => {
    browser.runtime.openOptionsPage().catch(() => {
      browser.tabs.create({ url: browser.runtime.getURL('options.html'), active: true });
    }).finally(() => window.close());
  };

  render() {
    const { tab, badge } = this.state;

    return (
      <div className="popup-shell">
        <header className="popup-header">
          <div className="popup-logo-text">
            <span className="popup-logo-icon">{'\u{1F438}'}</span>
            <span className="popup-logo-name">nos2x-frog</span>
          </div>
          <button className="popup-header-settings" onClick={this.openOptions} title="Settings">
            <CogIcon />
          </button>
        </header>

        <nav className="popup-nav">
          <button className={`nav-btn${tab === 'identity' ? ' nav-active' : ''}`} onClick={() => this.setTab('identity')}>
            Identity
          </button>
          <button className={`nav-btn${tab === 'sites' ? ' nav-active' : ''}`} onClick={() => this.setTab('sites')}>
            Sites
          </button>
          <button className={`nav-btn${tab === 'audit' ? ' nav-active' : ''}`} onClick={() => this.setTab('audit')}>
            Audit
            {badge > 0 && <span className="nav-badge">{badge}</span>}
          </button>
        </nav>

        <div className="popup-content">
          {tab === 'identity' && <IdentityPanel />}
          {tab === 'sites' && <SitesPanel />}
          {tab === 'audit' && <AuditPanel />}
        </div>
      </div>
    );
  }
}

//#endregion Main Popup <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<

render(<Popup />, document.getElementById('main'));
