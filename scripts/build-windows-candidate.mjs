import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { betaInstallerConfiguration } from './windows-installer-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const output = option('--output'), phase = option('--phase'), commit = option('--commit');
if (process.platform !== 'win32' || process.arch !== 'x64' || !output || !path.isAbsolute(output) || !['application', 'installer'].includes(phase) || !/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('Usage: npm run build:candidate -- --phase application|installer --commit <existing SHA> --output <absolute fresh candidate directory>');
const destination = path.resolve(output);
if (destination === path.parse(destination).root || destination.startsWith(root + path.sep)) throw new Error('Candidate directory must be outside the source repository and not a drive root');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
if (git('rev-parse', 'HEAD') !== commit || git('status', '--porcelain')) throw new Error('Frozen commit must be current and the repository must be clean');
git('cat-file', '-e', `${commit}^{commit}`);
fs.mkdirSync(destination, { recursive: true });
for (const name of ['audit', 'tmp', 'cache', 'artifacts']) fs.mkdirSync(path.join(destination, name), { recursive: true });
const audit = path.join(destination, 'audit'), source = path.join(destination, 'source');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const save = (name, value) => fs.writeFileSync(path.join(audit, name), JSON.stringify(value, null, 2) + '\n');
const checks = json(path.join(audit, 'source-checks.json'));
const requiredChecks = ['typecheck', 'lint', 'capabilities', 'dependencies', 'unit', 'empty-start', 'renderer', 'sandbox', 'claude-bridge', 'studio-wake-build', 'studio-wake-test', 'automation-build', 'automation-test', 'notices', 'source-audit', 'claude-cli'];
if (checks.commit !== commit || checks.status !== 'passed' || !Array.isArray(checks.checks) || checks.checks.some(c => c.exitCode !== 0) || requiredChecks.some(name => !checks.checks.some(c => c.name === name && c.exitCode === 0))) throw new Error('Missing passing source checks for the frozen commit');
const environment = { ...process.env, TEMP: path.join(destination, 'tmp'), TMP: path.join(destination, 'tmp'), npm_config_cache: path.join(destination, 'cache/npm'), ELECTRON_CACHE: path.join(destination, 'cache/electron'), ELECTRON_BUILDER_CACHE: path.join(destination, 'cache/electron-builder'), CSC_IDENTITY_AUTO_DISCOVERY: 'false', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' };
for (const key of Object.keys(environment)) if (/^(?:GH_TOKEN|GITHUB_TOKEN|CSC_|WIN_CSC_|ANTHROPIC_|OPENAI_|AWS_|AZURE_)/.test(key)) delete environment[key];
const npmConfig = path.join(destination, 'cache/empty-npmrc'); fs.writeFileSync(npmConfig, '');
environment.npm_config_userconfig = npmConfig; environment.npm_config_globalconfig = npmConfig;
Object.assign(process.env, environment);
for (const key of Object.keys(process.env)) if (/^(?:GH_TOKEN|GITHUB_TOKEN|CSC_|WIN_CSC_|ANTHROPIC_|OPENAI_|AWS_|AZURE_)/.test(key)) delete process.env[key];
function command(label, executable, args, cwd) {
  const log = fs.openSync(path.join(audit, `${label}.log`), 'wx');
  try { execFileSync(executable, args, { cwd, env: environment, windowsHide: true, stdio: ['ignore', log, log], maxBuffer: 2 * 1024 * 1024 }); }
  finally { fs.closeSync(log); }
}

if (phase === 'application') {
  if (fs.existsSync(source) || fs.existsSync(path.join(audit, 'application-build.json'))) throw new Error('Application attempt already exists; use a new candidate directory');
  const archive = path.join(destination, `source-${commit}.tar`);
  execFileSync('git', ['archive', '--format=tar', '-o', archive, commit], { cwd: root, windowsHide: true });
  fs.mkdirSync(source);
  execFileSync('tar', ['-xf', archive, '-C', source], { windowsHide: true });
  const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', commit], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const manifest = [];
  for (const name of paths) {
    const original = execFileSync('git', ['show', `${commit}:${name}`], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
    const exported = fs.readFileSync(path.join(source, name));
    if (!original.equals(exported)) throw new Error(`Export differs from Git: ${name}`);
    manifest.push({ path: name, bytes: exported.length, sha256: digest(exported) });
  }
  save('source-export-manifest.json', { commit, archiveSha256: digest(fs.readFileSync(archive)), files: manifest });
  const npmCli = path.resolve(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  if (!fs.existsSync(npmCli)) throw new Error('Cannot locate npm CLI beside Node.js');
  command('clean-npm-ci', process.execPath, [npmCli, 'ci', '--no-audit', '--no-fund'], source);
  const requireSource = createRequire(path.join(source, 'package.json'));
  const core = requireSource('@electron-forge/core/dist/api/package').default;
  const configLoader = requireSource('@electron-forge/core/dist/util/forge-config');
  // Load the raw exported configuration, then let Forge initialize its plugins once.
  const { createJiti } = requireSource('jiti');
  const loadedConfig = await createJiti(path.join(source, 'package.json')).import(path.join(source, 'forge.config.ts'));
  const config = loadedConfig.default ?? loadedConfig;
  config.packagerConfig.afterCopy = [...(config.packagerConfig.afterCopy ?? []), (buildPath, _version, _platform, _arch, done) => {
    try {
      const walk = directory => { for (const item of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, item.name); if (item.isDirectory()) walk(file); else if (file.endsWith('.map')) fs.unlinkSync(file); else if (/\.(?:js|mjs|cjs)$/.test(file)) { const text = fs.readFileSync(file, 'utf8'); const clean = text.replace(/^\/\/# sourceMappingURL=.*(?:\r?\n|$)/gm, ''); if (clean !== text) fs.writeFileSync(file, clean); } } };
      walk(buildPath); done();
    } catch (error) { done(error); }
  }];
  configLoader.registerForgeConfigForDirectory(source, config);
  const previousDirectory = process.cwd(); process.chdir(source);
  let packages;
  try { packages = await core({ dir: source, outDir: path.join(destination, 'application'), platform: 'win32', arch: 'x64', interactive: false }); }
  finally { process.chdir(previousDirectory); }
  const application = packages[0]?.packagedPath;
  if (packages.length !== 1 || !fs.existsSync(path.join(application, 'Asterium.exe'))) throw new Error('Unexpected application output');
  save('application-build.json', { status: 'built', commit, application, archiveSha256: digest(fs.readFileSync(archive)), freshDependencyInstall: true, installerExecuted: false });
  console.log(JSON.stringify({ status: 'built', commit, application }));
} else {
  const receipt = json(path.join(audit, 'application-build.json'));
  const packaged = json(path.join(audit, 'packaged-checks.json'));
  const payload = json(path.join(audit, 'application-audit.json'));
  const requiredPackaged = ['startup', 'memory-sqlite', 'extensions', 'api-providers'];
  if (receipt.commit !== commit || receipt.status !== 'built' || packaged.commit !== commit || packaged.checks.length !== 4 || requiredPackaged.some(name => !packaged.checks.some(c => c.name === name && c.exitCode === 0)) || payload.commit !== commit || payload.status !== 'passed') throw new Error('Application checks and payload audit must pass before installer build');
  if (fs.existsSync(path.join(audit, 'installer-build.json'))) throw new Error('Installer attempt already exists; do not overwrite candidate evidence');
  const requireSource = createRequire(path.join(source, 'package.json'));
  const packageInfo = json(path.join(source, 'package.json'));
  const builder = requireSource('electron-builder');
  const config = betaInstallerConfiguration({ projectRoot: source, outputDirectory: path.join(destination, 'artifacts'), version: packageInfo.version, commit, electronVersion: packageInfo.devDependencies.electron });
  save('installer-config.json', config);
  const outputs = await builder.build({ projectDir: source, prepackaged: receipt.application, targets: builder.Platform.WINDOWS.createTarget(['nsis'], builder.Arch.x64), config, publish: 'never' });
  save('installer-build.json', { status: 'built', commit, outputs, signed: false, installerExecuted: false, ordinaryAccountAcceptance: 'pending' });
  console.log(JSON.stringify({ status: 'built', commit, outputs }));
}
