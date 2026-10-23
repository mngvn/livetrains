import type { ReactNode } from 'react';

export type Tab = 'plan' | 'saved' | 'nearby' | 'routes' | 'status' | 'alerts';

export const TAB_LABELS: Record<Tab, string> = {
  plan: 'Plan',
  saved: 'Saved',
  nearby: 'Nearby',
  routes: 'Routes',
  status: 'Status',
  alerts: 'Alerts',
};

const TABS = Object.keys(TAB_LABELS) as Tab[];

/**
 * The planner's six tabs.
 *
 * On a wide screen they are a strip of words between the search and the
 * panel they switch. On a phone they are the bar along the bottom edge that
 * map and transit apps keep their sections in: an icon over a word for
 * each, evenly spaced, within a thumb's reach, and apart from the panel, so
 * they stay on screen while it is tucked away and double as the way back.
 */
export function TabBar({
  variant,
  tab,
  onSelect,
  savedCount,
  alertCount,
}: {
  variant: 'strip' | 'bar';
  tab: Tab;
  onSelect: (tab: Tab) => void;
  savedCount: number;
  alertCount: number;
}) {
  const bar = variant === 'bar';
  return (
    <nav className={bar ? 'tabbar' : 'tabs'} role="tablist">
      {TABS.map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={tab === id}
          aria-controls="livetrains-panel"
          className={`${bar ? 'tabbar__tab' : 'tab'}${tab === id ? ' is-active' : ''}`}
          onClick={() => onSelect(id)}
        >
          {bar ? (
            <>
              <span className="tabbar__icon" aria-hidden="true">
                {ICONS[id]}
              </span>
              {TAB_LABELS[id]}
              {/* Only what needs attention gets a badge on a phone: how many
                  trips are saved is no reason to look. */}
              {id === 'alerts' && alertCount > 0 && (
                <span className="tabbar__badge" aria-label={`${alertCount} in effect`}>
                  {alertCount}
                </span>
              )}
            </>
          ) : (
            <>
              {TAB_LABELS[id]}
              {id === 'saved' && savedCount > 0 && (
                <span className="tab__count tab__count--quiet" aria-label={`${savedCount} saved`}>
                  {savedCount}
                </span>
              )}
              {id === 'alerts' && alertCount > 0 && (
                <span className="tab__count" aria-label={`${alertCount} in effect`}>
                  {alertCount}
                </span>
              )}
            </>
          )}
        </button>
      ))}
    </nav>
  );
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

const ICONS: Record<Tab, ReactNode> = {
  // A way from here to there.
  plan: (
    <Icon>
      <circle cx="6" cy="18" r="2.2" />
      <circle cx="18" cy="6" r="2.2" />
      <path d="M8.2 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.8" />
    </Icon>
  ),
  saved: (
    <Icon>
      <path d="m12 3.6 2.6 5.3 5.8.85-4.2 4.1 1 5.8L12 16.9l-5.2 2.75 1-5.8-4.2-4.1 5.8-.85Z" />
    </Icon>
  ),
  nearby: (
    <Icon>
      <path d="M19.5 4.5 4.5 10.8l6.3 2.4 2.4 6.3Z" />
    </Icon>
  ),
  // The front of a bus, the way a line is signed.
  routes: (
    <Icon>
      <rect x="5" y="3.5" width="14" height="14" rx="3" />
      <path d="M5 10.5h14M8 17.5v2.5M16 17.5v2.5" />
      <path d="M8.5 14h.01M15.5 14h.01" strokeWidth="2.4" />
    </Icon>
  ),
  // A pulse: how the network is doing.
  status: (
    <Icon>
      <path d="M3 12h4l2.5-6 5 12 2.5-6H21" />
    </Icon>
  ),
  alerts: (
    <Icon>
      <path d="M12 4 21 19.5H3Z" />
      <path d="M12 10v4M12 16.9h.01" />
    </Icon>
  ),
};
