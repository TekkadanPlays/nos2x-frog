![](src/assets/logo/logotype.png)
# Ribbit Signer (nos2x-frog)

Nostr signer extension for [ribbit.network](https://ribbit.network). Fork of [nos2x-fox](https://github.com/diegogurpegui/nos2x-fox).

## Features

- **NIP-07** `window.nostr` provider for signing Nostr events
- **NIP-04 / NIP-44** encryption and decryption
- **Session token broker** — authenticate with a relay once, then share the token across all client apps
- **Per-relay auth grants** — trust specific relays to auto-approve auth challenges (kind:22242)
- **PIN protection** with AES-GCM-256 encrypted key storage
- **Multi-profile** support with granular per-site capability grants
- **Anti-spam** — rate limiting, deduplication, and prompt queue caps

## NIP-07 API

Standard NIP-07 methods:

```javascript
async window.nostr.getPublicKey(): string
async window.nostr.signEvent(event): Event
async window.nostr.getRelays(): { [url: string]: RelayPolicy }
async window.nostr.nip04.encrypt(pubkey, plaintext): string
async window.nostr.nip04.decrypt(pubkey, ciphertext): string
async window.nostr.nip44.encrypt(pubkey, plaintext): string
async window.nostr.nip44.decrypt(pubkey, ciphertext): string
```

### Session Token API (extension)

Ribbit Signer extends `window.nostr` with a session token broker. Tokens are **origin-isolated** — each web app (origin) gets its own tokens that cannot be accessed by other origins. The extension also automatically generates a unique **client ID** per origin and injects it into NIP-42 auth events, so the relay binds each session token to the specific client that authenticated.

```javascript
// Get a cached session token for a relay (returns null if none/expired/wrong origin)
async window.nostr.session.getToken(relayUrl): { token, expiresAt, pubkey, clientId } | null

// Store a session token received from a relay
async window.nostr.session.setToken(relayUrl, token, expiresAt, pubkey, clientId?): void

// Remove a stored session token
async window.nostr.session.removeToken(relayUrl): void

// Get this origin's unique client ID (32 hex chars, generated once, persisted)
async window.nostr.session.getClientId(): string
```

**How it works with strfry session tokens:**

1. Client connects to relay → receives `["AUTH", "<challenge>"]`
2. Client checks `window.nostr.session.getToken(relayUrl)` for a cached token
3. If token exists → send `["SESSION", token, clientId]` to relay (no signing needed)
4. If no token → sign kind:22242 via `window.nostr.signEvent()` → extension auto-injects `["client", clientId]` tag → send `["AUTH", signedEvent]`
5. Relay responds with `["SESSION", "<token>", <expires_at>]`
6. Client stores: `window.nostr.session.setToken(relayUrl, token, expiresAt, pubkey)`
7. On reconnection, step 2 finds the cached token → zero signing

**Origin isolation:** Iris at `iris.to` and Snort at `snort.social` each get their own tokens. Iris cannot read Snort's tokens and vice versa. Each must do its own NIP-42 auth once, then use its own session token for reconnections.

**Client binding:** The extension injects a `["client", "<client_id>"]` tag into kind:22242 events before signing. The relay bakes this client ID into the session token's HMAC. Even if a token were somehow leaked, it cannot be used without the matching client ID.

## Per-Relay Auth Grants

When a client app requests signing a kind:22242 (relay auth) event, Ribbit Signer extracts the relay URL from the event tags and checks for a per-relay auth grant.

- If the relay is trusted → the event is auto-signed silently
- If the relay is unknown → the user is prompted (like any other signing request)
- When approving, the user can choose a duration: once, session, 5 min, 1 hour, 8 hours, 24 hours, or forever
- Grants are visible and revocable in **Options → Security → Trusted Relays**

This replaces the old blanket "NIP-42 auto-sign" toggle with fine-grained, per-relay trust. You control exactly which relays receive your identity proof automatically.

## Relay-Side Security (strfry)

When paired with [TekkadanPlays/strfry](https://github.com/TekkadanPlays/strfry), the full authentication stack provides:

- **Client-bound session tokens** — tokens are cryptographically bound to the extension's per-origin client ID, preventing cross-client theft
- **Sensitive event filtering** — DMs, gift wraps, and other private kinds are only returned to the sender or recipient (configurable via `sensitiveKinds`)
- **Authorization plugin** — relay operators can run a custom script to whitelist pubkeys or assign access tiers (full vs. partial/write-only)
- **Anti-abuse tarpit** — repeated failed AUTH attempts trigger an escalating delay, blocking brute-force attacks

See the [strfry README](https://github.com/TekkadanPlays/strfry#authentication-nip-42) for full relay configuration details.

## Install

### From GitHub Releases (recommended)

Download the latest release from [Releases](https://github.com/TekkadanPlays/nos2x-frog/releases):

**Firefox:**
1. Download `ribbit-signer-*-firefox.xpi`
2. Open Firefox → `about:addons` → gear icon → "Install Add-on From File..."
3. Select the `.xpi` file

**Chrome / Brave / Edge:**
1. Download `ribbit-signer-*-chrome.zip`
2. Unzip to a folder
3. Open `chrome://extensions` (or `brave://extensions`, `edge://extensions`)
4. Enable "Developer mode" (toggle in top-right)
5. Click "Load unpacked" → select the unzipped folder

### Build from Source

Requires [Node.js](https://nodejs.org/) 18+ and [Yarn](https://yarnpkg.com/).

```bash
git clone https://github.com/TekkadanPlays/nos2x-frog
cd nos2x-frog
yarn install
```

**Build for Firefox:**
```bash
yarn build              # production build → dist/
```

**Build for Chrome (Manifest V3):**
```bash
yarn build:chrome       # production build → dist/
```

**Build release packages (both browsers):**
```bash
yarn release            # → releases/ribbit-signer-*-firefox.xpi
                        #   releases/ribbit-signer-*-chrome.zip
```

**Load for development:**

Firefox:
1. `yarn start:firefox` — launches Firefox with the extension auto-loaded
2. Or: `about:debugging` → "This Firefox" → "Load Temporary Add-on..." → select any file in `dist/`

Chrome:
1. `yarn build:chrome`
2. `chrome://extensions` → "Developer mode" → "Load unpacked" → select `dist/`

## PIN Protection

Optional PIN protection encrypts your private keys with AES-GCM-256 (PBKDF2, 100K iterations). The PIN is cached in memory only and lost when the browser closes.

## Client Integration Guide

### Authenticating with strfry relays

If you're building a Nostr client that uses Ribbit Signer, here's how to implement session-token-aware relay authentication:

```javascript
async function authenticateWithRelay(ws, relayUrl) {
  // Step 1: Check for a cached session token
  const cached = await window.nostr.session.getToken(relayUrl);

  if (cached) {
    // Try session token first — include clientId for client-bound validation
    ws.send(JSON.stringify(["SESSION", cached.token, cached.clientId]));
    // If relay accepts, it sends a fresh token — store it
    // If relay rejects (expired/restart/wrong client), fall back to NIP-42 below
    return;
  }

  // Step 2: Wait for AUTH challenge from relay
  // relay sends: ["AUTH", "<challenge>"]

  // Step 3: Sign the auth event
  // NOTE: The extension automatically injects ["client", clientId] into the event
  // before signing, so the relay binds the session token to this origin.
  const authEvent = {
    kind: 22242,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["relay", relayUrl],
      ["challenge", challenge]  // from the AUTH message
    ],
    content: ""
  };
  const signed = await window.nostr.signEvent(authEvent);
  ws.send(JSON.stringify(["AUTH", signed]));

  // Step 4: Relay responds with OK + SESSION token
  // ["SESSION", "<token>", <expires_at>]
  // Store it for future use:
  const pubkey = await window.nostr.getPublicKey();
  await window.nostr.session.setToken(relayUrl, token, expiresAt, pubkey);
}
```

### Using the HTTP verification endpoint

If your relay runs strfry with session tokens enabled, you can verify identity via HTTP:

```javascript
const cached = await window.nostr.session.getToken(relayUrl);
if (cached) {
  const resp = await fetch(`https://relay.example.com/auth/verify`, {
    headers: {
      'Authorization': `Nostr-Session ${cached.token}`,
      'Nostr-Client': cached.clientId  // required for client-bound tokens
    }
  });
  const { pubkey, expires_at, client_id } = await resp.json();
  // pubkey is the authenticated user's hex public key
}
```

---

## License and Credits

LICENSE: public domain.
Original work by [fiatjaf](https://github.com/fiatjaf) and [diegogurpegui](https://github.com/diegogurpegui).
Icons from [IonIcons](https://ionic.io/ionicons).
