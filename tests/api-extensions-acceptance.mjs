import { runAutoTest, spawnTestProcess as spawn, autoTestEvidence } from './helpers/autoTest.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

await runAutoTest(async () => {
// Serial packaged acceptance. Default never uses a model; live mode requires an explicit environment opt-in.







const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.env.ASTERIUM_PACKAGED_EXE ?? path.join(root, 'out', 'Asterium-win32-x64', 'Asterium.exe');
const resources = path.join(path.dirname(executable), 'resources');
const live = process.argv.includes('--live');
if (live && process.env.ASTERIUM_API_LIVE_SMOKE !== '1') throw new Error('Set ASTERIUM_API_LIVE_SMOKE=1 before running live acceptance.');
const evidence = autoTestEvidence('s8-acceptance');
await mkdir(evidence, { recursive: true });
const result = { live, executableHash: createHash('sha256').update(await readFile(executable)).digest('hex'),
  appArchiveHash: createHash('sha256').update(await readFile(path.join(resources, 'app.asar'))).digest('hex'), packagedLicenses: false, status: 'running', cases: [] };
const resultPath = path.join(evidence, live ? 'live-result.json' : 'offline-result.json');
const save = () => writeFile(resultPath, JSON.stringify(result, null, 2));
await save();
try {
for (const [source, packaged] of [
  ['third_party/mcp-client/2.3.1/LICENSE', 'mcp-client/2.3.1/LICENSE'],
  ['third_party/yaml/2.9.1/LICENSE', 'yaml/2.9.1/LICENSE'],
  ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
]) assert.deepEqual(await readFile(path.join(root, source)), await readFile(path.join(resources, packaged)), `Packaged notice differs: ${packaged}`);
result.packagedLicenses = true;
const scripts = ['api-extensions-storage-smoke.mjs', 'api-mcp-connection-smoke.mjs', 'electron-startup-smoke.mjs',
  ...(live ? ['api-mcp-install-live-smoke.mjs', 'api-mcp-runtime-live-smoke.mjs', 'api-mcp-settings-live-smoke.mjs', 'api-extensions-integration-live-smoke.mjs'] : [])];
for (const script of scripts) {
  console.log(`EXTENSIONS_ACCEPTANCE_START ${script}`);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'tests', script)], { cwd: root, windowsHide: true, stdio: 'inherit',
      env: { ...process.env, ASTERIUM_CLAUDE_LIVE_SMOKE: '0', ASTERIUM_CODEX_LIVE_SMOKE: '0', ASTERIUM_PACKAGED_EXE: executable } });
    child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`EXTENSIONS_ACCEPTANCE_FAILED:${script}:${code}`)));
  });
  result.cases.push(script);
  await save();
}
result.status = 'passed'; await save();
console.log(`EXTENSIONS_ACCEPTANCE_PASSED ${result.cases.length}`);
} catch (error) { result.status = 'failed'; await save(); throw error; }
});
