import {
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { X } from 'lucide-react';
import { hintText, keys } from './platform';
export function Button({
  children,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={className} {...props}>
      {children}
    </button>
  );
}
export function IconButton({
  label,
  shortcut,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; shortcut?: string }) {
  return (
    <button
      className="icon-button"
      aria-label={label}
      title={shortcut ? `${label} (${keys(shortcut)})` : label}
      {...props}
    >
      {children}
    </button>
  );
}
export function Toolbar({ children, label = 'Tools' }: { children: ReactNode; label?: string }) {
  return (
    <div role="toolbar" aria-label={label} className="toolbar">
      {children}
    </div>
  );
}
export function Tooltip({
  children,
  label,
  shortcut,
}: {
  children: ReactNode;
  label: string;
  shortcut?: string;
}) {
  return (
    <span className="tooltip-wrap">
      {children}
      <span role="tooltip">
        {label}
        {shortcut && ` (${keys(shortcut)})`}
      </span>
    </span>
  );
}
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="segmented">
      {options.map((o) => (
        <button key={o} aria-pressed={value === o} onClick={() => onChange(o)}>
          {o}
        </button>
      ))}
    </div>
  );
}
export function Dialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const el = ref.current;
    el?.querySelector<HTMLElement>('input,button,select,[tabindex]')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
      }
      if (e.key === 'Tab') {
        const items = Array.from(
          el?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input,select,textarea,[tabindex="0"]',
          ) || [],
        );
        const first = items[0],
          last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    el?.addEventListener('keydown', key);
    return () => {
      el?.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={ref} className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <IconButton label="Close dialog" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </header>
        {children}
      </div>
    </div>
  );
}
export function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel">
      <h2 className="panel-title">{title}</h2>
      {children}
    </section>
  );
}
export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="empty-state">
      {typeof children === 'string' ? hintText(children) : children}
    </div>
  );
}
export function NumberInput({
  unit,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { unit?: string }) {
  return (
    <label className="number-input">
      <input type="number" {...props} />
      {unit && <span>{unit}</span>}
    </label>
  );
}
export function Slider(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input type="range" {...props} />;
}
export function ColorPicker(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input type="color" {...props} />;
}
export function Toast({ children }: { children: ReactNode }) {
  return (
    <div className="toast" role="status">
      {typeof children === 'string' ? hintText(children) : children}
    </div>
  );
}
export function Dropdown({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details>
      <summary>{label}</summary>
      <div role="menu">{children}</div>
    </details>
  );
}
export const Menu = Dropdown;
export function ContextMenu({
  x,
  y,
  children,
  onClose,
}: {
  x: number;
  y: number;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', key);
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', key);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      role="menu"
      className="context-menu"
      style={{
        left: Math.min(x, window.innerWidth - 220),
        top: Math.min(y, window.innerHeight - 240),
      }}
    >
      {children}
    </div>
  );
}
export function Tabs({ children }: { children: ReactNode }) {
  return (
    <div role="tablist" className="tabs">
      {children}
    </div>
  );
}
