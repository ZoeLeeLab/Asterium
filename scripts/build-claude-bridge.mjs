import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('CLAUDE_BRIDGE_BUILD_REQUIRES_WINDOWS_X64');
const output = path.join(root, '.sandbox-build/claude-bridge');
await mkdir(output, { recursive: true });
const source = path.join(root, 'native/claude-bridge/ClaudePipeHost.cs');
const compiler = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const executable = path.join(output, 'AsteriumClaudePipeHost.exe');
execFileSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/warnaserror+', '/reference:System.Web.Extensions.dll', '/main:ClaudePipeHost', `/out:${executable}`, source], { windowsHide: true, stdio: 'inherit' });
await copyFile(path.join(root, 'src/main/adapters/claudeStdioProxy.cjs'), path.join(output, 'claudeStdioProxy.cjs'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
await writeFile(path.join(output, 'manifest.json'), JSON.stringify({ architecture: 'x64', sourceSha256: hash(await readFile(source)), executableSha256: hash(await readFile(executable)), signed: false }, null, 2) + '\n');
console.log('Built local Claude stdio IPC host (no listening network port).');
