import type { Vehicle } from '../lib/api.ts';
import { delayText, modeLabel, occupancyLabel, relativeAge } from '../lib/format.ts';
import { RouteBadge } from './RouteBadge.tsx';

/** Details for the vehicle currently selected on the map. */
export function VehiclePanel({ vehicle, onClose }: { vehicle: Vehicle; onClose: () => void }) {
  const delay = delayText(vehicle.delaySeconds);
  const occupancy = occupancyLabel(vehicle.occupancy);

  return (
    <div className="vehicle-panel">
      <header className="panel-header">
        <div className="vehicle-panel__title">
          <RouteBadge
            route={{
              id: vehicle.routeId ?? '',
              shortName: vehicle.routeShortName ?? '—',
              longName: '',
              mode: vehicle.mode,
              color: vehicle.color,
              textColor: 'FFFFFF',
            }}
          />
          <div>
            <h2 className="panel-title">{vehicle.headsign ?? modeLabel(vehicle.mode)}</h2>
            <p className="panel-subtitle">Vehicle {vehicle.id}</p>
          </div>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>

      <dl className="vehicle-facts">
        {vehicle.delaySeconds !== undefined && (
          <div className="vehicle-fact">
            <dt>Status</dt>
            <dd className={`delay-tag delay-tag--${delay.tone}`}>{delay.label}</dd>
          </div>
        )}
        {occupancy && (
          <div className="vehicle-fact">
            <dt>Occupancy</dt>
            <dd>{occupancy}</dd>
          </div>
        )}
        {vehicle.speed !== undefined && (
          <div className="vehicle-fact">
            <dt>Speed</dt>
            <dd>{Math.round(vehicle.speed * 2.237)} mph</dd>
          </div>
        )}
        <div className="vehicle-fact">
          <dt>Reported</dt>
          <dd>{relativeAge(vehicle.timestamp)}</dd>
        </div>
      </dl>
    </div>
  );
}
