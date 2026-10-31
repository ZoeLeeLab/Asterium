import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  PartnerProfileSeed,
  PartnerProfileSnapshot,
  PartnerProfilesSyncResult,
  RuntimeModelObservation,
} from '../../shared/agentProtocol';

interface PartnerMetadata {
  version: 2;
  partnerId: string;
  sourceMode: PartnerProfileSeed['sourceMode'];
  management: PartnerProfileSeed['management'];
  createdAt: string;
  updatedAt: string;
}

interface RuntimeFile {
  version: 1;
  partnerId: string;
  recentModel?: RuntimeModelObservation;
  conversations: Record<string, RuntimeModelObservation>;
  updatedAt: string;
}

interface ManagedSettings {
  personality: string;
  systemPrompt: string;
}

export type ManagedPersonaState = {
  enabled: false;
  personaFileExists: boolean;
} | {
  enabled: true;
  personaFileExists: boolean;
  personality: string;
  systemPrompt: string;
  version: string;
};


type UserProfileSeed = { displayName: string; introduction: string; updatedAt: string; revision?: string };
type ProfileListener = (profiles: PartnerProfilesSyncResult) => void;

export class PartnerProfileStore {
  private mutation = Promise.resolve();
  private readonly directoryCache = new Map<string, string>();
  private readonly listeners = new Set<ProfileListener>();
  private lastSyncInput?: { user: UserProfileSeed; seeds: PartnerProfileSeed[] };

  constructor(
    private readonly rootDirectory: string,
  ) {}

  async sync(
    user: UserProfileSeed,
    seeds: PartnerProfileSeed[],
  ): Promise<PartnerProfilesSyncResult> {
    const result = await this.synchronize(user, seeds);
    this.lastSyncInput = { user: { ...user }, seeds: seeds.map(cloneSeed) };
    return result;
  }

  subscribe(listener: ProfileListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose() {
    this.listeners.clear();
  }

  private synchronize(user: UserProfileSeed, seeds: PartnerProfileSeed[]) {
    return this.mutate(async () => {
      await this.ensureRoots();
      await this.migrateManagementMetadata();
      const userProfile = await this.ensureUser(user);
      const partners: PartnerProfileSnapshot[] = [];
      for (const seed of seeds) partners.push(await this.ensurePartner(seed));
      return { user: userProfile, partners };
    });
  }

  async saveUser(user: UserProfileSeed) {
    const result = await this.mutate(async () => {
      validateText(user.displayName, 80, 'USER_PROFILE_INVALID');
      validateText(user.introduction, 20_000, 'USER_PROFILE_INVALID', true);
      await this.ensureRoots();
      if (user.revision !== undefined) {
        const current = await readFile(this.userProfilePath(), 'utf8').catch(() => '');
        if (user.revision !== createHash('sha256').update(current).digest('hex')) throw new Error('PROFILE_VERSION_CONFLICT');
      }
      const normalized = { ...user, displayName: user.displayName.trim(), introduction: user.introduction.trim(), updatedAt: new Date().toISOString() };
      await atomicWrite(this.userProfilePath(), renderUserProfile(normalized));
      return { ...normalized, revision: createHash('sha256').update(renderUserProfile(normalized)).digest('hex') };
    });
    if (this.lastSyncInput) this.lastSyncInput = { ...this.lastSyncInput, user: { ...result } };
    return result;
  }

  async savePartner(seed: PartnerProfileSeed): Promise<PartnerProfileSnapshot> {
    validateSeed(seed);
    const result = await this.mutate(async () => {
      await this.ensureRoots();
      let directory = await this.resolvePartnerDirectory(seed.partnerId, seed.publicIdentity.displayName, true);
      if (seed.expectedRevision !== undefined && seed.expectedRevision !== await this.revision(directory)) throw new Error('PROFILE_VERSION_CONFLICT');
      directory = await this.renamePartnerDirectory(directory, seed.partnerId, seed.publicIdentity.displayName);
      const existing = await this.readMetadata(directory);
      const now = new Date().toISOString();
      const metadata: PartnerMetadata = {
        version: 2,
        partnerId: seed.partnerId,
        sourceMode: seed.sourceMode,
        management: effectiveManagement(seed.sourceMode, seed.management),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await atomicWrite(path.join(directory, 'partner.json'), json(metadata));
      await atomicWrite(path.join(directory, 'profile.md'), renderPartnerProfile(seed.publicIdentity));
      await atomicWrite(path.join(directory, 'connection.json'), json({ version: 2, partnerId: seed.partnerId, sourceMode: seed.sourceMode, ...seed.connectionSettings, updatedAt: now }));
      await this.saveAvatar(directory, seed.publicIdentity.avatarDataUrl);
      if (metadata.management.personality) {
        const personaPath = path.join(directory, 'persona.md');
        const submittedPersonaIsEmpty = !(seed.personality ?? '').trim() && !(seed.systemPrompt ?? '').trim();
        const reenabledExistingPersona = existing?.management.personality === false && submittedPersonaIsEmpty && await exists(personaPath);
        if (!reenabledExistingPersona) {
          await atomicWrite(personaPath, renderManagedSettings({ personality: seed.personality ?? '', systemPrompt: seed.systemPrompt ?? '' }));
        }
      }
      await mkdir(path.join(directory, 'work-memory'), { recursive: true });
      await this.ensureRuntime(seed.partnerId, directory);
      return this.snapshot(directory, metadata);
    });
    if (this.lastSyncInput) {
      const seeds = this.lastSyncInput.seeds.filter((item) => item.partnerId !== seed.partnerId);
      this.lastSyncInput = { ...this.lastSyncInput, seeds: [...seeds, cloneSeed(seed)] };
    }
    return result;
  }

  async trashPartnerDirectory(partnerId: string, trashItem: (directory: string) => Promise<void>) {
    return this.mutate(async () => {
      const directory = await this.resolvePartnerDirectory(partnerId, '', false);
      if (!directory) return false;
      await trashItem(directory);
      this.directoryCache.delete(partnerId);
      if (this.lastSyncInput) this.lastSyncInput = {
        ...this.lastSyncInput,
        seeds: this.lastSyncInput.seeds.filter((seed) => seed.partnerId !== partnerId),
      };
      return true;
    });
  }

  async runtimeUserProfile() {
    await this.mutation;
    try {
      return parseUserProfile(await readFile(this.userProfilePath(), 'utf8'), new Date(0).toISOString());
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async runtimeProfile(partnerId: string) {
    const directory = await this.resolvePartnerDirectory(partnerId, '', false);
    if (!directory) return undefined;
    const metadata = await this.readMetadata(directory);
    if (!metadata) return undefined;
    const publicIdentity = await this.readPartnerProfile(directory);
    const avatarDataUrl = await readAvatar(directory);
    const settings = metadata.management.personality ? await this.readManagedSettings(directory) : undefined;
    return { publicIdentity: { ...publicIdentity, ...(avatarDataUrl ? { avatarDataUrl } : {}) }, management: metadata.management, ...settings };
  }

  async managedPersonaState(partnerId: string): Promise<ManagedPersonaState> {
    const directory = await this.resolvePartnerDirectory(partnerId, '', false);
    if (!directory) return { enabled: false, personaFileExists: false };
    const metadata = await this.readMetadata(directory);
    const personaPath = path.join(directory, 'persona.md');
    const personaFileExists = await exists(personaPath);
    if (!metadata?.management.personality) return { enabled: false, personaFileExists };
    const settings = await this.readManagedSettings(directory);
    const semanticContent = JSON.stringify({ personality: settings.personality, systemPrompt: settings.systemPrompt });
    return {
      enabled: true,
      personaFileExists,
      ...settings,
      version: `enabled:${createHash('sha256').update(semanticContent).digest('hex')}`,
    };
  }

  /** Shares the profile mutation queue, so rename/trash cannot race a database operation. */
  withManagedMemoryStorage<T>(partnerId: string, operation: (directory: string) => Promise<T>) {
    return this.mutate(async () => {
      const directory = await this.resolvePartnerDirectory(partnerId, '', false);
      if (!directory) throw new Error('PARTNER_PROFILE_NOT_FOUND');
      const metadata = await this.readMetadata(directory);
      if (!metadata || metadata.partnerId !== partnerId) throw new Error('PARTNER_PROFILE_NOT_FOUND');
      if (metadata.management.memoryMode !== 'asterium') throw new Error('PARTNER_MEMORY_NOT_MANAGED');
      return operation(path.join(directory, 'private-memory'));
    });
  }

  async workMemoryDirectory(partnerId: string) {
    await this.mutation;
    const directory = await this.resolvePartnerDirectory(partnerId, '', false);
    if (!directory || !await this.readMetadata(directory)) throw new Error('PARTNER_PROFILE_NOT_FOUND');
    const workMemoryDirectory = path.join(directory, 'work-memory');
    await mkdir(workMemoryDirectory, { recursive: true });
    return workMemoryDirectory;
  }

  async diaryDirectory(partnerId: string) {
    await this.mutation;
    const directory = await this.resolvePartnerDirectory(partnerId, '', false);
    if (!directory || !await this.readMetadata(directory)) throw new Error('PARTNER_PROFILE_NOT_FOUND');
    return path.join(directory, 'diary');
  }

  async partnerIds() {
    await this.mutation;
    const root = path.join(this.rootDirectory, 'partners');
    const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
      if (isNodeError(error) && error.code === 'ENOENT') return [];
      throw error;
    });
    const partnerIds: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const metadata = await this.readMetadata(path.join(root, entry.name));
      if (metadata) partnerIds.push(metadata.partnerId);
    }
    return [...new Set(partnerIds)].sort();
  }

  async observeModel(input: {
    partnerId: string;
    conversationId: string;
    threadId?: string;
    model: string;
    source: RuntimeModelObservation['source'];
    observedAt?: string;
  }) {
    if (!input.model.trim() || !input.conversationId) return;
    await this.mutate(async () => {
      const directory = await this.resolvePartnerDirectory(input.partnerId ?? '', '', false);
      if (!directory) return;
      const runtime = await this.readRuntime(directory);
      const observation: RuntimeModelObservation = {
        model: input.model.trim().slice(0, 200),
        status: 'current',
        observedAt: input.observedAt ?? new Date().toISOString(),
        source: input.source,
        conversationId: input.conversationId,
        ...(input.threadId ? { threadId: input.threadId } : {}),
      };
      const next: RuntimeFile = {
        version: 1,
        partnerId: runtime.partnerId,
        recentModel: { ...observation, status: 'recent' },
        conversations: { ...runtime.conversations, [input.conversationId]: observation },
        updatedAt: observation.observedAt,
      };
      await atomicWrite(path.join(directory, 'runtime.json'), json(next));
    });
  }

  private async migrateManagementMetadata() {
    const partnersDirectory = path.join(this.rootDirectory, 'partners');
    for (const entry of await readdir(partnersDirectory, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(partnersDirectory, entry.name);
      const metadataPath = path.join(directory, 'partner.json');
      const raw = await readJsonRecord(metadataPath);
      const metadata = await this.readMetadata(directory);
      if (!metadata) continue;
      const rawManagement = isRecord(raw?.management) ? raw.management : {};
      const current = raw?.version === 2
        && rawManagement.userProfile === metadata.management.userProfile
        && rawManagement.personality === metadata.management.personality
        && rawManagement.memoryMode === metadata.management.memoryMode
        && raw?.sourceMode === metadata.sourceMode;
      if (!current) await atomicWrite(metadataPath, json(metadata));

      if (metadata.sourceMode !== 'api_partner') continue;
      const connectionPath = path.join(directory, 'connection.json');
      const connection = await readJsonRecord(connectionPath);
      if (!connection) continue;
      const apiSessionHistoryEnabled = typeof connection.apiSessionHistoryEnabled === 'boolean'
        ? connection.apiSessionHistoryEnabled
        : typeof connection.memoryEnabled === 'boolean' ? connection.memoryEnabled : true;
      if (connection.version === 2 && connection.apiSessionHistoryEnabled === apiSessionHistoryEnabled && !('memoryEnabled' in connection)) continue;
      const next: Record<string, unknown> = { ...connection, version: 2, apiSessionHistoryEnabled };
      delete next.memoryEnabled;
      await atomicWrite(connectionPath, json(next));
    }
  }

  private async ensureRoots() {
    await mkdir(path.join(this.rootDirectory, 'user'), { recursive: true });
    await mkdir(path.join(this.rootDirectory, 'partners'), { recursive: true });
  }

  private userProfilePath() {
    return path.join(this.rootDirectory, 'user', 'user-profile.md');
  }

  private async ensureUser(seed: UserProfileSeed) {
    try {
      const profilePath = this.userProfilePath();
      const original = await readFile(profilePath, 'utf8');
      const content = stripLegacyUserTimestamp(original);
      if (content !== original) await atomicWrite(profilePath, content);
      const metadata = await stat(profilePath);
      return { ...parseUserProfile(content, metadata.mtime.toISOString()), revision: createHash('sha256').update(content).digest('hex') };
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
      const normalized = { ...seed, displayName: seed.displayName.trim() || '用户', introduction: seed.introduction.trim(), updatedAt: new Date().toISOString() };
      await atomicWrite(this.userProfilePath(), renderUserProfile(normalized));
      return { ...normalized, revision: createHash('sha256').update(renderUserProfile(normalized)).digest('hex') };
    }
  }

  private async ensurePartner(seed: PartnerProfileSeed) {
    validateSeed(seed);
    const directory = await this.resolvePartnerDirectory(seed.partnerId, seed.publicIdentity.displayName, true);
    let metadata = await this.readMetadata(directory);
    const now = new Date().toISOString();
    if (!metadata) {
      metadata = { version: 2, partnerId: seed.partnerId, sourceMode: seed.sourceMode, management: effectiveManagement(seed.sourceMode, seed.management), createdAt: now, updatedAt: now };
      await atomicWrite(path.join(directory, 'partner.json'), json(metadata));
    }
    await ensureFile(path.join(directory, 'profile.md'), renderPartnerProfile(seed.publicIdentity));
    await ensureFile(path.join(directory, 'connection.json'), json({ version: 2, partnerId: seed.partnerId, sourceMode: seed.sourceMode, ...seed.connectionSettings, updatedAt: now }));
    if (seed.publicIdentity.avatarDataUrl && !(await findAvatar(directory))) await writeAvatar(directory, seed.publicIdentity.avatarDataUrl);
    if (metadata.management.personality) await ensureFile(path.join(directory, 'persona.md'), renderManagedSettings({ personality: seed.personality ?? '', systemPrompt: seed.systemPrompt ?? '' }));
    await mkdir(path.join(directory, 'work-memory'), { recursive: true });
    await this.ensureRuntime(seed.partnerId, directory);
    return this.snapshot(directory, metadata);
  }

  private async snapshot(directory: string, metadata: PartnerMetadata): Promise<PartnerProfileSnapshot> {
    const publicIdentity = await this.readPartnerProfile(directory);
    const avatarDataUrl = await readAvatar(directory);
    const runtime = await this.readRuntime(directory);
    const settings = metadata.management.personality ? await this.readManagedSettings(directory) : undefined;
    return {
      partnerId: metadata.partnerId,
      directoryName: path.basename(directory),
      revision: await this.revision(directory),
      publicIdentity: { ...publicIdentity, ...(avatarDataUrl ? { avatarDataUrl } : {}) },
      management: { ...metadata.management },
      ...(settings ? settings : {}),
      ...(runtime.recentModel ? { recentModel: runtime.recentModel } : {}),
      conversationModels: Object.fromEntries(Object.entries(runtime.conversations).map(([conversationId, observation]) => [conversationId, { ...observation, status: 'recent', source: 'history' }])),
    };
  }

  private async readPartnerProfile(directory: string) {
    return parsePartnerProfile(await readFile(path.join(directory, 'profile.md'), 'utf8'));
  }

  private async readManagedSettings(directory: string): Promise<ManagedSettings> {
    try {
      return parseManagedSettings(await readFile(path.join(directory, 'persona.md'), 'utf8'));
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return { personality: '', systemPrompt: '' };
      throw error;
    }
  }

  private async ensureRuntime(partnerId: string, directory: string) {
    await ensureFile(path.join(directory, 'runtime.json'), json({ version: 1, partnerId, conversations: {}, updatedAt: new Date().toISOString() } satisfies RuntimeFile));
  }

  private async readRuntime(directory: string): Promise<RuntimeFile> {
    const metadata = await this.readMetadata(directory);
    const fallback: RuntimeFile = { version: 1, partnerId: metadata?.partnerId ?? '', conversations: {}, updatedAt: new Date().toISOString() };
    try {
      const parsed: unknown = JSON.parse(await readFile(path.join(directory, 'runtime.json'), 'utf8'));
      if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.partnerId !== 'string' || !isRecord(parsed.conversations)) return fallback;
      return parsed as unknown as RuntimeFile;
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return fallback;
      throw error;
    }
  }

  private async readMetadata(directory: string): Promise<PartnerMetadata | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(path.join(directory, 'partner.json'), 'utf8'));
      if (!isRecord(parsed) || (parsed.version !== 1 && parsed.version !== 2) || typeof parsed.partnerId !== 'string' || !isRecord(parsed.management)) return undefined;
      const sourceMode = parsed.sourceMode === 'local_cli' || parsed.sourceMode === 'api_partner' ? parsed.sourceMode : 'existing_thread';
      const management = parsed.management;
      return {
        version: 2,
        partnerId: parsed.partnerId,
        sourceMode,
        management: effectiveManagement(sourceMode, {
          userProfile: management.userProfile === true,
          personality: management.personality === true,
          memoryMode: management.memoryMode === 'asterium' || management.memoryMode === 'self_managed' || management.memoryMode === 'none'
            ? management.memoryMode
            : management.privateMemory === true ? 'asterium' : sourceMode === 'local_cli' ? 'self_managed' : sourceMode === 'api_partner' ? 'asterium' : 'none',
        }),
        createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date(0).toISOString(),
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
      };
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async resolvePartnerDirectory(partnerId: string, displayName: string, create: true): Promise<string>;
  private async resolvePartnerDirectory(partnerId: string, displayName: string, create: false): Promise<string | undefined>;
  private async resolvePartnerDirectory(partnerId: string, displayName: string, create: boolean) {
    assertSafeId(partnerId);
    const cached = this.directoryCache.get(partnerId);
    if (cached && await exists(cached)) return cached;
    const root = path.join(this.rootDirectory, 'partners');
    await mkdir(root, { recursive: true });
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(root, entry.name);
      const metadata = await this.readMetadata(directory).catch(() => undefined);
      if (metadata?.partnerId === partnerId) {
        this.directoryCache.set(partnerId, directory);
        return directory;
      }
    }
    if (!create) return undefined;
    const directory = path.join(root, `${safeDirectoryName(displayName)}__${shortId(partnerId)}`);
    await mkdir(directory, { recursive: true });
    this.directoryCache.set(partnerId, directory);
    return directory;
  }

  private async saveAvatar(directory: string, dataUrl?: string) {
    const entries = await readdir(directory).catch(() => []);
    await Promise.all(entries.filter((name) => /^avatar\.(?:png|jpg|webp)$/i.test(name)).map((name) => rm(path.join(directory, name), { force: true })));
    if (dataUrl) await writeAvatar(directory, dataUrl);
  }

  private async renamePartnerDirectory(directory: string, partnerId: string, displayName: string) {
    const desired = path.join(path.dirname(directory), `${safeDirectoryName(displayName)}__${shortId(partnerId)}`);
    if (desired.toLocaleLowerCase() === directory.toLocaleLowerCase() || await exists(desired)) return directory;
    await rename(directory, desired);
    this.directoryCache.set(partnerId, desired);
    return desired;
  }

  private mutate<T>(operation: () => Promise<T>) {
    const result = this.mutation.then(operation, operation);
    this.mutation = result.then(() => undefined, () => undefined);
    return result;
  }

  /** One-shot refresh, called only by explicit UI lifecycle events. */
  async refresh() {
    const input = this.lastSyncInput;
    if (!input) throw new Error('PARTNER_PROFILES_NOT_INITIALIZED');
    const profiles = await this.synchronize(input.user, input.seeds);
    for (const listener of this.listeners) listener(profiles);
    return profiles;
  }

  private async revision(directory: string) {
    const files = await Promise.all(['partner.json', 'profile.md', 'persona.md'].map((name) => readFile(path.join(directory, name), 'utf8').catch((error: unknown) => {
      if (isNodeError(error) && error.code === 'ENOENT') return ''; throw error;
    })));
    return createHash('sha256').update(JSON.stringify(files)).digest('hex');
  }

}

function renderUserProfile(profile: { displayName: string; introduction: string; updatedAt: string }) {
  return `# 用户介绍\n\n## 名字\n\n${profile.displayName}\n\n## 介绍\n\n${profile.introduction || '（未设置）'}\n`;
}

function parseUserProfile(content: string, fallbackUpdatedAt: string) {
  return {
    displayName: section(content, '名字') || '用户',
    introduction: emptyMarker(section(content, '介绍')),
    updatedAt: fallbackUpdatedAt,
  };
}

function stripLegacyUserTimestamp(content: string) {
  return content.replace(/\n*<!--\s*星丛更新时间：.*?-->\s*$/u, '\n');
}

function cloneSeed(seed: PartnerProfileSeed): PartnerProfileSeed {
  return {
    ...seed,
    publicIdentity: { ...seed.publicIdentity },
    management: { ...seed.management },
    connectionSettings: { ...seed.connectionSettings },
  };
}

function effectiveManagement(sourceMode: PartnerProfileSeed['sourceMode'], management: PartnerProfileSeed['management']): PartnerProfileSeed['management'] {
  return {
    userProfile: sourceMode === 'api_partner' || management.userProfile,
    personality: sourceMode === 'api_partner' || management.personality,
    memoryMode: sourceMode === 'api_partner' ? 'asterium'
      : sourceMode === 'existing_thread' ? 'none'
        : management.memoryMode === 'asterium' ? 'asterium' : 'self_managed',
  };
}

function renderPartnerProfile(identity: PartnerProfileSeed['publicIdentity']) {
  return `# 伙伴介绍\n\n## 名字\n\n${identity.displayName}\n\n## 简短介绍\n\n${identity.introduction || '（未设置）'}\n\n## 长期擅长\n\n${identity.expertise || '（未设置）'}\n\n## @称呼\n\n${identity.mentionName}\n`;
}

function parsePartnerProfile(content: string): PartnerProfileSeed['publicIdentity'] {
  const displayName = section(content, '名字').trim() || '未命名伙伴';
  return {
    displayName,
    introduction: emptyMarker(section(content, '简短介绍')),
    expertise: emptyMarker(section(content, '长期擅长')),
    mentionName: section(content, '@称呼').trim().replace(/^@/, '') || displayName.replace(/\s+/g, ''),
  };
}

function renderManagedSettings(settings: ManagedSettings) {
  return `# 伙伴设定\n\n> 只有启用“由星丛管理伙伴设定”时，以下内容才会进入伙伴上下文。\n\n## 性格与相处方式\n\n${settings.personality || '（未设置）'}\n\n## 稳定指令\n\n${settings.systemPrompt || '（未设置）'}\n`;
}

function parseManagedSettings(content: string): ManagedSettings {
  return { personality: emptyMarker(section(content, '性格与相处方式')), systemPrompt: emptyMarker(section(content, '稳定指令')) };
}

function section(content: string, heading: string) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^##\\s+${escaped}\\s*$([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, 'mi').exec(content.replace(/\r\n/g, '\n'))?.[1]?.trim() ?? '';
}

function emptyMarker(value: string) {
  return value.trim() === '（未设置）' ? '' : value.trim();
}

function safeDirectoryName(value: string) {
  const withoutControls = [...value.trim()].map((character) => character.charCodeAt(0) < 32 ? '_' : character).join('');
  const safe = withoutControls.replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '').slice(0, 48);
  return safe || '未命名伙伴';
}

function shortId(value: string) {
  return value.replace(/^partner-/, '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || value.slice(0, 8);
}

async function writeAvatar(directory: string, dataUrl: string) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([a-z0-9+/=]+)$/i.exec(dataUrl);
  if (!match) throw new Error('PARTNER_AVATAR_INVALID');
  const extension = match[1].toLowerCase() === 'image/jpeg' ? 'jpg' : match[1].split('/')[1];
  await atomicWrite(path.join(directory, `avatar.${extension}`), Buffer.from(match[2], 'base64'));
}

async function findAvatar(directory: string) {
  return (await readdir(directory).catch(() => [])).find((name) => /^avatar\.(?:png|jpg|webp)$/i.test(name));
}

async function readAvatar(directory: string) {
  const name = await findAvatar(directory);
  if (!name) return undefined;
  const extension = path.extname(name).slice(1).toLowerCase();
  const mediaType = extension === 'jpg' ? 'image/jpeg' : `image/${extension}`;
  return `data:${mediaType};base64,${(await readFile(path.join(directory, name))).toString('base64')}`;
}

async function ensureFile(filePath: string, content: string) {
  if (await exists(filePath)) return;
  await atomicWrite(filePath, content);
}

async function exists(target: string) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function atomicWrite(target: string, content: string | Buffer) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, target);
}

function json(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function validateSeed(seed: PartnerProfileSeed) {
  assertSafeId(seed.partnerId);
  if (!['none', 'self_managed', 'asterium'].includes(seed.management.memoryMode)) throw new Error('PARTNER_PROFILE_INVALID');
  validateText(seed.publicIdentity.displayName, 80, 'PARTNER_PROFILE_INVALID');
  validateText(seed.publicIdentity.introduction, 20_000, 'PARTNER_PROFILE_INVALID', true);
  validateText(seed.publicIdentity.expertise, 20_000, 'PARTNER_PROFILE_INVALID', true);
  validateText(seed.publicIdentity.mentionName, 80, 'PARTNER_PROFILE_INVALID');
  validateText(seed.personality ?? '', 40_000, 'PARTNER_PROFILE_INVALID', true);
  validateText(seed.systemPrompt ?? '', 80_000, 'PARTNER_PROFILE_INVALID', true);
}

function validateText(value: string, max: number, code: string, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) throw new Error(code);
}

function assertSafeId(value: string) {
  if (!value || !/^[a-zA-Z0-9_-]{1,160}$/.test(value)) throw new Error('PARTNER_ID_INVALID');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}

async function readJsonRecord(filePath: string) {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    return isRecord(parsed) ? parsed : undefined;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

