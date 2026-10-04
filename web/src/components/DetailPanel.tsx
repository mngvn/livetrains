import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { readableTextColor } from '../lib/format.ts';
import { PLANE_PATH } from '../lib/planeInfo.ts';

/**
 * The right-hand panel: one stop, vehicle or aircraft, whatever was last chosen.
 *
 * Deliberately its own panel, on the other side of the map from the
 * planner, with its own frame and heading — it answers "what is this thing"
 * while the left panel carries on answering "how do I get there". It stays
 * open as the rider taps from stop to vehicle to stop, swapping its contents
 * in place, and closes only when asked (the × or Escape).
 *
 * On a narrow screen there is no room for two panels, so opening this one
 * slides the left one away rather than stacking or squeezing them; the
 * layout for that lives in the stylesheet, keyed off `.app.has-detail`.
 */
export function DetailPanel({
  kind,
  selectionKey,
  accent,
  onClose,
  children,
}: {
  kind: 'stop' | 'vehicle' | 'plane';
  /** Changes when a different stop or vehicle is chosen. */
  selectionKey: string;
  /** The selected vehicle's route colour, as hex without '#', for the frame. */
  accent?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);

  // Escape closes it, unless focus is in a field that wants the key itself.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (document.querySelector('.onboarding')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // A new selection starts at the top, not wherever the last one was scrolled.
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [selectionKey]);

  return (
    <aside
      className={`detail detail--${kind}${accent ? ' has-accent' : ''}`}
      aria-label={KINDS[kind].label}
      // A vehicle's panel wears its route's colour as its header band, the
      // way the line is signed on the vehicle itself.
      style={
        accent
          ? ({ '--detail-accent': `#${accent}`, '--detail-ink': readableTextColor(accent) } as CSSProperties)
          : undefined
      }
    >
      <div className="detail__bar">
        <span className="detail__kind">
          {KINDS[kind].icon}
          {KINDS[kind].name}
        </span>
        <button type="button" className="icon-button detail__close" onClick={onClose} aria-label="Close details">
          ×
        </button>
      </div>
      <div className="detail__body" ref={bodyRef}>
        {children}
      </div>
    </aside>
  );
}

const KINDS = {
  stop: { name: 'Stop', label: 'Stop details', icon: <StopIcon /> },
  vehicle: { name: 'Vehicle', label: 'Vehicle details', icon: <VehicleIcon /> },
  plane: { name: 'Aircraft', label: 'Aircraft details', icon: <PlaneIcon /> },
};

function PlaneIcon() {
  return (
    <svg viewBox="0 0 40 40" width="14" height="14" aria-hidden="true">
      <path d={PLANE_PATH} fill="currentColor" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path d="M8 1.5a4.8 4.8 0 0 0-4.8 4.8c0 3.6 4.8 8.2 4.8 8.2s4.8-4.6 4.8-8.2A4.8 4.8 0 0 0 8 1.5Z" fill="currentColor" />
      <circle cx="8" cy="6.3" r="1.8" fill="var(--surface)" />
    </svg>
  );
}

function VehicleIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <rect x="3" y="2" width="10" height="10" rx="2.5" fill="currentColor" />
      <rect x="4.6" y="3.6" width="6.8" height="3.4" rx="0.8" fill="var(--surface)" />
      <circle cx="5.6" cy="9.6" r="0.9" fill="var(--surface)" />
      <circle cx="10.4" cy="9.6" r="0.9" fill="var(--surface)" />
      <path d="M5 12v1.6M11 12v1.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
