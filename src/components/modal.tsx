import { createElement } from 'inferno-create-element';

export function Modal({
  show,
  onClose,
  className,
  children
}: {
  show: boolean;
  className?: string;
  onClose: () => void;
  children?: any;
}) {
  const handleOverlayClick = () => {
    if (onClose) onClose();
  };

  return show ? (
    <div className={`modal-wrapper ${className}`}>
      <div className={`modal`}>{children}</div>
      <div className="overlay" onClick={handleOverlayClick}></div>
    </div>
  ) : null;
}
