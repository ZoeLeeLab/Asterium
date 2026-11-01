// @vitest-environment node
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-expect-error Standalone Node build module.
import { prepareWindowsInstallerTemplates } from '../../scripts/windows-installer-templates.mjs';

const require = createRequire(import.meta.url);
const sourceRoot = path.resolve(import.meta.dirname, '../..');
const libraryRoot = path.dirname(require.resolve('app-builder-lib/package.json'));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asterium-installer-templates-'));
  const projectRoot = path.join(root, '移动后 项目');
  const templates = path.join(projectRoot, 'node_modules/app-builder-lib/templates/nsis');
  fs.mkdirSync(path.join(projectRoot, 'tools/installer'), { recursive: true });
  fs.mkdirSync(templates, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'package.json'), '{}');
  fs.copyFileSync(path.join(libraryRoot, 'package.json'), path.join(projectRoot, 'node_modules/app-builder-lib/package.json'));
  fs.cpSync(path.join(libraryRoot, 'templates/nsis'), templates, { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, 'tools/installer/upstream-template-manifest.json'), path.join(projectRoot, 'tools/installer/upstream-template-manifest.json'));
  return { projectRoot, templates, destination: path.join(root, 'compiler-templates') };
}

describe('Windows installer template source adapter', () => {
  it('keeps the upstream behaviors and replaces every shell call in a relocated build copy', () => {
    const state = fixture();
    const original = fs.readFileSync(path.join(state.templates, 'include/installer.nsh'));
    const result = prepareWindowsInstallerTemplates(state);
    expect(result.replacements).toEqual({ SetLnkAUMI: 5, UninstShortcut: 4, UninstAppUserModelId: 1 });
    const installer = fs.readFileSync(path.join(state.destination, 'include/installer.nsh'), 'utf8');
    const uninstaller = fs.readFileSync(path.join(state.destination, 'uninstaller.nsh'), 'utf8');
    expect(installer + uninstaller).not.toContain('WinShell::');
    expect(uninstaller).toContain('!insertmacro AsteriumClearDestinations');
    expect(uninstaller).toContain('!ifmacrodef customRemoveFiles');
    expect(uninstaller).toContain('DELETE_APP_DATA_ON_UNINSTALL');
    expect(fs.readFileSync(path.join(state.templates, 'include/installer.nsh')).equals(original)).toBe(true);
    expect(fs.readFileSync(path.join(state.destination, 'installSection.nsh')).equals(fs.readFileSync(path.join(state.templates, 'installSection.nsh')))).toBe(true);
  });
  it('fails before output if a locked upstream template changes', () => {
    const state = fixture();
    fs.appendFileSync(path.join(state.templates, 'uninstaller.nsh'), '\n; changed upstream\n');
    expect(() => prepareWindowsInstallerTemplates(state)).toThrow('Installer template changed');
    expect(fs.existsSync(state.destination)).toBe(false);
  });
  it('preserves existing output and refuses an output directory inside source', () => {
    const state = fixture();
    fs.mkdirSync(state.destination);
    fs.writeFileSync(path.join(state.destination, 'sentinel.txt'), 'preserve');
    expect(() => prepareWindowsInstallerTemplates(state)).toThrow('fresh directory');
    expect(fs.readFileSync(path.join(state.destination, 'sentinel.txt'), 'utf8')).toBe('preserve');
    expect(() => prepareWindowsInstallerTemplates({ ...state, destination: path.join(state.projectRoot, 'out') })).toThrow('fresh directory');
  });
});
