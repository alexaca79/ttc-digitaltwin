const SECONDS_PER_DAY = 24 * 60 * 60;
const HALF_DAY_SECONDS = SECONDS_PER_DAY / 2;
// Gaps beyond this come from a stale timetable matching an unrelated trip,
// not from a vehicle actually running hours off schedule.
export const MAX_PLAUSIBLE_DEVIATION_SECONDS = 2 * 60 * 60;
const torontoTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Toronto',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export function parseGtfsTime(value: string) {
  const match = /^(\d{1,2}):([0-5]\d):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function torontoSecondOfDay(epochSeconds: number) {
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return null;
  const parts = Object.fromEntries(
    torontoTimeFormatter
      .formatToParts(new Date(epochSeconds * 1000))
      .map((part) => [part.type, part.value])
  );
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  if (![hour, minute, second].every(Number.isFinite)) return null;
  return (hour % 24) * 3600 + minute * 60 + second;
}

export function computeScheduleDeviation(
  predictedEpochSeconds: number,
  scheduledSeconds: number
) {
  const predictedSeconds = torontoSecondOfDay(predictedEpochSeconds);
  if (predictedSeconds == null || !Number.isFinite(scheduledSeconds) || scheduledSeconds < 0) {
    return null;
  }

  const scheduledSecondOfDay = scheduledSeconds % SECONDS_PER_DAY;
  const rawDifference = predictedSeconds - scheduledSecondOfDay;
  const deviation = (
    ((rawDifference + HALF_DAY_SECONDS) % SECONDS_PER_DAY + SECONDS_PER_DAY)
      % SECONDS_PER_DAY
  ) - HALF_DAY_SECONDS;
  return Math.abs(deviation) > MAX_PLAUSIBLE_DEVIATION_SECONDS ? null : deviation;
}

export function medianDeviation(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}