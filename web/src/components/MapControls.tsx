import type { BasemapId } from './basemaps.ts';

/**
 * The two switches that decide what the map looks like.
 *
 * Kept as segmented controls rather than toggles because neither choice has a
 * natural "off": satellite is not the absence of a street map, and 2D is not
 * the absence of 3D. A segment showing both options also says what the other
 * one is, which a switch labelled "3D" does not.
 */
export function MapControls({
  basemap,
  onBasemap,
  three,
  onThree,
}: {
  basemap: BasemapId;
  onBasemap: (id: BasemapId) => void;
  three: boolean;
  onThree: (three: boolean) => void;
}) {
  return (
    <div className="map-controls">
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
  options: { value: T; label: string }[];
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
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
