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

Ribbit Signer extends `window.nostr` with a session token broker. This allows client apps to store and retrieve relay session tokens through the extension, sharing them across all Nostr apps in the browser.

```javascript
// Get a cached session token for a relay (returns null if none/expired)
async window.nostr.session.getToken(relayUrl): { token, expiresAt, pubkey } | null

// Store a session token received from a relay
async window.nostr.session.setToken(relayUrl, token, expiresAt, pubkey): void

// Remove a stored session token
async window.nostr.session.removeToken(relayUrl): void
```

**How it works with strfry session tokens:**

1. Client connects to relay → receives `["AUTH", "<challenge>"]`
2. Client checks `window.nostr.session.getToken(relayUrl)` for a cached token
3. If token exists → send `["SESSION", "<token>"]` to relay (no signing needed)
4. If no token → sign kind:22242 via `window.nostr.signEvent()` → send `["AUTH", signedEvent]`
5. Relay responds with `["SESSION", "<token>", <expires_at>]`
6. Client stores: `window.nostr.session.setToken(relayUrl, token, expiresAt, pubkey)`
7. On reconnection or from another app, step 2 finds the cached token → zero signing

This eliminates the NIP-42 "hundreds of popups" problem at its root. One sign per relay, then tokens handle the rest — shared across every Nostr client app running in the browser.

## Per-Relay Auth Grants

When a client app requests signing a kind:22242 (relay auth) event, Ribbit Signer extracts the relay URL from the event tags and checks for a per-relay auth grant.

- If the relay is trusted → the event is auto-signed silently
- If the relay is unknown → the user is prompted (like any other signing request)
- When approving, the user can choose a duration: once, session, 5 min, 1 hour, 8 hours, 24 hours, or forever
- Grants are visible and revocable in **Options → Security → Trusted Relays**

This replaces the old blanket "NIP-42 auto-sign" toggle with fine-grained, per-relay trust. You control exactly which relays receive your identity proof automatically.

## Install

Build from source (see Develop below), then load as a temporary add-on in Firefox.

## Develop

```
$ git clone https://github.com/TekkadanPlays/nos2x-frog
$ cd nos2x-frog
$ yarn install
$ yarn run build
```

1. Open Firefox → `about:debugging`
2. Click "This Firefox"
3. Click "Load Temporary Add-on..."
4. Select any file from the `dist/` folder

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
    // Try session token first (no signing needed)
    ws.send(JSON.stringify(["SESSION", cached.token]));
    // If relay accepts, it sends a fresh token — store it
    // If relay rejects (expired/restart), fall back to NIP-42 below
    return;
  }

  // Step 2: Wait for AUTH challenge from relay
  // relay sends: ["AUTH", "<challenge>"]

  // Step 3: Sign the auth event
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
    headers: { 'Authorization': `Nostr-Session ${cached.token}` }
  });
  const { pubkey, expires_at } = await resp.json();
  // pubkey is the authenticated user's hex public key
}
```

---

## License and Credits

LICENSE: public domain.
Original work by [fiatjaf](https://github.com/fiatjaf) and [diegogurpegui](https://github.com/diegogurpegui).
Icons from [IonIcons](https://ionic.io/ionicons).
