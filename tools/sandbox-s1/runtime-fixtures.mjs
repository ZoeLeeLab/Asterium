// Copies only existing runtime files into owned S1 fixtures. No installs or user data.
import { copyFile, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { assertOwnedPath } from './runner.mjs';

export async function stageRuntime(fixture, kind, source) {
  if (!['python', 'electron'].includes(kind) || !path.isAbsolute(source)) throw new Error('S1_INVALID_RUNTIME_SOURCE');
  const target = await assertOwnedPath(path.join(fixture.runDirectory, 'runtime', kind));
  const copy = async (from, to, relative = '') => {
    const info = await lstat(from);
    if (info.isSymbolicLink() || (!info.isDirectory() && info.nlink !== 1)) throw new Error('S1_RUNTIME_LINK_REFUSED');
    if (info.isDirectory()) {
      await mkdir(to, { recursive: true });
      for (const name of await readdir(from)) {
        const child = relative ? `${relative}/${name}` : name;
        const allowed = kind === 'python'
          ? child === 'Lib' || child === 'DLLs'
            || (child.startsWith('Lib/') && !child.split('/').some(part => ['site-packages', '__pycache__'].includes(part)) && !path.extname(name))
            || (child.startsWith('Lib/') && !child.split('/').some(part => ['site-packages', '__pycache__'].includes(part)) && name.endsWith('.py'))
            || (child.startsWith('DLLs/') && /\.(pyd|dll)$/i.test(name))
            || (!relative && (name === 'python.exe' || /\.dll$/i.test(name)))
          : !relative && (name === 'electron.exe' || /\.(dll|pak|bin|dat)$/i.test(name));
        if (allowed) await copy(path.join(from, name), path.join(to, name), child);
      }
    } else if (info.isFile()) await copyFile(from, to);
    else throw new Error('S1_RUNTIME_SPECIAL_FILE_REFUSED');
  };
  await copy(source, target);
  const executable = path.join(target, kind === 'python' ? 'python.exe' : 'electron.exe');
  if (!(await lstat(executable)).isFile()) throw new Error('S1_RUNTIME_EXECUTABLE_MISSING');
  return {
    executable,
    // Call only after helper confirms profile/ACL cleanup. Never remove the source.
    dispose: async () => {
      const checked = await assertOwnedPath(target);
      if (checked !== path.join(fixture.runDirectory, 'runtime', kind)) throw new Error('S1_RUNTIME_CLEANUP_PATH_MISMATCH');
      // Windows may release an exited image a little after its PID disappears.
      // Retry only deletion of this owned runtime copy, never the tool operation.
      await rm(checked, { recursive: true, force: false, maxRetries: 10, retryDelay: 100 });
    },
  };
}
