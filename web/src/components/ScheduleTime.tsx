import { clockTime, delayText } from '../lib/format.ts';

/**
 * A stop time, as scheduled and as predicted.
 *
 * Riders read these two numbers differently. The scheduled time is the one on
 * the pole and in their head; the predicted one is when to actually be there.
 * Showing only the prediction hides that the bus is late, and showing only the
 * schedule hides when it will arrive — so when they differ by a minute or more
 * both are shown, the timetable one struck through, which is the convention
 * people already know from departure boards.
 *
 * Under a minute apart they are the same time to anyone standing at a stop,
 * and showing two would just be noise.
 */
export function ScheduleTime({
  scheduled,
  predicted,
  delaySeconds,
  isRealtime,
  skipped,
}: {
  scheduled: number;
  predicted: number;
  delaySeconds: number | null | undefined;
  isRealtime: boolean;
  skipped?: boolean;
}) {
  if (skipped) {
    return (
      <span className="schedule-time">
        <s className="schedule-time__scheduled">{clockTime(scheduled)}</s>
        <span className="delay-tag delay-tag--skipped">Not stopping</span>
      </span>
    );
  }

  const delay = delayText(isRealtime ? delaySeconds : null);
  const differs = isRealtime && Math.abs(predicted - scheduled) >= 60;
  const label = differs
    ? `Scheduled ${clockTime(scheduled)}, now expected ${clockTime(predicted)}`
    : `${isRealtime ? 'Expected' : 'Scheduled'} ${clockTime(isRealtime ? predicted : scheduled)}`;

  return (
    <span className="schedule-time" aria-label={`${label}, ${delay.label.toLowerCase()}`}>
      {differs ? (
        <>
          <s className="schedule-time__scheduled" aria-hidden="true">
            {clockTime(scheduled)}
          </s>
          <span className="schedule-time__predicted" aria-hidden="true">
            {clockTime(predicted)}
          </span>
        </>
      ) : (
        <span className={isRealtime ? 'schedule-time__predicted' : undefined} aria-hidden="true">
          {clockTime(isRealtime ? predicted : scheduled)}
        </span>
      )}
      <span className={`delay-tag delay-tag--${delay.tone}`} aria-hidden="true">
        {delay.label}
      </span>
    </span>
  );
}
