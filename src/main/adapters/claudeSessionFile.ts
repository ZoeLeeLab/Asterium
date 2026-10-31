import { open, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function readClaudeSessionFile(selectedPath: string, claudeProjectsRoot = path.join(os.homedir(), '.claude', 'projects')) {
  const root = await realpath(claudeProjectsRoot);
  const sessionFilePath = await realpath(selectedPath);
  const relative = path.relative(root, sessionFilePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.extname(sessionFilePath).toLowerCase() !== '.jsonl') throw new Error('INVALID_CLAUDE_SESSION_FILE');
  const handle = await open(sessionFilePath, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    let sessionId = '';
    let workingDirectory = '';
    for (const line of buffer.toString('utf8', 0, bytesRead).split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (!isRecord(value)) continue;
        if (!sessionId && typeof value.sessionId === 'string') sessionId = value.sessionId;
        if (!workingDirectory && typeof value.cwd === 'string') workingDirectory = value.cwd;
        if (sessionId && workingDirectory) break;
      } catch {
        // Ignore unrelated malformed lines and continue scanning the session header.
      }
    }
    if (!isUuid(sessionId) || path.basename(sessionFilePath, '.jsonl').toLowerCase() !== sessionId.toLowerCase() || !workingDirectory) throw new Error('INVALID_CLAUDE_SESSION_FILE');
    const resolvedDirectory = await realpath(workingDirectory);
    return { sessionId, sessionFilePath, workingDirectory: resolvedDirectory };
  } finally {
    await handle.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
