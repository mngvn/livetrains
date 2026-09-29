import { useEffect, useState } from 'react';

/**
 * Shares a link the way the device prefers.
 *
 * On a phone that is the system share sheet — straight into Messages or
 * WhatsApp. Elsewhere it copies the link and says so. Either way it is one
 * tap, and nothing is sent anywhere by this app.
 */
export function ShareButton({
  url,
  title,
  label = 'Share',
  className = 'chip',
  note,
}: {
  url: string;
  title: string;
  label?: string;
  className?: string;
  /** A line shown after sharing, e.g. what the link leaves out. */
  note?: string;
}) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (status === 'idle') return;
    const timer = window.setTimeout(() => setStatus('idle'), 2_500);
    return () => window.clearTimeout(timer);
  }, [status]);

  const share = async () => {
    // Only where it is a real share sheet: desktop browsers that expose
    // `navigator.share` often open a clumsy dialog for what is really a copy.
    const touch = window.matchMedia?.('(pointer: coarse)').matches;
    if (touch && typeof navigator.share === 'function') {
      try {
        await navigator.share({ title, url });
        return;
      } catch (err) {
        // Dismissing the sheet is not a failure worth reporting.
        if (err instanceof DOMException && err.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
  };

  return (
    <span className="share">
      <button type="button" className={className} onClick={() => void share()}>
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path
            d="M8 10.5V2.2M5 5l3-3 3 3M3.5 8.5v4.8h9V8.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {label}
      </button>
      <span className="share__status" role="status">
        {status === 'copied' && <>Link copied{note ? ` · ${note}` : ''}</>}
        {status === 'failed' && (
          <>
            Copy this link: <input className="share__fallback" readOnly value={url} onFocus={(e) => e.target.select()} />
          </>
        )}
      </span>
    </span>
  );
}
