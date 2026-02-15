![](src/assets/logo/logotype.png)
# Ribbit Signer

Nostr signer extension for [ribbit.network](https://ribbit.network). Fork of [nos2x-fox](https://github.com/diegogurpegui/nos2x-fox).

## Features

- NIP-07 `window.nostr` provider for signing Nostr events
- NIP-04 / NIP-44 encryption and decryption
- **NIP-42 batch relay authentication** — auto-sign AUTH challenges for hundreds of relays without popups
- PIN protection with AES-GCM-256 encrypted key storage
- Multi-profile support

### NIP-07 API

```javascript
async window.nostr.getPublicKey(): string
async window.nostr.signEvent(event): Event
async window.nostr.getRelays(): { [url: string]: RelayPolicy }
async window.nostr.nip04.encrypt(pubkey, plaintext): string
async window.nostr.nip04.decrypt(pubkey, ciphertext): string
async window.nostr.nip44.encrypt(pubkey, plaintext): string
async window.nostr.nip44.decrypt(pubkey, ciphertext): string
```

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

## NIP-42 Auto-Sign

Ribbit Signer can automatically sign relay authentication challenges (kind 22242) without prompting. This is essential when connecting to many authenticated relays at once.

- **Options page** → "NIP-42 Relay Authentication" → Enable/Disable
- AUTH events only prove your identity to a relay — they cannot spend funds or post on your behalf
- When disabled, a batch "Authorize all AUTH events" button appears in the prompt when multiple AUTH requests queue up

## PIN Protection

Optional PIN protection encrypts your private keys with AES-GCM-256 (PBKDF2, 100K iterations). The PIN is cached in memory only and lost when the browser closes.

---

## License and Credits

LICENSE: public domain.
Original work by [fiatjaf](https://github.com/fiatjaf) and [diegogurpegui](https://github.com/diegogurpegui).
Icons from [IonIcons](https://ionic.io/ionicons).
