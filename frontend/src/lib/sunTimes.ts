// Sunrise and sunset for a place and a local day, computed in the browser:
// no network, no location permission. The usual almanac algorithm (accurate
// to a minute or two), which is plenty for switching the app's theme.
// Plain functions with no React or browser dependency, so tests can load them.

// The lab: Aizu-Wakamatsu, Fukushima.
export const LAB_LOCATION = { latitude: 37.5236, longitude: 139.9381 };

// Official sunrise/sunset: the sun's centre 50' below the horizon.
const ZENITH = 90.833;

const rad = (deg: number) => (deg * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const wrap = (value: number, range: number) => ((value % range) + range) % range;

function dayOfYear(date: Date) {
  const start = Date.UTC(date.getFullYear(), 0, 0);
  const today = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((today - start) / 86_400_000);
}

/**
 * The moment of sunrise (rising) or sunset on `date`'s local calendar day,
 * or null when the sun does not rise or set that day (polar day/night).
 */
export function sunEvent(date: Date, rising: boolean, location = LAB_LOCATION): Date | null {
  const { latitude, longitude } = location;
  const lngHour = longitude / 15;
  const t = dayOfYear(date) + ((rising ? 6 : 18) - lngHour) / 24;
  const meanAnomaly = 0.9856 * t - 3.289;
  const trueLongitude = wrap(
    meanAnomaly + 1.916 * Math.sin(rad(meanAnomaly)) + 0.02 * Math.sin(rad(2 * meanAnomaly)) + 282.634,
    360,
  );
  let rightAscension = wrap(deg(Math.atan(0.91764 * Math.tan(rad(trueLongitude)))), 360);
  rightAscension += Math.floor(trueLongitude / 90) * 90 - Math.floor(rightAscension / 90) * 90;
  rightAscension /= 15;
  const sinDec = 0.39782 * Math.sin(rad(trueLongitude));
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosHour = (Math.cos(rad(ZENITH)) - sinDec * Math.sin(rad(latitude))) / (cosDec * Math.cos(rad(latitude)));
  if (cosHour > 1 || cosHour < -1) return null;
  const hourAngle = (rising ? 360 - deg(Math.acos(cosHour)) : deg(Math.acos(cosHour))) / 15;
  const localMeanTime = hourAngle + rightAscension - 0.06571 * t - 6.622;
  const utcHours = wrap(localMeanTime - lngHour, 24);

  // UTC hours on the local day's UTC date can land on the neighbouring local
  // day (Japan's sunrise is the previous evening in UTC): pull it back in.
  const localMidnight = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  let when = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) + utcHours * 3_600_000;
  while (when < localMidnight) when += 86_400_000;
  while (when >= localMidnight + 86_400_000) when -= 86_400_000;
  return new Date(when);
}

/** Whether it is daytime at `now`, and when that next changes. */
export function daylightAt(now: Date, location = LAB_LOCATION): { day: boolean; nextChange: Date | null } {
  const sunrise = sunEvent(now, true, location);
  const sunset = sunEvent(now, false, location);
  // Polar day or night never happens at the lab; stay light and do not switch.
  if (!sunrise || !sunset) return { day: true, nextChange: null };
  if (now < sunrise) return { day: false, nextChange: sunrise };
  if (now < sunset) return { day: true, nextChange: sunset };
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { day: false, nextChange: sunEvent(tomorrow, true, location) };
}
