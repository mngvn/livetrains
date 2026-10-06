import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * A four-card introduction, shown once.
 *
 * Kept short and skippable on every card: the map is already live behind it,
 * and anyone who wants to poke at it should be able to. The last card offers
 * to play a real trip, because watching one journey unfold explains the app
 * faster than any paragraph could.
 */

interface Step {
  title: string;
  body: ReactNode;
  art: ReactNode;
}

const STEPS: Step[] = [
  {
    title: 'Every bus and train, live',
    body: (
      <>
        Each dot is a vehicle, coloured by its route — rounded squares are trains, circles are buses. Zoom right
        out and the busiest spots gather into counted circles.
      </>
    ),
    art: <ArtVehicles />,
  },
  {
    title: 'Tap anything',
    body: (
      <>
        Tap a vehicle to see where it is heading, how late it is and the stops ahead. Tap a stop for its next
        departures, step-free access and every line that calls there. Or search — “16”, “Blue”, “Nicollet Mall”.
      </>
    ),
    art: <ArtTap />,
  },
  {
    title: 'Plan, save, and get nudged',
    body: (
      <>
        Trips are door to door, with walking along real streets. Save the ones you make often to see how reliably
        they run, and ask for a reminder when it is time to leave.
      </>
    ),
    art: <ArtPlan />,
  },
  {
    title: 'Watch a trip play out',
    body: (
      <>
        Any planned trip can be played back on the map — the walk, the wait, the ride — so you can see the whole
        journey before you set off.
      </>
    ),
    art: <ArtPlay />,
  },
];

export function Onboarding({
  onClose,
  onPlaySample,
  sampleLabel,
}: {
  onClose: () => void;
  /** Absent when this city has no sample trip to offer. */
  onPlaySample?: () => void;
  sampleLabel?: string;
}) {
  const [step, setStep] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const last = step === STEPS.length - 1;
  const current = STEPS[step];

  useEffect(() => {
    primaryRef.current?.focus();
  }, [step]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowRight') setStep((s) => Math.min(s + 1, STEPS.length - 1));
      if (event.key === 'ArrowLeft') setStep((s) => Math.max(s - 1, 0));
      // Keep Tab inside the card while it is open.
      if (event.key === 'Tab' && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>('button');
        const first = focusable[0];
        const end = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          end.focus();
        } else if (!event.shiftKey && document.activeElement === end) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="onboarding" role="presentation">
      <div
        className="onboarding__card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        aria-describedby="onboarding-body"
        ref={dialogRef}
      >
        <button type="button" className="icon-button onboarding__skip" onClick={onClose} aria-label="Skip the introduction">
          ×
        </button>
        <div className="onboarding__art" aria-hidden="true">
          {current.art}
        </div>
        <p className="onboarding__count">
          {step + 1} of {STEPS.length}
        </p>
        <h2 className="onboarding__title" id="onboarding-title">
          {current.title}
        </h2>
        <p className="onboarding__body" id="onboarding-body">
          {current.body}
        </p>

        <div className="onboarding__dots" aria-hidden="true">
          {STEPS.map((s, i) => (
            <span key={s.title} className={`onboarding__dot${i === step ? ' is-active' : ''}`} />
          ))}
        </div>

        <div className="onboarding__actions">
          {step > 0 ? (
            <button type="button" className="chip" onClick={() => setStep(step - 1)}>
              Back
            </button>
          ) : (
            <button type="button" className="chip" onClick={onClose}>
              Skip
            </button>
          )}
          {!last && (
            <button type="button" className="chip chip--primary" ref={primaryRef} onClick={() => setStep(step + 1)}>
              Next
            </button>
          )}
          {last && onPlaySample && (
            <button type="button" className="chip chip--primary" ref={primaryRef} onClick={onPlaySample}>
              ▶ Show me{sampleLabel ? `: ${sampleLabel}` : ''}
            </button>
          )}
          {last && (
            <button
              type="button"
              className={`chip${onPlaySample ? '' : ' chip--primary'}`}
              ref={onPlaySample ? undefined : primaryRef}
              onClick={onClose}
            >
              {onPlaySample ? 'Explore on my own' : 'Start exploring'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* Small illustrations drawn with the map's own marks, so the tour teaches
   the symbols by showing them. */

function ArtVehicles() {
  return (
    <svg viewBox="0 0 240 110" width="240" height="110">
      <path d="M10 90 C 70 90, 90 40, 150 40 L 230 40" stroke="#003da5" strokeWidth="4" fill="none" opacity="0.35" />
      <path d="M10 60 L 230 80" stroke="#00a651" strokeWidth="4" fill="none" opacity="0.35" />
      {[
        [58, 82, '#003da5', true],
        [150, 40, '#003da5', true],
        [100, 69, '#00a651', true],
        [196, 77, '#00a651', true],
        [30, 62, '#0b5fa5', false],
        [215, 40, '#0b5fa5', false],
      ].map(([x, y, color, rail], i) => (
        <g key={i}>
          {rail ? (
            <rect x={Number(x) - 7} y={Number(y) - 7} width="14" height="14" rx="1.5" fill={String(color)} stroke="var(--bg)" strokeWidth="2" />
          ) : (
            <circle cx={Number(x)} cy={Number(y)} r="7" fill={String(color)} stroke="var(--bg)" strokeWidth="2" />
          )}
        </g>
      ))}
    </svg>
  );
}

function ArtTap() {
  return (
    <svg viewBox="0 0 240 110" width="240" height="110">
      <path d="M20 70 L 220 70" stroke="#0b5fa5" strokeWidth="4" opacity="0.35" />
      <circle cx="80" cy="70" r="6" fill="var(--bg)" stroke="var(--text)" strokeWidth="2" />
      <circle cx="160" cy="70" r="18" fill="#0b5fa5" opacity="0.2" />
      <circle cx="160" cy="70" r="8" fill="#0b5fa5" stroke="var(--bg)" strokeWidth="2" />
      <rect x="120" y="12" width="96" height="34" rx="2" fill="var(--surface)" stroke="var(--border)" />
      <rect x="128" y="20" width="22" height="12" rx="3" fill="#0b5fa5" />
      <rect x="156" y="22" width="50" height="4" rx="2" fill="var(--text-muted)" />
      <rect x="156" y="30" width="34" height="4" rx="1" fill="var(--late)" opacity="0.9" />
      <path d="M150 88 l6 -14 l4 10 l6 -2 z" fill="var(--text)" />
    </svg>
  );
}

function ArtPlan() {
  return (
    <svg viewBox="0 0 240 110" width="240" height="110">
      <path d="M30 80 L 60 80" stroke="var(--text-muted)" strokeWidth="5" strokeDasharray="5 4" />
      <path d="M60 80 C 100 80, 110 35, 160 35 L 190 35" stroke="#00a651" strokeWidth="5" fill="none" strokeLinecap="round" />
      <path d="M190 35 L 212 35" stroke="var(--text-muted)" strokeWidth="5" strokeDasharray="5 4" />
      <circle cx="28" cy="80" r="7" fill="var(--text)" stroke="var(--bg)" strokeWidth="2.5" />
      <circle cx="214" cy="35" r="7" fill="var(--danger)" stroke="var(--bg)" strokeWidth="2.5" />
      <text x="120" y="102" textAnchor="middle" fontSize="12" fontWeight="700" fill="var(--live)">
        Leave in 6 min
      </text>
    </svg>
  );
}

function ArtPlay() {
  return (
    <svg viewBox="0 0 240 110" width="240" height="110">
      <path d="M20 80 C 80 80, 100 30, 170 30 L 220 30" stroke="#00a651" strokeWidth="4" fill="none" opacity="0.25" />
      <path d="M20 80 C 60 80, 80 62, 96 52" stroke="#00a651" strokeWidth="6" fill="none" strokeLinecap="round" />
      <circle cx="98" cy="51" r="14" fill="#00a651" opacity="0.22" className="onboarding__pulse" />
      <circle cx="98" cy="51" r="7" fill="#00a651" stroke="var(--bg)" strokeWidth="2.5" />
      <circle cx="120" cy="96" r="10" fill="var(--text)" />
      <path d="M117 91 L 125 96 L 117 101 Z" fill="var(--bg)" />
    </svg>
  );
}
