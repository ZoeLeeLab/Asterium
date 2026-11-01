import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = key => process.argv[process.argv.indexOf(key) + 1];
if (process.platform !== 'win32' || !process.argv.includes('--nsis') || !process.argv.includes('--output')) throw new Error('Use --nsis <verified makensis.exe> --output <fresh absolute diagnostic directory>');
const output = path.resolve(option('--output'));
if (!path.isAbsolute(option('--output')) || output === path.parse(output).root || output.startsWith(root + path.sep) || fs.existsSync(output)) throw new Error('Use a fresh diagnostic directory outside the repository');
fs.mkdirSync(output, { recursive: true });
const nsisValue = value => value.replaceAll('$', '$$').replaceAll('"', '$\\"');
const appId = 'Asterium.ShellDiagnostic.' + randomUUID();
const definitions = [`!define DIAGNOSTIC_DIR "${nsisValue(output)}"`, `!define PROJECT_DIR "${nsisValue(root)}"`, `!define DIAGNOSTIC_ID "${appId}"`];
const script = [...definitions,
  'Unicode true', 'Name "Asterium isolated shell diagnostic"', 'OutFile "${DIAGNOSTIC_DIR}\\shell-diagnostic.exe"',
  'RequestExecutionLevel user', 'SilentInstall silent', 'SilentUnInstall silent',
  '!include "${PROJECT_DIR}\\tools\\installer\\windows-shell.nsh"',
  'Section', 'SetOutPath "${DIAGNOSTIC_DIR}"', 'StrCpy $0 "register-sentinel"',
  'CreateShortCut "${DIAGNOSTIC_DIR}\\合成 空格 & shortcut.lnk" "$WINDIR\\System32\\notepad.exe"',
  '!insertmacro AsteriumSetLinkAppId "${DIAGNOSTIC_DIR}\\合成 空格 & shortcut.lnk" "${DIAGNOSTIC_ID}"',
  'FileOpen $R0 "${DIAGNOSTIC_DIR}\\results.txt" w', 'FileWrite $R0 "set=$AsteriumShellResult$\\r$\\nregister=$0$\\r$\\n"',
  '!insertmacro AsteriumSetLinkAppId "${DIAGNOSTIC_DIR}\\missing.lnk" "${DIAGNOSTIC_ID}"',
  'FileWrite $R0 "missing=$AsteriumShellResult$\\r$\\n"',
  '!insertmacro AsteriumUnpinShortcut "${DIAGNOSTIC_DIR}\\合成 空格 & shortcut.lnk"',
  'FileWrite $R0 "unpin=$AsteriumShellResult$\\r$\\n"',
  '!insertmacro AsteriumClearDestinations "${DIAGNOSTIC_ID}"',
  'FileWrite $R0 "destinations=$AsteriumShellResult$\\r$\\n"', 'FileClose $R0',
  'WriteUninstaller "${DIAGNOSTIC_DIR}\\shell-uninstall-diagnostic.exe"', 'SectionEnd',
  'Section "Uninstall"',
  '!insertmacro AsteriumSetLinkAppId "${DIAGNOSTIC_DIR}\\合成 空格 & shortcut.lnk" "${DIAGNOSTIC_ID}.Uninstall"',
  'FileOpen $R0 "${DIAGNOSTIC_DIR}\\uninstall-results.txt" w', 'FileWrite $R0 "set=$AsteriumShellResult$\\r$\\n"',
  '!insertmacro AsteriumClearDestinations "${DIAGNOSTIC_ID}"',
  'FileWrite $R0 "destinations=$AsteriumShellResult$\\r$\\n"', 'FileClose $R0', 'SectionEnd',
].join('\n');
fs.writeFileSync(path.join(output, 'diagnostic.nsi'), script);
const env = { ...process.env, TEMP: output, TMP: output };
const receipt = { status: 'failed', scope: 'Synthetic shortcuts and synthetic AppID only; no product installation, existing user data, real pinned shortcuts, explicit registry-write commands or model connections', appId, output };
function execute(label, executable, args) {
  try {
    const bytes = execFileSync(executable, args, { env, windowsHide: true, timeout: 30000, encoding: 'utf8' });
    fs.writeFileSync(path.join(output, label + '.log'), bytes);
  } catch (error) {
    fs.writeFileSync(path.join(output, label + '.log'), String(error.stdout ?? '') + String(error.stderr ?? '') + '\n' + error.message);
    throw error;
  }
}
const parse = filename => Object.fromEntries(fs.readFileSync(path.join(output, filename), 'utf8').trim().split(/\r?\n/).map(line => line.split('=')));
function readAppId() {
  const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
  const command = `$ProgressPreference = 'SilentlyContinue'; $shell = New-Object -ComObject Shell.Application; $folder = $shell.NameSpace(${psQuote(output)}); $folder.ParseName('合成 空格 & shortcut.lnk').ExtendedProperty('System.AppUserModel.ID')`;
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { env, windowsHide: true, encoding: 'utf8', timeout: 20000 }).trim();
}
try {
  execute('compile', option('--nsis'), ['-INPUTCHARSET', 'UTF8', '-V3', path.join(output, 'diagnostic.nsi')]);
  execute('run', path.join(output, 'shell-diagnostic.exe'), []);
  receipt.install = parse('results.txt');
  receipt.appIdReadThroughWindowsShell = readAppId();
  if (receipt.install.set !== '0' || receipt.appIdReadThroughWindowsShell !== appId || receipt.install.register !== 'register-sentinel' || Number(receipt.install.missing) >= 0 || receipt.install.destinations !== '0') throw new Error('Native shell diagnostic assertion failed');
  if (fs.existsSync(path.join(output, 'missing.lnk'))) throw new Error('Missing shortcut was unexpectedly created');
  receipt.unpin = Number(receipt.install.unpin) < 0 ? { status: 'unsupported', hresult: receipt.install.unpin, detail: 'Windows rejected this legacy interface; no actual user-pinned shortcut was changed or claimed tested' } : { status: 'returned-success-for-unpinned-synthetic-link' };
  execute('uninstall-run', path.join(output, 'shell-uninstall-diagnostic.exe'), ['_?=' + output]);
  receipt.uninstall = parse('uninstall-results.txt');
  receipt.uninstallAppIdReadThroughWindowsShell = readAppId();
  if (receipt.uninstall.set !== '0' || receipt.uninstall.destinations !== '0' || receipt.uninstallAppIdReadThroughWindowsShell !== appId + '.Uninstall') throw new Error('Uninstaller shell diagnostic assertion failed');
  receipt.status = 'passed';
} catch (error) { receipt.error = error.message; process.exitCode = 1; }
fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt));
