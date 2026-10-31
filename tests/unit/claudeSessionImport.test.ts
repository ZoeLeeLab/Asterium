import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readClaudeSessionFile } from '../../src/main/adapters/claudeSessionFile';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Claude session import', () => {
  it('extracts and verifies the session ID and original working directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-claude-session-'));
    directories.push(root);
    const projects = path.join(root, 'projects');
    const workspace = path.join(root, 'workspace');
    const project = path.join(projects, 'K--workspace');
    await mkdir(project, { recursive: true });
    await mkdir(workspace);
    const sessionId = '417878a2-0066-4471-b81f-67a37418b7c0';
    const sessionFile = path.join(project, `${sessionId}.jsonl`);
    await writeFile(sessionFile, [
      JSON.stringify({ type: 'queue-operation', sessionId }),
      JSON.stringify({ type: 'user', sessionId, cwd: workspace }),
    ].join('\n'));

    await expect(readClaudeSessionFile(sessionFile, projects)).resolves.toEqual({
      sessionId,
      sessionFilePath: await realpath(sessionFile),
      workingDirectory: await realpath(workspace),
    });
  });

  it('rejects a JSONL file outside the Claude projects root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-claude-session-outside-'));
    directories.push(root);
    const projects = path.join(root, 'projects');
    await mkdir(projects);
    const outside = path.join(root, '417878a2-0066-4471-b81f-67a37418b7c0.jsonl');
    await writeFile(outside, '{}');
    await expect(readClaudeSessionFile(outside, projects)).rejects.toThrow('INVALID_CLAUDE_SESSION_FILE');
  });
});
