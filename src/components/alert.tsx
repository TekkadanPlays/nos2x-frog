import { createElement } from 'inferno-create-element';

import InformationCircleIcon from '../assets/icons/information-circle-outline.svg';
import CheckmarkCircleIcon from '../assets/icons/checkmark-circle-outline.svg';
import WarningDiceIcon from '../assets/icons/warning-outline.svg';

export function Alert({ message, type }: { message: string; type: string }) {
  return (
    <div className={`alert ${type}`}>
      {type == 'info' ? (
        <InformationCircleIcon />
      ) : type == 'warning' ? (
        <WarningDiceIcon />
      ) : (
        <CheckmarkCircleIcon />
      )}
      {message}
    </div>
  );
}
