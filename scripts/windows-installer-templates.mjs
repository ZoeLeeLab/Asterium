import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

// Keep electron-builder's installation, upgrade and uninstall behavior. Replace
// only its shell calls in a verified temporary copy, never in node_modules.
export function prepareWindowsInstallerTemplates({ projectRoot, destination }) {
  const requireProject = createRequire(path.join(projectRoot, 'package.json'));
  const libraryRoot = path.dirname(requireProject.resolve('app-builder-lib/package.json'));
  const source = path.join(libraryRoot, 'templates', 'nsis');
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'tools/installer/upstream-template-manifest.json'), 'utf8'));
  if (requireProject('app-builder-lib/package.json').version !== manifest.version) throw new Error('Installer template version changed; review required');
  const absoluteDestination = path.resolve(destination);
  const relativeDestination = path.relative(path.resolve(projectRoot), absoluteDestination);
  const insideProject = relativeDestination === '' || (!path.isAbsolute(relativeDestination) && relativeDestination !== '..' && !relativeDestination.startsWith('..' + path.sep));
  if (!path.isAbsolute(destination) || absoluteDestination === path.parse(absoluteDestination).root || insideProject || fs.existsSync(absoluteDestination)) throw new Error('Installer templates require a fresh directory outside the repository');
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink()) throw new Error('Unexpected symlink in installer templates');
    return entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)];
  });
  const files = walk(source).map(file => path.relative(source, file).replaceAll(path.sep, '/')).sort();
  if (JSON.stringify(files) !== JSON.stringify(manifest.files.map(file => file.path).sort())) throw new Error('Installer template file list changed; review required');
  for (const entry of manifest.files) if (sha(fs.readFileSync(path.join(source, entry.path))) !== entry.sha256) throw new Error(`Installer template changed: ${entry.path}`);
  fs.mkdirSync(absoluteDestination, { recursive: true });
  const replacements = { SetLnkAUMI: 0, UninstShortcut: 0, UninstAppUserModelId: 0 };
  const macros = { SetLnkAUMI: 'AsteriumSetLinkAppId', UninstShortcut: 'AsteriumUnpinShortcut', UninstAppUserModelId: 'AsteriumClearDestinations' };
  for (const entry of manifest.files) {
    const original = fs.readFileSync(path.join(source, entry.path));
    let bytes = original;
    if (['include/installer.nsh', 'uninstaller.nsh'].includes(entry.path)) {
      const text = original.toString('utf8').replace(/WinShell::(SetLnkAUMI|UninstShortcut|UninstAppUserModelId)\b/g, (_, name) => {
        replacements[name]++; return `!insertmacro ${macros[name]}`;
      });
      bytes = Buffer.from('!include "${PROJECT_DIR}\\tools\\installer\\windows-shell.nsh"\n' + text);
    }
    if (/\.(?:nsh|nsi)$/.test(entry.path) && bytes.includes(Buffer.from('WinShell::'))) throw new Error(`Unreviewed shell plug-in use: ${entry.path}`);
    const target = path.join(absoluteDestination, entry.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, { flag: 'wx' });
  }
  if (replacements.SetLnkAUMI !== 5 || replacements.UninstShortcut !== 4 || replacements.UninstAppUserModelId !== 1) throw new Error('Installer shell replacement counts changed');
  return { directory: absoluteDestination, version: manifest.version, replacements, files: walk(absoluteDestination).map(file => ({ path: path.relative(absoluteDestination, file).replaceAll(path.sep, '/'), sha256: sha(fs.readFileSync(file)) })) };
}
