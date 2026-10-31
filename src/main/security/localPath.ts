import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Normalize paths reported by Windows-native tools, Git Bash, WSL, and file URLs. */
export function normalizeReportedLocalPath(value: string, baseDirectory = process.cwd()) {
  const input = value.trim();
  if (!input) throw new Error('LOCAL_PATH_REQUIRED');
  if (/^file:/i.test(input)) return path.normalize(fileURLToPath(input));
  if (process.platform === 'win32') {
    const wsl = /^[/\\]mnt[/\\]([a-zA-Z])[/\\](.*)$/.exec(input);
    if (wsl) return path.win32.normalize(`${wsl[1].toUpperCase()}:\\${wsl[2].replace(/\//g, '\\')}`);
    const gitBash = /^[/\\]([a-zA-Z])[/\\](.*)$/.exec(input);
    if (gitBash) return path.win32.normalize(`${gitBash[1].toUpperCase()}:\\${gitBash[2].replace(/\//g, '\\')}`);
    if (/^[a-zA-Z]:[\\/]/.test(input)) return path.win32.normalize(input.replace(/\//g, '\\'));
    if (/^(?:\\\\|\/\/)/.test(input)) return path.win32.normalize(input.replace(/\//g, '\\'));
  }
  return path.resolve(baseDirectory, input);
}
