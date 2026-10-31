// @vitest-environment node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, it } from 'vitest';
import { skillProbe } from '../fixtures/sandbox/skill-only-fixture.mjs';

it.skipIf(process.platform !== 'win32')('parses the supplied Skill fixture including literal Unicode/quoted paths without executing it', () => {
  const workspace = "C:\\合成 工作区\\x'y", run = workspace + '\\S2_SKILL_00000000000000000000000000000000';
  const overwrite = "C:\\合成 外部\\x'y\\overwrite.txt", deletion = "C:\\合成 外部\\x'y\\delete.txt";
  const script = skillProbe({ workspace, run, overwrite, deletion, marker: 'S2_SKILL_00000000000000000000000000000000' });
  expect(script.charCodeAt(0)).toBe(0xFEFF);
  expect(script).toContain('CHINESE_STDOUT=星丛技能中文输出');
  expect(script).toContain('CHINESE_STDERR=星丛技能中文错误');
  const parser = "[Console]::InputEncoding=[Text.UTF8Encoding]::new(); [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $text=[Console]::In.ReadToEnd(); $tokens=$null; $errors=$null; $ast=[Management.Automation.Language.Parser]::ParseInput($text,[ref]$tokens,[ref]$errors); if ($errors.Count) { throw $errors[0].Message }; $values=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.StringConstantExpressionAst]},$true) | ForEach-Object {$_.Value}); @{parsed=$true;values=$values} | ConvertTo-Json -Compress";
  const result = JSON.parse(execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', parser], { input: script, encoding: 'utf8', windowsHide: true }));
  expect(result.parsed).toBe(true);
  expect(result.values).toEqual(expect.arrayContaining([workspace, run, overwrite, deletion, 'SNAPSHOT_WRITE=DENIED']));
});
