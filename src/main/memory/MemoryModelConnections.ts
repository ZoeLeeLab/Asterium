import { MemoryImportService } from './MemoryImportService';
import { createMemoryFallbackAdapter } from './fallback/MemoryConsolidation';
import { MemoryFallbackScheduler } from './fallback/MemoryFallbackScheduler';
import { MemoryFallbackSettingsStore } from './fallback/MemoryFallbackSettingsStore';

interface Dependencies {
  memoryFallbackSettings: MemoryFallbackSettingsStore;
}

export function createMemoryModelConnections(dependencies: Dependencies) {
  const { memoryFallbackSettings } = dependencies;
  const connectImport: ConstructorParameters<typeof MemoryImportService>[2] = async input => {
    const config = await memoryFallbackSettings.get();
    if (config.provider !== input.provider || config.endpoint !== input.endpoint || config.model !== input.model) {
      throw new Error('MEMORY_IMPORT_CONNECTION_CHANGED');
    }
    const apiKey = await memoryFallbackSettings.secret(config);
    if (!apiKey) throw new Error('MEMORY_IMPORT_CREDENTIAL_REQUIRED');
    return createMemoryFallbackAdapter(config, apiKey);
  };
  const connectFallback: ConstructorParameters<typeof MemoryFallbackScheduler>[4] = async (config) => {
    const apiKey = await memoryFallbackSettings.secret(config);
    if (!apiKey) throw new Error('MEMORY_FALLBACK_CREDENTIAL_REQUIRED');
    return createMemoryFallbackAdapter(config, apiKey);
  };
  return { connectImport, connectFallback };
}
