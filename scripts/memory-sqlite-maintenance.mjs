import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

/** Bundle the same production coordinator, not a second migration implementation. */
export async function withMemoryMaintenance(userData, operation) {
  if (!path.isAbsolute(userData)) throw new Error('Use an absolute user-data directory');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'asterium-memory-maintenance-'));
  try {
    await build({ configFile: false, root: path.resolve(import.meta.dirname, '..'), logLevel: 'error', ssr: { noExternal: true },
      build: { ssr: path.resolve(import.meta.dirname, '../src/main/memory/SqliteMemoryCutover.ts'), target: 'node24', outDir: temporary,
        rollupOptions: { external: [/^node:/u], output: { format: 'es', entryFileNames: 'cutover.mjs' } } } });
    const module = await import(pathToFileURL(path.join(temporary, 'cutover.mjs')).href);
    const coordinator = new module.SqliteMemoryCutover(path.join(userData, 'AsteriumData'), userData,
      new module.MemoryFallbackJobStore(path.join(userData, 'memory-fallback-jobs.v1.json')), async () => []);
    return await operation(coordinator);
  } finally { await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2); const directory = args[args.indexOf('--user-data') + 1];
  if (!args.includes('--user-data') || !directory || !path.isAbsolute(directory) || !args.some((arg) => ['--status', '--rollback'].includes(arg))) {
    throw new Error('Usage: npm run memory:sqlite -- --status --user-data <absolute directory> OR --rollback --confirm-stopped --accept-post-cutover-memory-not-in-old-version --user-data <absolute directory>');
  }
  if (args.includes('--rollback')) {
    if (!args.includes('--confirm-stopped') || !args.includes('--accept-post-cutover-memory-not-in-old-version')) throw new Error('Rollback requires both explicit confirmation flags; new SQLite memory is preserved separately, not converted to old Markdown.');
    if (process.platform !== 'win32') throw new Error('The stopped-app check currently supports Windows only.');
    const encodedRoot = Buffer.from(path.resolve(import.meta.dirname, '..'), 'utf8').toString('base64');
    const probe = `$taskRoot = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedRoot}')); @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Asterium.exe' -or ($_.Name -eq 'electron.exe' -and $_.CommandLine -and $_.CommandLine.IndexOf($taskRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0) }).Count`;
    const active = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', probe], { encoding: 'utf8', windowsHide: true });
    if (Number(active.trim()) !== 0) throw new Error('Stop all Asterium instances before rollback.');
  }
  await withMemoryMaintenance(directory, async (coordinator) => {
    const manifest = args.includes('--rollback') ? await coordinator.rollback(true) : await coordinator.status();
    console.log(JSON.stringify(manifest ? { state: manifest.state, id: manifest.id, partners: manifest.partners.length,
      archivedFiles: manifest.files.length, baselineConversations: manifest.baseline.length, backupDirectory: coordinator.backupDirectory(manifest) } : { state: 'not_started' }, null, 2));
  });
}
