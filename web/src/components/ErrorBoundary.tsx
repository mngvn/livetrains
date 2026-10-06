import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * The last line of defence: a render that throws shows a way back, not a
 * blank page.
 *
 * Much of what the app draws comes from other people's data — the agency's
 * feeds, an aircraft database — and one unexpected value in a component
 * would otherwise unmount the whole tree, map and all, with nothing on
 * screen to say so.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('livetrains: the app stopped drawing', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="boot-error" role="alert">
        <h1>livetrains</h1>
        <p>Something went wrong while drawing the app.</p>
        <p className="boot-error__hint">
          <button type="button" className="chip" onClick={() => window.location.reload()}>
            Reload
          </button>
        </p>
      </div>
    );
  }
}
