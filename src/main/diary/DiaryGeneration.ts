import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { resolveCodexRuntime } from '../../shared/codexRuntimeSelection';
import { loadClaudeCliRuntime } from '../adapters/ClaudeCodeAdapter';
import { ApiConnectionStore } from '../api/ApiConnectionStore';
import type { ApiProviderRegistry } from '../api/ApiProviderRegistry';
import { createApiRuntimeConfiguration } from '../api/ApiRuntimeConfiguration';
import { generateApiDiary, generateClaudeDiary, generateCodexDiary, generateExistingDiary } from './DiaryGenerators';
import { PartnerDiaryCatalog } from './PartnerDiaryCatalog';
import { PartnerDiaryScheduler } from './PartnerDiaryScheduler';
import { PartnerProfileStore } from '../partner/PartnerProfileStore';
import { createLocalRuntimeResolver } from '../runtime/LocalRuntimeResolver';
import { assembleSessionBootstrap } from '../runtime/SessionBootstrapAssembler';
import { CredentialStore } from '../security/CredentialStore';

interface Dependencies {
  apiConnections: ApiConnectionStore;
  apiProviders: ApiProviderRegistry;
  configuredApiOptions: ReturnType<typeof createApiRuntimeConfiguration>;
  credentials: CredentialStore;
  diaryCatalog: PartnerDiaryCatalog;
  partnerProfiles: PartnerProfileStore;
  ensureClaudeInstallation: ReturnType<typeof createLocalRuntimeResolver>['ensureClaudeInstallation'];
  ensureCodexInstallation: ReturnType<typeof createLocalRuntimeResolver>['ensureCodexInstallation'];
  userDataDirectory: () => string;
}

export function createDiaryGeneration(dependencies: Dependencies) {
  const { apiConnections, apiProviders, configuredApiOptions, credentials, diaryCatalog, partnerProfiles, ensureClaudeInstallation, ensureCodexInstallation, userDataDirectory } = dependencies;
  const generate: ConstructorParameters<typeof PartnerDiaryScheduler>[0]['generate'] = async ({ config, entry, source, signal }) => {
    const current = diaryCatalog.current(config.partnerId);
    if (!current?.identity.available) throw new Error('DIARY_RUNTIME_UNAVAILABLE');
    if (current.existing) {
      const secret = await credentials.get(current.existing.credentialRef);
      if (!secret || !config.upstreamThreadId) throw new Error('DIARY_RUNTIME_UNAVAILABLE');
      return generateExistingDiary(current.existing, secret, config.upstreamThreadId, entry.generationId, source, signal);
    }
    const partner = current.runtime;
    const profile = await partnerProfiles.runtimeProfile(config.partnerId);
    if (!partner || !profile) throw new Error('DIARY_RUNTIME_UNAVAILABLE');
    const persona = await partnerProfiles.managedPersonaState(config.partnerId);
    const bootstrap = assembleSessionBootstrap({
      source: partner.sourceMode, partnerName: profile.publicIdentity.displayName,
      management: { ...profile.management, memoryMode: 'self_managed' }, user: await partnerProfiles.runtimeUserProfile(),
      ...(persona.enabled ? { persona } : {}), platformContext: '本回合是隔离的每日伙伴日记，不属于用户聊天；不提供记忆简报和记忆工具。',
    })?.content ?? '';
    if (partner.runtime.kind === 'api') {
      const connection = await apiConnections.resolve(partner.partnerId, partner.runtime.connection); const apiOptions = await configuredApiOptions(connection);
      const provider = apiProviders.normalizeConnection(connection);
      return generateApiDiary(provider.definition.createAdapter({ ...apiOptions, endpoint: provider.endpoint, model: provider.model, thinkingMode: 'disabled' }), source, bootstrap, signal);
    }
    if (partner.runtime.kind !== 'local') throw new Error('DIARY_RUNTIME_UNAVAILABLE');
    const directory = path.join(userDataDirectory(), 'diary-runtime', entry.generationId);
    await mkdir(directory, { recursive: true });
    const input = { cwd: directory, source, bootstrap, signal };
    if (partner.runtime.adapterType === 'codex_cli') {
      const installation = await ensureCodexInstallation();
      const runtime = resolveCodexRuntime(installation.runtimes, partner.runtime.codexRuntimeId, partner.runtime.codexRuntimeEnvironment);
      if (!runtime?.loggedIn) throw new Error('DIARY_RUNTIME_UNAVAILABLE');
      return generateCodexDiary({ ...input, executablePath: runtime.executablePath });
    }
    const installation = await ensureClaudeInstallation();
    if (!installation.executablePath || !installation.loggedIn) throw new Error('DIARY_RUNTIME_UNAVAILABLE');
    return generateClaudeDiary({ ...input, executablePath: installation.executablePath, ...(partner.recentModel?.model ? { model: partner.recentModel.model } : {}) }, (await loadClaudeCliRuntime()).query);
  };
  return generate;
}
