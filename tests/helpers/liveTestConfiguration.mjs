import path from 'node:path';

/** Explicitly selected test data only; never fall back to the personal application directory. */
export function requireLiveTestSource(environment = process.env) {
  if (environment.ASTERIUM_API_LIVE_SMOKE !== '1') throw new Error('Set ASTERIUM_API_LIVE_SMOKE=1 to authorize real API tests.');
  const source = environment.ASTERIUM_API_SMOKE_SOURCE_USER_DATA;
  if (!source || !path.isAbsolute(source)) throw new Error('Set ASTERIUM_API_SMOKE_SOURCE_USER_DATA to an explicit absolute test-only user-data directory.');
  return path.resolve(source);
}
