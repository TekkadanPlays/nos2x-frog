import { createElement } from 'inferno-create-element';
import { Component, render } from 'inferno';
import browser from 'webextension-polyfill';
import { encryptPrivateKey } from './pinEncryption';
import * as Storage from './storage';
import { PinMessageResponse } from './types';

type PinMode = 'setup' | 'unlock' | 'disable';

interface PinState {
  mode: PinMode;
  pin: string;
  confirmPin: string;
  error: string;
  isProcessing: boolean;
  promptId: string;
}

class PinPrompt extends Component<{}, PinState> {
  state: PinState = {
    mode: 'unlock',
    pin: '',
    confirmPin: '',
    error: '',
    isProcessing: false,
    promptId: '',
  };

  componentDidMount() {
    const urlParams = new URLSearchParams(window.location.search);
    const urlMode = urlParams.get('mode') as PinMode;
    const id = urlParams.get('id');
    const update: Partial<PinState> = {};
    if (urlMode && ['setup', 'unlock', 'disable'].includes(urlMode)) {
      update.mode = urlMode;
    }
    if (id) {
      update.promptId = id;
    }
    if (Object.keys(update).length) {
      this.setState(update as PinState);
    }
  }

  handlePinChange = (e: any) => {
    const value = e.target.value.replace(/\D/g, '');
    if (value.length <= 6) {
      this.setState({ pin: value, error: '' });
    }
  };

  handleConfirmPinChange = (e: any) => {
    const value = e.target.value.replace(/\D/g, '');
    if (value.length <= 6) {
      this.setState({ confirmPin: value, error: '' });
    }
  };

  validatePin(pinValue: string): boolean {
    if (pinValue.length < 4 || pinValue.length > 6) {
      this.setState({ error: 'PIN must be between 4 and 6 digits' });
      return false;
    }
    return true;
  }

  handleConfirm = async () => {
    const { mode, pin, confirmPin, promptId } = this.state;
    this.setState({ error: '' });

    if (!this.validatePin(pin)) return;

    if (mode === 'setup') {
      if (confirmPin !== pin) {
        this.setState({ error: 'PINs do not match' });
        return;
      }
      if (!this.validatePin(confirmPin)) return;

      this.setState({ isProcessing: true });
      try {
        const currentPrivateKey = await Storage.readActivePrivateKey();
        if (!currentPrivateKey) {
          this.setState({ error: 'No private key found', isProcessing: false });
          return;
        }
        const encryptedKey = await encryptPrivateKey(pin, currentPrivateKey);
        const response = (await browser.runtime.sendMessage({
          type: 'setupPin', pin, encryptedKey, id: promptId
        })) as PinMessageResponse;

        if (response && response.success) {
          this.setState({ pin: '', confirmPin: '' });
          window.close();
        } else {
          this.setState({ error: response?.error || 'Failed to enable PIN protection', isProcessing: false, pin: '', confirmPin: '' });
        }
      } catch (error: any) {
        this.setState({ error: error?.message || 'Failed to enable PIN protection', isProcessing: false, pin: '', confirmPin: '' });
      }
    } else if (mode === 'unlock') {
      this.setState({ isProcessing: true });
      try {
        const response = (await browser.runtime.sendMessage({
          type: 'verifyPin', pin, id: promptId
        })) as PinMessageResponse;
        if (response && response.success) {
          this.setState({ pin: '' });
          window.close();
        } else {
          this.setState({ error: response?.error || 'Incorrect PIN', isProcessing: false, pin: '' });
        }
      } catch (error: any) {
        this.setState({ error: error?.message || 'Failed to verify PIN', isProcessing: false, pin: '' });
      }
    } else if (mode === 'disable') {
      this.setState({ isProcessing: true });
      try {
        const response = (await browser.runtime.sendMessage({
          type: 'disablePin', pin, id: promptId
        })) as PinMessageResponse | undefined;
        if (response && response.success) {
          this.setState({ pin: '' });
          window.close();
        } else {
          this.setState({ error: (response && response.error) || 'Incorrect PIN', isProcessing: false, pin: '' });
        }
      } catch (error: any) {
        this.setState({ error: error?.message || 'Failed to disable PIN protection', isProcessing: false, pin: '' });
      }
    }
  };

  handleKeyPress = (e: any) => {
    if (e.key === 'Enter') this.handleConfirm();
  };

  getTitle() {
    switch (this.state.mode) {
      case 'setup': return 'Set up PIN Protection';
      case 'unlock': return 'Enter PIN';
      case 'disable': return 'Disable PIN Protection';
      default: return 'Enter PIN';
    }
  }

  getDescription() {
    switch (this.state.mode) {
      case 'setup': return 'Enter a PIN to protect your private keys. You will need to enter this PIN each time you use the extension.';
      case 'unlock': return 'Enter your PIN to unlock your private keys.';
      case 'disable': return 'Enter your PIN to disable PIN protection. Your keys will be stored unencrypted.';
      default: return '';
    }
  }

  render() {
    const { mode, pin, confirmPin, error, isProcessing } = this.state;
    return (
      <>
        <header>
          <h1>{this.getTitle()}</h1>
          <p>{this.getDescription()}</p>
        </header>
        <main>
          {error && (
            <div className="alert warning" role="alert">
              {error}
            </div>
          )}
          <div className="form-field">
            <label htmlFor="pin-input">PIN (4-6 digits):</label>
            <input
              id="pin-input"
              type="password"
              value={pin}
              maxLength={6}
              onInput={this.handlePinChange}
              onKeyPress={this.handleKeyPress}
              disabled={isProcessing}
              autoFocus
            />
          </div>
          {mode === 'setup' && (
            <div className="form-field">
              <label htmlFor="confirm-pin-input">Confirm PIN:</label>
              <input
                id="confirm-pin-input"
                type="password"
                value={confirmPin}
                maxLength={6}
                onInput={this.handleConfirmPinChange}
                onKeyPress={this.handleKeyPress}
                disabled={isProcessing}
              />
            </div>
          )}
          <div className="action-buttons">
            <button
              onClick={this.handleConfirm}
              disabled={isProcessing || pin.length < 4 || (mode === 'setup' && confirmPin !== pin)}
              className="button button-success"
            >
              {mode === 'setup'
                ? 'Enable PIN Protection'
                : mode === 'disable'
                  ? 'Disable Protection'
                  : 'Unlock'}
            </button>
          </div>
        </main>
      </>
    );
  }
}

render(<PinPrompt />, document.getElementById('main'));
