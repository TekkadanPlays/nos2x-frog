import browser from 'webextension-polyfill';

const EXTENSION_CODE = 'ribbit-signer';

// inject the script that will provide window.nostr
let script = document.createElement('script');
script.setAttribute('async', 'false');
script.setAttribute('type', 'text/javascript');
script.setAttribute('src', browser.runtime.getURL('nostr-provider.js'));
document.head.appendChild(script);

// Session token message types that use params fields directly
const SESSION_TYPES = new Set([
  'getSessionToken', 'setSessionToken', 'removeSessionToken', 'getSessionTokens',
  'getClientId', 'getRelayAuthGrants', 'removeRelayAuthGrant',
]);

// listen for messages from that script
window.addEventListener('message', async message => {
  if (message.source !== window) return;
  if (!message.data) return;
  if (!message.data.params && !SESSION_TYPES.has(message.data.type)) return;
  if (message.data.ext !== EXTENSION_CODE) return;

  // pass on to background
  let response;
  try {
    // Session token messages pass params fields as top-level message properties
    if (SESSION_TYPES.has(message.data.type)) {
      response = await browser.runtime.sendMessage({
        type: message.data.type,
        ...message.data.params,
        host: location.host
      });
    } else {
      response = await browser.runtime.sendMessage({
        type: message.data.type,
        params: message.data.params,
        host: location.host
      });
    }
  } catch (error) {
    console.error('Error from calling extension.', error);
    response = { error };
  }

  // return response
  window.postMessage(
    { id: message.data.id, ext: EXTENSION_CODE, response },
    message.origin
  );
});
