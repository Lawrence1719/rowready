import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, Info, X } from 'lucide-react';

export type ToastKind = 'success' | 'error' | 'info';
export interface ToastNotification {
  id: number;
  message: string;
  kind: ToastKind;
  open: boolean;
  key: string;
}

const EXIT_DURATION = 180;
const MAX_TOASTS = 3;

export function useToasts() {
  const [toasts, setToasts] = useState<ToastNotification[]>([]);
  const nextId = useRef(0);
  const exitTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const notify = useCallback((message: string, kind: ToastKind = 'success', key?: string) => {
    if (!message.trim()) return;
    const toast: ToastNotification = {
      id: ++nextId.current,
      message: message.trim(),
      kind,
      open: true,
      key: key === undefined ? `message:${kind}:${message.trim()}` : `key:${key}`,
    };
    setToasts(current => [...current.filter(item => item.key !== toast.key), toast].slice(-MAX_TOASTS));
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts(current => current.map(toast => toast.id === id ? { ...toast, open: false } : toast));
  }, []);

  const dismissAll = useCallback(() => {
    setToasts(current => current.map(toast => ({ ...toast, open: false })));
  }, []);

  useEffect(() => {
    const present = new Set(toasts.map(toast => toast.id));
    for (const [id, timer] of exitTimers.current) {
      if (!present.has(id)) {
        clearTimeout(timer);
        exitTimers.current.delete(id);
      }
    }
    for (const toast of toasts) {
      if (!toast.open && !exitTimers.current.has(toast.id)) {
        exitTimers.current.set(toast.id, setTimeout(() => {
          exitTimers.current.delete(toast.id);
          setToasts(current => current.filter(item => item.id !== toast.id));
        }, EXIT_DURATION));
      }
    }
  }, [toasts]);

  useEffect(() => () => {
    for (const timer of exitTimers.current.values()) clearTimeout(timer);
    exitTimers.current.clear();
  }, []);

  return { toasts, notify, dismiss, dismissAll };
}

function ToastItem({ toast, paused, onDismiss }: {
  toast: ToastNotification;
  paused: boolean;
  onDismiss: (id: number) => void;
}) {
  const remaining = useRef(toast.kind === 'error' ? 6000 : 4200);

  useEffect(() => {
    if (!toast.open || paused) return;
    const startedAt = Date.now();
    const timer = setTimeout(() => onDismiss(toast.id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt));
    };
  }, [toast.id, toast.open, paused, onDismiss]);

  const Icon = toast.kind === 'error' ? AlertCircle : toast.kind === 'info' ? Info : Check;
  return (
    <li
      className="notification-toast"
      data-testid="notification-toast"
      data-state={toast.open ? 'open' : 'closed'}
      data-kind={toast.kind}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-hidden={!toast.open || undefined}
      inert={!toast.open || undefined}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); onDismiss(toast.id); }
      }}
    >
      <span className="notification-icon"><Icon aria-hidden="true" /></span>
      <span className="notification-message">{toast.message}</span>
      <button className="notification-close" type="button" aria-label="Dismiss notification" onClick={() => onDismiss(toast.id)} disabled={!toast.open}>
        <X aria-hidden="true" />
      </button>
    </li>
  );
}

export function Toaster({ toasts, onDismiss }: {
  toasts: ToastNotification[];
  onDismiss: (id: number) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [windowBlurred, setWindowBlurred] = useState(false);
  const viewport = useRef<HTMLOListElement>(null);

  useEffect(() => {
    // Removing a focused toast does not reliably dispatch blur in every browser.
    const active = document.activeElement;
    setFocused(Boolean(active && viewport.current?.contains(active) && active.closest('[data-state="open"]')));
    if (!toasts.some(toast => toast.open)) setHovered(false);
  }, [toasts]);

  useEffect(() => {
    const pause = () => setWindowBlurred(true);
    const resume = () => setWindowBlurred(false);
    window.addEventListener('blur', pause);
    window.addEventListener('focus', resume);
    return () => {
      window.removeEventListener('blur', pause);
      window.removeEventListener('focus', resume);
    };
  }, []);

  return (
    <ol
      ref={viewport}
      className="notification-viewport"
      data-toast-viewport=""
      aria-label="Notifications"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      {toasts.map(toast => <ToastItem key={toast.id} toast={toast} paused={hovered || focused || windowBlurred} onDismiss={onDismiss} />)}
    </ol>
  );
}
