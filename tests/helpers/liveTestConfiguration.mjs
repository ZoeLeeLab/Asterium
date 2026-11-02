import path from 'node:path';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';

/** Explicitly selected test data only; never fall back to the personal application directory. */
export function requireLiveTestSource(environment = process.env) {
  if (environment.ASTERIUM_API_LIVE_SMOKE !== '1') throw new Error('Set ASTERIUM_API_LIVE_SMOKE=1 to authorize real API tests.');
  const source = environment.ASTERIUM_API_SMOKE_SOURCE_USER_DATA;
  if (!source || !path.isAbsolute(source)) throw new Error('Set ASTERIUM_API_SMOKE_SOURCE_USER_DATA to an explicit absolute test-only user-data directory.');
  const selected = path.resolve(source);
  for (let cursor = selected;; cursor = path.dirname(cursor)) {
    if (lstatSync(cursor).isSymbolicLink()) throw new Error('Live test source must not use directory links.');
    if (path.dirname(cursor) === cursor) break;
  }
  const directory = realpathSync.native(selected);
  const owner = JSON.parse(readFileSync(path.join(directory, '.asterium-profile.v1.json'), 'utf8'));
  if (owner.version !== 1 || !['acceptance', 'autotest'].includes(owner.profile)) throw new Error('An explicitly marked acceptance/autotest source is required; daily and dev sources are forbidden.');
  return directory;
}
