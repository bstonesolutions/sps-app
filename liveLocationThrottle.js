export const LIVE_LOCATION_MIN_MOVE_METERS = 40;
export const LIVE_LOCATION_HEARTBEAT_MS = 90_000;

const finiteNumber = (value) => {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const toRadians = (degrees) => (degrees * Math.PI) / 180;

export const liveLocationDistanceMeters = (from, to) => {
  const fromLat = finiteNumber(from?.lat);
  const fromLng = finiteNumber(from?.lng);
  const toLat = finiteNumber(to?.lat);
  const toLng = finiteNumber(to?.lng);
  if (fromLat == null || fromLng == null || toLat == null || toLng == null) return Infinity;

  const earthRadiusMeters = 6_371_000;
  const latitudeDelta = toRadians(toLat - fromLat);
  const longitudeDelta = toRadians(toLng - fromLng);
  const fromLatitude = toRadians(fromLat);
  const toLatitude = toRadians(toLat);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(fromLatitude) * Math.cos(toLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadiusMeters * Math.asin(Math.sqrt(haversine));
};

// Accuracy is deliberately grouped into broad bands. Small GPS jitter should not cause a database
// write, but a meaningful transition (for example, reduced/poor accuracy becoming precise enough
// for a driveway arrival) should refresh the public tracking row promptly.
export const liveLocationAccuracyBand = (accuracy) => {
  const meters = finiteNumber(accuracy);
  if (meters == null || meters < 0) return "unknown";
  if (meters <= 20) return "precise";
  if (meters <= 65) return "usable";
  return "coarse";
};

export const shouldWriteLiveLocation = (
  previous,
  sample,
  now = Date.now(),
  {
    minMoveMeters = LIVE_LOCATION_MIN_MOVE_METERS,
    heartbeatMs = LIVE_LOCATION_HEARTBEAT_MS,
  } = {},
) => {
  if (!sample) return false;
  if (!previous) return true;

  const previousStatus = String(previous.status || "active");
  const sampleStatus = String(sample.status || "active");
  if (previousStatus !== sampleStatus) return true;

  if (liveLocationAccuracyBand(previous.accuracy) !== liveLocationAccuracyBand(sample.accuracy)) {
    return true;
  }

  const previousAt = finiteNumber(previous.at);
  const currentAt = finiteNumber(now);
  if (previousAt == null || currentAt == null || currentAt - previousAt >= heartbeatMs) return true;

  return liveLocationDistanceMeters(previous, sample) >= minMoveMeters;
};
