import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ThemeChoice } from '../lib/theme.ts';
import type { BasemapId } from './basemaps.ts';

/**
 * The switches that decide what the map looks like.
 *
 * Kept as segmented controls rather than toggles because none of these
 * choices has a natural "off": satellite is not the absence of a street map,
 * and 2D is not the absence of 3D. A segment showing every option also says
 * what the others are, which a switch labelled "3D" does not.
 */
export function MapControls({
  basemap,
  onBasemap,
  three,
  onThree,
  theme,
  onTheme,
}: {
  basemap: BasemapId;
  onBasemap: (id: BasemapId) => void;
  three: boolean;
  onThree: (three: boolean) => void;
  theme: ThemeChoice;
  onTheme: (theme: ThemeChoice) => void;
}) {
  // On a phone the three switches fold behind one button: stacked down the
  // side of a small screen they covered more of the map than they controlled.
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  return (
    <div className={`map-controls${open ? ' is-open' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="map-controls__toggle"
        aria-expanded={open}
        aria-controls="map-view-options"
        onClick={() => setOpen((value) => !value)}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M8 1.8 14.2 5 8 8.2 1.8 5Z" fill="currentColor" />
          <path
            d="m1.8 8 6.2 3.2L14.2 8M1.8 11l6.2 3.2 6.2-3.2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
        View
      </button>
      <div className="map-controls__panel" id="map-view-options">
        <Segmented
          label="Basemap"
          options={[
            { value: 'streets' as const, label: 'Map' },
            { value: 'satellite' as const, label: 'Satellite' },
          ]}
          value={basemap}
          onChange={onBasemap}
        />
        <Segmented
          label="Dimension"
          options={[
            { value: false, label: '2D' },
            { value: true, label: '3D' },
          ]}
          value={three}
          onChange={onThree}
        />
        <Segmented
          label="Theme"
          options={[
            { value: 'dark' as const, label: <MoonIcon />, name: 'Dark' },
            { value: 'auto' as const, label: <AutoIcon />, name: 'Auto: dark after sunset' },
            { value: 'light' as const, label: <SunIcon />, name: 'Light' },
          ]}
          value={theme}
          onChange={onTheme}
        />
      </div>
    </div>
  );
}

function Segmented<T extends string | boolean>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  /** `name` is required wherever `label` is an icon rather than words. */
  options: { value: T; label: ReactNode; name?: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          className="segmented__option"
          // A radio group in spirit; `aria-pressed` is what a toolbar of
          // buttons uses to say which one is currently in effect.
          aria-pressed={option.value === value}
          aria-label={option.name}
          title={option.name}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle cx="8" cy="8" r="3" fill="currentColor" />
      <path
        d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M3.2 12.8l1.1-1.1M11.7 4.3l1.1-1.1"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M13.4 10.2A5.8 5.8 0 0 1 5.8 2.6a5.8 5.8 0 1 0 7.6 7.6Z" fill="currentColor" />
    </svg>
  );
}

/** Half light, half dark: "whatever this device is doing". */
function AutoIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 2.4a5.6 5.6 0 0 1 0 11.2Z" fill="currentColor" />
    </svg>
  );
}
