import { useRef } from 'react';

/** How far a finger has to pull the handle down before the sheet goes. */
const SWIPE_PX = 24;

/**
 * The handle along the top of the phone's bottom sheet.
 *
 * It looks like what it is on every phone: something to pull. A tap or a
 * pull downwards tucks the sheet away; the tab bar brings it back.
 */
export function SheetGrabber({ onHide }: { onHide: () => void }) {
  const startY = useRef<number | null>(null);
  /** Set once a pull has hidden the sheet, so the tap that ends it does not count twice. */
  const pulled = useRef(false);

  return (
    <button
      type="button"
      className="sheet__grabber"
      aria-label="Hide the panel"
      title="Hide the panel"
      onPointerDown={(event) => {
        startY.current = event.clientY;
        pulled.current = false;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (startY.current === null || event.clientY - startY.current < SWIPE_PX) return;
        startY.current = null;
        pulled.current = true;
        onHide();
      }}
      onPointerUp={() => {
        startY.current = null;
      }}
      onPointerCancel={() => {
        startY.current = null;
      }}
      onClick={() => {
        if (pulled.current) {
          pulled.current = false;
          return;
        }
        onHide();
      }}
    />
  );
}
