// @vitest-environment node
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { sandboxSkillPowerShellArgs } from '../../src/main/execution/sandboxSkillPowerShell';

const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
let directory: string;
const windows = it.skipIf(process.platform !== 'win32');
const policy = () => {
  const query = 'Import-Module "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Security" -ErrorAction Stop; Get-ExecutionPolicy -List | ConvertTo-Json -Compress';
  const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-Command', query], { encoding: 'utf8', windowsHide: true });
  expect(result.status).toBe(0);
  return result.stdout.trim();
};
let beforePolicy: string;
beforeAll(async () => {
  if (process.platform !== 'win32') return;
  beforePolicy = policy();
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "asterium-skill-startup-星'x-")));
});
afterAll(async () => {
  if (!directory) return;
  expect(policy()).toBe(beforePolicy);
  await rm(directory, { recursive: true, force: true });
});
async function script(body: string) {
  const file = path.join(directory, `probe-${crypto.randomUUID()}.ps1`);
  // Approved script file bytes, including its BOM, are left intact by startup.
  await writeFile(file, '\uFEFF' + body);
  return file;
}
const invoke = (file: string, argv: string[] = []) => sandboxSkillPowerShellArgs(['-NoLogo', '-NoProfile', '-NonInteractive', '-File', file, ...argv]);
const run = (args: string[]) => spawnSync(executable, args, { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 10_000 });

windows('reproduces Restricted refusal and executes the actual file with child-only Bypass', async () => {
  const file = await script("Write-Output 'SKILL_BODY_RAN'");
  const blocked = run(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Restricted', '-File', file]);
  expect(blocked.status).toBe(1); expect(blocked.stdout).not.toContain('SKILL_BODY_RAN');
  const repaired = run(invoke(file));
  expect(repaired.status).toBe(0); expect(repaired.stdout).toContain('SKILL_BODY_RAN');
  // The bootstrap still invokes the file through PowerShell authorization.
  const restricted = invoke(file); restricted[4] = 'Restricted';
  const rejected = run(restricted);
  expect(rejected.status).toBe(1); expect(rejected.stdout).not.toContain('SKILL_BODY_RAN');
});
windows('returns Chinese stdout and stderr as UTF-8 and retains file/root/cwd', async () => {
  const file = await script("Write-Output '中文标准输出'; [Console]::Error.WriteLine('中文错误输出'); Write-Output ('FILE='+$PSCommandPath); Write-Output ('ROOT='+$PSScriptRoot); Write-Output ('CWD='+[IO.Directory]::GetCurrentDirectory())");
  const result = run(invoke(file));
  expect(result.status).toBe(0); expect(result.stdout).toContain('中文标准输出'); expect(result.stderr).toContain('中文错误输出');
  expect(result.stdout).toContain('FILE=' + file); expect(result.stdout).toContain('ROOT=' + directory); expect(result.stdout).toContain('CWD=' + directory);
  expect(result.stdout + result.stderr).not.toMatch(/[\uFFFD]|CLIXML/);
});
windows('binds named/switch and literal positional argv like -File', async () => {
  const file = await script('param([string]$Name,[switch]$Flag)\n[pscustomobject]@{name=$Name;flag=$Flag.IsPresent;argv=@($args)} | ConvertTo-Json -Compress');
  const argv = ['-Name', '用户', '-Flag', '', 'a b', "a'b", '$(throw 99);', '"quoted"', '’ ; throw 99; #', 'a\nb'];
  const result = run(invoke(file, argv));
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ name: '用户', flag: true, argv: argv.slice(3) });
  // Compare binding with ASCII so the old OEM-encoded output is not decoded
  // as UTF-8 and mistaken for an argument binding failure.
  const ascii = argv.map(arg => Array.from(arg, char => char.codePointAt(0)! < 128 ? char : 'X').join('')); ascii[1] = 'Test User';
  expect(JSON.parse(run(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...ascii]).stdout)).toEqual(JSON.parse(run(invoke(file, ascii)).stdout));
});
windows('binds colon parameter values without treating them as code', async () => {
  const file = await script('param([string]$Name)\nWrite-Output $Name');
  expect(run(invoke(file, ['-Name:$(throw 99)'])).stdout.trim()).toBe('$(throw 99)');
  expect(run(invoke(file, ['-Name:', '用户'])).stdout.trim()).toBe('用户');
});
windows.each([0, 7])('preserves explicit script exit %s', async code => {
  const result = run(invoke(await script(`Write-Output 'BEFORE_EXIT'; exit ${code}; Write-Output 'SHOULD_NOT_RUN'`)));
  expect(result.status).toBe(code); expect(result.stdout).toContain('BEFORE_EXIT'); expect(result.stdout).not.toContain('SHOULD_NOT_RUN');
});
windows('fails on a terminating error with readable Chinese', async () => {
  const result = run(invoke(await script("throw '技能中文异常'")));
  expect(result.status).toBe(1); expect(result.stderr).toContain('技能中文异常'); expect(result.stderr).not.toContain('\uFFFD');
});
windows('keeps nonterminating errors readable without turning them into a terminating failure', async () => {
  const result = run(invoke(await script("Write-Error '技能非终止错误'; Write-Output 'DONE'")));
  expect(result.status).toBe(0); expect(result.stdout).toContain('DONE'); expect(result.stderr.replace(/\s+/gu, '')).toContain('技能非终止错误'); expect(result.stderr).not.toMatch(/[\uFFFD]|CLIXML/);
});
windows('retains -File normal completion after a native child exits nonzero', async () => {
  for (const body of ['cmd /c exit 9', 'cmd /c exit 9; Write-Output DONE']) {
    const result = run(invoke(await script(body)));
    expect(result.status).toBe(0);
  }
});
windows('streams output before script completion rather than buffering Invoke results', async () => {
  const file = await script("Write-Output 'EARLY'; Start-Sleep -Milliseconds 500; Write-Output 'LATE'");
  const child = spawn(executable, invoke(file), { cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let early = false;
  child.stdout.on('data', bytes => { output += bytes.toString('utf8'); if (output.includes('EARLY') && !output.includes('LATE')) early = true; });
  const status = await new Promise(resolve => child.once('close', resolve));
  expect(status).toBe(0); expect(early).toBe(true); expect(output).toContain('LATE');
});
it('refuses unknown interpreter flags instead of executing arbitrary startup syntax', () => {
  expect(() => sandboxSkillPowerShellArgs(['-Command', 'malicious'])).toThrow('SANDBOX_SKILL_POWERSHELL_ARGS_INVALID');
  expect(() => invoke('probe.ps1', ['-Name;throw 99'])).toThrow('SANDBOX_SKILL_POWERSHELL_PARAMETER_UNSUPPORTED');
});
