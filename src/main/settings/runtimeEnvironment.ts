import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BETA_APP_ID, BETA_DATA_DIRECTORY } from '../../shared/appRelease';
import type { RuntimeEnvironment, RuntimeProfile } from '../../shared/runtimeEnvironment';
import type { App } from 'electron';

export const PROFILE_MARKER = '.asterium-profile.v1.json';
const dailyLocationFile = `${BETA_DATA_DIRECTORY}-location.v1.json`;
const labels: Record<RuntimeProfile, string> = { daily: '星丛 Asterium', dev: '星丛 Asterium · 开发版', acceptance: '星丛 Asterium · 候选验收', autotest: '星丛 Asterium · 自动测试' };

export interface RuntimeEnvironmentOptions {
  isPackaged: boolean;
  appData: string;
  localAppData: string;
  documents: string;
  temp: string;
  profile?: string;
  userData?: string;
  acceptanceBatch?: string;
  mcpPort?: string;
  backgroundServices?: boolean;
}

/** Resolve existing ancestors as well as a not-yet-created leaf. Never reads business data. */
export function canonicalDirectory(directory: string): { directory: string; linked: boolean } {
  const absolute = path.resolve(directory);
  let cursor = absolute;
  const missing: string[] = [];
  for (;;) {
    try {
      const stat = lstatSync(cursor);
      if (!stat.isDirectory() && !stat.isSymbolicLink()) throw new Error('ASTERIUM_PROFILE_NOT_DIRECTORY');
      if (stat.isSymbolicLink()) {
        try { realpathSync.native(cursor); } catch { throw new Error('ASTERIUM_PROFILE_UNRESOLVED_LINK'); }
      }
      const directory = path.join(realpathSync.native(cursor), ...missing);
      let linked = false;
      for (let ancestor = cursor;; ancestor = path.dirname(ancestor)) {
        if (lstatSync(ancestor).isSymbolicLink()) linked = true; // Includes Windows junctions.
        if (path.dirname(ancestor) === ancestor) break;
      }
      return { directory, linked };
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missing.unshift(path.basename(cursor)); cursor = parent;
    }
  }
}

function within(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function readDailyLocation(appData: string): string | undefined {
  const file = path.join(appData, dailyLocationFile);
  let stat;
  try { stat = lstatSync(file); }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
  if (!stat.isFile() || stat.size > 32768) throw new Error('应用资料目录配置无效。');
  const saved: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!saved || typeof saved !== 'object' || !('version' in saved) || saved.version !== 1 ||
    !('directory' in saved) || typeof saved.directory !== 'string' || !path.isAbsolute(saved.directory)) {
    throw new Error('应用资料目录配置无效。');
  }
  return saved.directory;
}

function requireSavedDailyDirectory(directory: string) {
  try {
    const canonical = canonicalDirectory(directory).directory;
    if (path.relative(directory, canonical) || markerAt(canonical)?.profile !== 'daily') throw new Error('DAILY_DIRECTORY_CHANGED');
  } catch {
    throw new Error(`无法使用已选的应用资料目录：${directory}\n请确认磁盘已连接。需要改选时，可用 --user-data-dir 指定已有资料目录启动。`);
  }
}

export function resolveRuntimeEnvironment(options: RuntimeEnvironmentOptions): RuntimeEnvironment {
  const selected = options.profile ?? (options.isPackaged ? 'daily' : 'dev');
  if (!Object.hasOwn(labels, selected)) throw new Error('ASTERIUM_PROFILE_INVALID');
  const profile = selected as RuntimeProfile;
  if (options.userData !== undefined && !options.userData.trim()) throw new Error('ASTERIUM_PROFILE_ABSOLUTE_DIRECTORY_REQUIRED');
  let requested = options.userData;
  const savedDaily = profile === 'daily' && !requested ? readDailyLocation(options.appData) : undefined;
  if (requested && profile !== 'daily' && !path.isAbsolute(requested)) throw new Error('ASTERIUM_PROFILE_ABSOLUTE_DIRECTORY_REQUIRED');
  if (!requested) {
    if (profile === 'daily') {
      if (savedDaily) requireSavedDailyDirectory(savedDaily);
      requested = savedDaily ?? path.join(options.appData, BETA_DATA_DIRECTORY);
    }
    else if (profile === 'dev') requested = path.join(options.localAppData, 'Asterium-Dev');
    else if (profile === 'acceptance') {
      if (!options.acceptanceBatch || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(options.acceptanceBatch)) throw new Error('ASTERIUM_ACCEPTANCE_BATCH_REQUIRED');
      requested = path.join(options.localAppData, 'Asterium-Test', options.acceptanceBatch);
    } else throw new Error('ASTERIUM_AUTOTEST_DIRECTORY_REQUIRED');
  }
  const canonical = canonicalDirectory(requested);
  if (profile !== 'daily') {
    if (canonical.linked) throw new Error('ASTERIUM_PROFILE_LINKED_DIRECTORY');
    const defaultDaily = canonicalDirectory(path.join(options.appData, BETA_DATA_DIRECTORY)).directory;
    if (within(defaultDaily, canonical.directory) || within(canonical.directory, defaultDaily)) throw new Error('ASTERIUM_PROFILE_DAILY_DIRECTORY');
  }
  if (profile === 'autotest') {
    const root = canonicalDirectory(path.join(options.temp, 'Asterium-AutoTest')).directory;
    if (!within(root, canonical.directory) || path.relative(root, canonical.directory).split(path.sep).length < 3) throw new Error('ASTERIUM_AUTOTEST_DIRECTORY_REQUIRED');
  }
  if (profile === 'acceptance' && !options.mcpPort) throw new Error('ASTERIUM_ACCEPTANCE_PORT_REQUIRED');
  const port = options.mcpPort === undefined ? (profile === 'daily' ? 17361 : profile === 'dev' ? 17362 : 0) : Number(options.mcpPort);
  if ((options.mcpPort !== undefined && !/^\d+$/.test(options.mcpPort)) || !Number.isSafeInteger(port) || (port !== 0 && (port < 1024 || port > 65535)) || (port === 0 && profile !== 'autotest')) throw new Error('ASTERIUM_PROFILE_PORT_INVALID');
  const userDataDirectory = canonical.directory;
  return {
    profile, label: labels[profile], userDataDirectory,
    projectsDirectory: profile === 'daily' ? path.join(options.documents, 'Asterium Projects') : path.join(userDataDirectory, 'Projects'),
    temporaryDirectory: path.join(userDataDirectory, 'runtime-temp'),
    appUserModelId: profile === 'daily' ? BETA_APP_ID : `${BETA_APP_ID}.${profile}.${createHash('sha256').update(process.platform === 'win32' ? userDataDirectory.toLowerCase() : userDataDirectory).digest('hex').slice(0, 16)}`,
    allowStartup: profile === 'daily' && options.isPackaged,
    allowUpdates: profile === 'daily' && options.isPackaged,
    restoreBackgroundServices: profile === 'daily' || options.backgroundServices === true,
    mcpPort: port,
  };
}

function markerAt(directory: string): { version: 1; profile: RuntimeProfile } | undefined {
  const file = path.join(directory, PROFILE_MARKER);
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('ASTERIUM_PROFILE_MARKER_INVALID');
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('profile' in value) || typeof value.profile !== 'string' || !Object.hasOwn(labels, value.profile)) throw new Error('ASTERIUM_PROFILE_MARKER_INVALID');
    return value as { version: 1; profile: RuntimeProfile };
  } catch (error) { if (isMissing(error)) return undefined; throw error; }
}

export function inspectDailyDataDirectory(appData: string, selected: string) {
  const { directory } = canonicalDirectory(selected);
  if (directory === path.parse(directory).root || within(directory, canonicalDirectory(appData).directory) || !lstatSync(directory).isDirectory()) {
    throw new Error('请选择单独的文件夹作为应用资料目录。');
  }
  accessSync(directory, constants.R_OK | constants.W_OK);
  const owner = markerAt(directory);
  if (owner && owner.profile !== 'daily') throw new Error('此文件夹属于其他星丛运行环境。');
  for (let ancestor = path.dirname(directory);; ancestor = path.dirname(ancestor)) {
    if (markerAt(ancestor)) throw new Error('请选择星丛资料根目录。');
    if (path.dirname(ancestor) === ancestor) break;
  }
  const entries = readdirSync(directory, { withFileTypes: true });
  const existing = owner !== undefined || entries.some(entry =>
    (entry.isDirectory() && entry.name === 'AsteriumData') || (entry.isFile() && entry.name === 'general-settings.v1.json'));
  if (!existing && entries.length) throw new Error('请选择已有的星丛资料根目录，或选择一个空文件夹。');
  return { directory, existing };
}

export function saveDailyDataDirectory(appData: string, selected: { directory: string; existing: boolean }) {
  const current = inspectDailyDataDirectory(appData, selected.directory);
  if (path.relative(selected.directory, current.directory) || selected.existing !== current.existing) {
    throw new Error('资料目录在确认期间发生变化，请重新选择。');
  }
  const marker = path.join(current.directory, PROFILE_MARKER);
  if (!markerAt(current.directory)) writeFileSync(marker, JSON.stringify({ version: 1, profile: 'daily' }), { flag: 'wx', mode: 0o600 });
  const file = path.join(appData, dailyLocationFile);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ version: 1, directory: current.directory }), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* Preserve the original write error. */ }
    throw error;
  }
}

/** Called before constructing any settings, credentials, runtimes or windows. */
export function prepareRuntimeEnvironment(environment: RuntimeEnvironment) {
  const target = environment.userDataDirectory;
  const current = canonicalDirectory(target);
  if (current.directory !== target || (environment.profile !== 'daily' && current.linked)) throw new Error('ASTERIUM_PROFILE_DIRECTORY_CHANGED');
  if (environment.profile !== 'daily') for (const child of ['runtime-temp', 'logs', 'crash-dumps', 'Projects']) {
    if (canonicalDirectory(path.join(target, child)).linked) throw new Error('ASTERIUM_PROFILE_LINKED_DIRECTORY');
  }
  for (let cursor = target;; cursor = path.dirname(cursor)) {
    const owner = markerAt(cursor);
    if (owner && owner.profile !== environment.profile) throw new Error('ASTERIUM_PROFILE_OWNER_MISMATCH');
    if (path.dirname(cursor) === cursor) break;
  }
  mkdirSync(target, { recursive: true });
  const after = canonicalDirectory(target);
  if (after.directory !== target || (environment.profile !== 'daily' && after.linked)) throw new Error('ASTERIUM_PROFILE_DIRECTORY_CHANGED');
  const owner = markerAt(target);
  if (owner && owner.profile !== environment.profile) throw new Error('ASTERIUM_PROFILE_OWNER_MISMATCH');
  if (!owner) {
    if (environment.profile !== 'daily' && readdirSync(target).length) throw new Error('ASTERIUM_PROFILE_UNCLAIMED_DIRECTORY');
    try { writeFileSync(path.join(target, PROFILE_MARKER), JSON.stringify({ version: 1, profile: environment.profile }), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST') || markerAt(target)?.profile !== environment.profile) throw error;
    }
  }
}

export function activateRuntimeEnvironment(app: Pick<App, 'setPath' | 'setAppLogsPath'>, options: RuntimeEnvironmentOptions) {
  const environment = resolveRuntimeEnvironment(options);
  prepareRuntimeEnvironment(environment);
  app.setPath('userData', environment.userDataDirectory);
  app.setPath('sessionData', environment.userDataDirectory);
  mkdirSync(environment.temporaryDirectory, { recursive: true });
  app.setPath('temp', environment.temporaryDirectory);
  // These are process-local and inherited only by this instance's children.
  process.env.TEMP = environment.temporaryDirectory; process.env.TMP = environment.temporaryDirectory;
  app.setAppLogsPath(path.join(environment.userDataDirectory, 'logs'));
  app.setPath('crashDumps', path.join(environment.userDataDirectory, 'crash-dumps'));
  return environment;
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
