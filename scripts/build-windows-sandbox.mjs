// Build-time only. Uses the existing Windows compiler; never runs on a tool launch.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('SANDBOX_BUILD_REQUIRES_WINDOWS_X64');
const output = path.join(repository, '.sandbox-build', 'sandbox');
await mkdir(output, { recursive: true });
const sources = ['WindowsSandboxHelper.cs', 'AppContainerIdentity.cs', 'TokenAccess.cs'];
const compiler = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const executable = path.join(output, 'AsteriumSandboxHelper.exe');
execFileSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/warnaserror+', '/reference:System.Web.Extensions.dll', '/main:WindowsSandboxHelper', `/out:${executable}`, ...sources.map(name => path.join(repository, 'native', 'sandbox', name))], { windowsHide: true, stdio: 'inherit' });
const hash = createHash('sha256');
for (const name of sources) { const bytes = await readFile(path.join(repository, 'native', 'sandbox', name)); hash.update(`${name}:${bytes.length}\0`).update(bytes); }
await writeFile(path.join(output, 'manifest.json'), JSON.stringify({ version: 2, architecture: 'x64', sourceHash: hash.digest('hex'), executableSha256: createHash('sha256').update(await readFile(executable)).digest('hex') }, null, 2));
console.log('Built fixed Windows sandbox helper in .sandbox-build/sandbox (not a signed release).');
