import { createElement } from 'inferno-create-element';
import { Component, render } from 'inferno';
import browser from 'webextension-polyfill';
import { nip19 } from 'nostr-tools';

import {
  truncatePublicKeys,
  derivePublicKeyFromPrivateKey
} from './common';
import {
  type Capability,
  type KindRiskTier,
  type OpenPromptItem,
  type ProfileConfig,
  type PromptResponse,
  CAPABILITY_INFO,
  PermissionDuration,
  getKindName,
  getKindRisk,
} from './types';
import * as Storage from './storage';
import { subscribeOpenPrompts } from './PromptManager';

import ShieldCheckmarkIcon from './assets/icons/shield-checkmark-outline.svg';
import TimerIcon from './assets/icons/timer-outline.svg';
import CaretBackIcon from './assets/icons/caret-back-outline.svg';
import CaretForwradIcon from './assets/icons/caret-forward-outline.svg';
import CheckmarkCircleIcon from './assets/icons/checkmark-circle-outline.svg';
import CloseCircleIcon from './assets/icons/close-circle-outline.svg';
import WarningIcon from './assets/icons/warning-outline.svg';

//#region Helpers -------------------------------------------------------------

const RISK_LABELS: Record<KindRiskTier, { label: string; cls: string }> = {
  low:      { label: 'LOW RISK',      cls: 'risk-low' },
  medium:   { label: 'MEDIUM RISK',   cls: 'risk-medium' },
  high:     { label: 'HIGH RISK',     cls: 'risk-high' },
  critical: { label: 'CRITICAL RISK', cls: 'risk-critical' },
};

const DURATION_OPTIONS: { value: PermissionDuration; label: string }[] = [
  { value: PermissionDuration.ONCE,       label: 'Just this once' },
  { value: PermissionDuration.MINUTES_5,  label: '5 minutes' },
  { value: PermissionDuration.MINUTES_30, label: '30 minutes' },
  { value: PermissionDuration.HOURS_1,    label: '1 hour' },
  { value: PermissionDuration.HOURS_8,    label: '8 hours' },
  { value: PermissionDuration.HOURS_24,   label: '24 hours' },
  { value: PermissionDuration.SESSION,    label: 'This session' },
  { value: PermissionDuration.FOREVER,    label: 'Forever' },
];

function formatAge(unixSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function truncateContent(content: string, max: number = 120): string {
  if (!content) return '';
  if (content.length <= max) return content;
  return content.substring(0, max) + '...';
}

//#endregion Helpers ----------------------------------------------------------

//#region Event Detail Component ----------------------------------------------

function EventDetail({ params, capability }: { params: any; capability: Capability }) {
  if (capability === 'getPublicKey') {
    return (
      <div className="event-detail">
        <div className="event-detail-row">
          <span className="event-detail-label">Action</span>
          <span className="event-detail-value">Read your public key (identity)</span>
        </div>
      </div>
    );
  }

  if (capability === 'getRelays') {
    return (
      <div className="event-detail">
        <div className="event-detail-row">
          <span className="event-detail-label">Action</span>
          <span className="event-detail-value">Read your preferred relay list</span>
        </div>
      </div>
    );
  }

  if (capability === 'signEvent' && params?.event) {
    const event = params.event;
    const kind = event.kind;
    const kindName = getKindName(kind);
    const tags = event.tags || [];
    const pTags = tags.filter((t: any) => t[0] === 'p').map((t: any) => t[1]);
    const eTags = tags.filter((t: any) => t[0] === 'e').map((t: any) => t[1]);

    return (
      <div className="event-detail">
        <div className="event-detail-row">
          <span className="event-detail-label">Event Kind</span>
          <span className="event-detail-value">
            <code>{kind}</code> — {kindName}
          </span>
        </div>
        {event.content && (
          <div className="event-detail-row">
            <span className="event-detail-label">Content</span>
            <span className="event-detail-value event-detail-content">
              {truncateContent(event.content, 200)}
            </span>
          </div>
        )}
        {pTags.length > 0 && (
          <div className="event-detail-row">
            <span className="event-detail-label">To ({pTags.length})</span>
            <span className="event-detail-value">
              {pTags.map((p: string) => (
                <code key={p} className="event-detail-pubkey">{p.substring(0, 12)}...</code>
              ))}
            </span>
          </div>
        )}
        {eTags.length > 0 && (
          <div className="event-detail-row">
            <span className="event-detail-label">References ({eTags.length})</span>
            <span className="event-detail-value">
              {eTags.slice(0, 3).map((e: string) => (
                <code key={e} className="event-detail-pubkey">{e.substring(0, 12)}...</code>
              ))}
              {eTags.length > 3 && <span> +{eTags.length - 3} more</span>}
            </span>
          </div>
        )}
        {tags.length > 0 && (
          <div className="event-detail-row">
            <span className="event-detail-label">Tags</span>
            <span className="event-detail-value">{tags.length} total</span>
          </div>
        )}
      </div>
    );
  }

  if ((capability === 'nip04.encrypt' || capability === 'nip44.encrypt') && params?.peer) {
    return (
      <div className="event-detail">
        <div className="event-detail-row">
          <span className="event-detail-label">Action</span>
          <span className="event-detail-value">Encrypt message</span>
        </div>
        <div className="event-detail-row">
          <span className="event-detail-label">Recipient</span>
          <span className="event-detail-value"><code>{params.peer.substring(0, 16)}...</code></span>
        </div>
        {params.plaintext && (
          <div className="event-detail-row">
            <span className="event-detail-label">Message</span>
            <span className="event-detail-value event-detail-content">
              {truncateContent(params.plaintext, 100)}
            </span>
          </div>
        )}
      </div>
    );
  }

  if ((capability === 'nip04.decrypt' || capability === 'nip44.decrypt') && params?.peer) {
    return (
      <div className="event-detail">
        <div className="event-detail-row">
          <span className="event-detail-label">Action</span>
          <span className="event-detail-value">Decrypt message</span>
        </div>
        <div className="event-detail-row">
          <span className="event-detail-label">From</span>
          <span className="event-detail-value"><code>{params.peer.substring(0, 16)}...</code></span>
        </div>
      </div>
    );
  }

  return null;
}

//#endregion Event Detail Component -------------------------------------------

//#region Site Trust Badge ----------------------------------------------------

function SiteTrustBadge({ siteInfo }: { siteInfo?: OpenPromptItem['siteInfo'] }) {
  if (!siteInfo) {
    return <span className="site-trust site-trust-new">NEW SITE</span>;
  }

  const age = Math.floor(Date.now() / 1000) - siteInfo.first_seen;
  const isNew = age < 300; // less than 5 minutes
  const hasGrants = siteInfo.existingGrants.length > 0;
  const highDenied = siteInfo.denied_count > 3;

  if (highDenied) {
    return <span className="site-trust site-trust-suspicious">FREQUENTLY DENIED</span>;
  }
  if (isNew) {
    return <span className="site-trust site-trust-new">NEW SITE</span>;
  }
  if (hasGrants) {
    return <span className="site-trust site-trust-known">KNOWN SITE</span>;
  }
  return (
    <span className="site-trust site-trust-seen">
      SEEN {formatAge(siteInfo.first_seen)} — {siteInfo.request_count} requests
    </span>
  );
}

//#endregion Site Trust Badge -------------------------------------------------

//#region Main Prompt Component -----------------------------------------------

interface PromptState {
  openPrompts: OpenPromptItem[];
  activeProfile: ProfileConfig | undefined;
  activePubKeyNIP19: string;
  activePromptIndex: number;
  selectedDuration: PermissionDuration;
  rememberChoice: boolean;
  showRawData: boolean;
  showCloseConfirmation: boolean;
}

class Prompt extends Component<{}, PromptState> {
  state: PromptState = {
    openPrompts: [],
    activeProfile: undefined,
    activePubKeyNIP19: '',
    activePromptIndex: 0,
    selectedDuration: PermissionDuration.ONCE,
    rememberChoice: false,
    showRawData: false,
    showCloseConfirmation: false,
  };

  private unsubscribePrompts: (() => void) | null = null;
  private beforeUnloadHandler: ((e: BeforeUnloadEvent) => void) | null = null;

  componentDidMount() {
    Storage.getActiveProfile().then(profile => {
      try {
        const pubKey = derivePublicKeyFromPrivateKey(profile.privateKey);
        this.setState({
          activeProfile: profile,
          activePubKeyNIP19: nip19.npubEncode(pubKey),
        });
      } catch {
        // PIN-protected key, try active public key
        Storage.getActivePublicKey().then(pubKey => {
          if (pubKey) {
            this.setState({
              activeProfile: profile,
              activePubKeyNIP19: nip19.npubEncode(pubKey),
            });
          }
        });
      }
    });

    this.unsubscribePrompts = subscribeOpenPrompts((prompts) => {
      this.setState({ openPrompts: prompts }, () => {
        this.updateBeforeUnload();
      });
    });
  }

  componentWillUnmount() {
    if (this.unsubscribePrompts) this.unsubscribePrompts();
    if (this.beforeUnloadHandler) {
      window.removeEventListener('beforeunload', this.beforeUnloadHandler);
    }
  }

  updateBeforeUnload() {
    const { openPrompts } = this.state;
    if (openPrompts && openPrompts.length > 1) {
      if (!this.beforeUnloadHandler) {
        this.beforeUnloadHandler = (event: BeforeUnloadEvent) => {
          if (!this.state.showCloseConfirmation) {
            event.preventDefault();
            event.returnValue = '';
            this.setState({ showCloseConfirmation: true });
          }
        };
        window.addEventListener('beforeunload', this.beforeUnloadHandler);
      }
    } else {
      if (this.beforeUnloadHandler) {
        window.removeEventListener('beforeunload', this.beforeUnloadHandler);
        this.beforeUnloadHandler = null;
      }
    }
  }

  sendDecision = (action: 'approve' | 'reject', prompt: OpenPromptItem) => {
    const { selectedDuration, rememberChoice } = this.state;
    const response: PromptResponse = {
      prompt: true,
      id: prompt.id,
      host: prompt.host,
      decision: {
        action,
        capabilities: action === 'approve' ? [prompt.capability] : [],
        duration: selectedDuration,
        remember: action === 'approve' ? rememberChoice : false,
      },
    };
    browser.runtime.sendMessage(response);
  };

  handleApprove = (ev: any) => {
    ev.preventDefault();
    const { openPrompts, activePromptIndex } = this.state;
    if (!openPrompts?.length) return;
    this.sendDecision('approve', openPrompts[activePromptIndex]);
  };

  handleReject = (ev: any) => {
    ev.preventDefault();
    const { openPrompts, activePromptIndex } = this.state;
    if (!openPrompts?.length) return;
    this.sendDecision('reject', openPrompts[activePromptIndex]);
  };

  handleRejectAll = async (ev: any) => {
    ev.preventDefault();
    const { openPrompts } = this.state;
    if (!openPrompts?.length) return;
    for (const prompt of [...openPrompts]) {
      this.sendDecision('reject', prompt);
    }
  };

  movePrompt = (direction: number) => {
    const { openPrompts, activePromptIndex } = this.state;
    if (openPrompts?.length) {
      let newIndex = activePromptIndex + direction;
      if (newIndex < 0) newIndex = 0;
      if (newIndex >= openPrompts.length) newIndex = openPrompts.length - 1;
      this.setState({ activePromptIndex: newIndex });
    }
  };

  handleCloseConfirm = () => { window.close(); };
  handleCloseCancel = () => { this.setState({ showCloseConfirmation: false }); };

  render() {
    const {
      openPrompts, activePromptIndex, activeProfile, activePubKeyNIP19,
      selectedDuration, rememberChoice, showRawData, showCloseConfirmation
    } = this.state;

    if (!openPrompts?.length) {
      return <div className="prompt-empty">No pending requests.</div>;
    }

    const current = openPrompts[activePromptIndex];
    const capInfo = CAPABILITY_INFO[current.capability];
    const riskTier = current.riskTier
      || (current.capability === 'signEvent' && current.params?.event
        ? getKindRisk(current.params.event.kind)
        : capInfo?.risk || 'medium');
    const riskInfo = RISK_LABELS[riskTier];
    const FLOOD_THRESHOLD = 10;
    const isFlood = openPrompts.length >= FLOOD_THRESHOLD;
    const isCritical = riskTier === 'critical';

    return (
      <>
        {/* Close confirmation modal */}
        {showCloseConfirmation && (
          <div className="close-confirm-dialog-wrapper">
            <div className="close-confirm-dialog">
              <p>Closing this window will reject all {openPrompts.length} pending requests.</p>
              <div className="action-buttons">
                <button onClick={this.handleCloseCancel}>Cancel</button>
                <button className="button button-danger" onClick={this.handleCloseConfirm}>
                  Reject All & Close
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Flood warning */}
        {isFlood && (
          <div className="flood-warning">
            <strong>Flood detected:</strong> {openPrompts.length} pending requests.
            A website may be spamming signing requests.
            <button className="button button-danger" onClick={this.handleRejectAll}>
              Reject all {openPrompts.length}
            </button>
          </div>
        )}

        {/* Prompt navigator */}
        {openPrompts.length > 1 && (
          <div className="prompt-navigator">
            <button className="button-onlyicon" disabled={activePromptIndex === 0}
              onClick={() => this.movePrompt(-1)} title="Previous">
              <CaretBackIcon />
            </button>
            <span>{activePromptIndex + 1} / {openPrompts.length}</span>
            <button className="button-onlyicon" disabled={activePromptIndex === openPrompts.length - 1}
              onClick={() => this.movePrompt(1)} title="Next">
              <CaretForwradIcon />
            </button>
          </div>
        )}

        {/* Risk banner */}
        <div className={`prompt-risk-banner ${riskInfo.cls}`}>
          {isCritical && <WarningIcon />}
          <span className="risk-label">{riskInfo.label}</span>
          <span className="risk-cap">{capInfo?.label || current.capability}</span>
        </div>

        {/* Site header */}
        <div className="prompt-site-header">
          <h1 className="prompt-host">{current.host}</h1>
          <SiteTrustBadge siteInfo={current.siteInfo} />
        </div>

        {/* Capability description */}
        <div className="prompt-capability">
          <p className="prompt-capability-desc">
            This site wants to <strong>{capInfo?.description || current.capability}</strong>
          </p>
        </div>

        {/* Signing profile */}
        <div className="prompt-profile">
          <span className="prompt-profile-label">Signing as:</span>
          <span className="prompt-profile-value">
            {activeProfile?.name && <strong>{activeProfile.name}</strong>}
            {activePubKeyNIP19 && (
              <code>{truncatePublicKeys(activePubKeyNIP19, 10, 10)}</code>
            )}
          </span>
        </div>

        {/* Event details */}
        <EventDetail params={current.params} capability={current.capability} />

        {/* Duration selector */}
        <div className="prompt-duration">
          <label className="prompt-duration-label">If approved, allow for:</label>
          <div className="prompt-duration-options">
            {DURATION_OPTIONS.map(opt => (
              <button
                key={opt.value}
                className={`prompt-duration-btn${selectedDuration === opt.value ? ' active' : ''}${opt.value === PermissionDuration.FOREVER ? ' duration-forever' : ''}`}
                onClick={() => this.setState({ selectedDuration: opt.value })}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {selectedDuration !== PermissionDuration.ONCE && (
            <label className="prompt-remember">
              <input
                type="checkbox"
                checked={rememberChoice}
                onChange={(e: any) => this.setState({ rememberChoice: e.target.checked })}
              />
              Remember for this site (auto-approve future requests)
            </label>
          )}
        </div>

        {/* Critical warning */}
        {isCritical && (
          <div className="alert warning">
            <WarningIcon /> This is a <strong>critical-risk</strong> operation.
            It may involve financial transactions or grant remote access to your keys.
            Proceed only if you trust this site completely.
          </div>
        )}

        {/* Action buttons */}
        <div className="prompt-action-buttons">
          <button className="button button-success" onClick={this.handleApprove}>
            <CheckmarkCircleIcon /> Approve
          </button>
          <button className="button button-danger" onClick={this.handleReject}>
            <CloseCircleIcon /> Deny
          </button>
        </div>

        {/* Raw data toggle */}
        <div className="prompt-raw-toggle">
          <button
            className="button-onlyicon"
            onClick={() => this.setState({ showRawData: !showRawData })}
          >
            {showRawData ? 'Hide' : 'Show'} raw request data
          </button>
        </div>
        {showRawData && current.params && (
          <pre className="prompt-request-raw">
            <code>{JSON.stringify(current.params, null, 2)}</code>
          </pre>
        )}
      </>
    );
  }
}

//#endregion Main Prompt Component --------------------------------------------

render(<Prompt />, document.getElementById('main'));
