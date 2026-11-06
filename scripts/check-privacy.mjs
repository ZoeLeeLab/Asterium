import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
const hash = value => createHash('sha256').update(value).digest('hex');
const entries = bytes => bytes.toString('utf8').split('\0').filter(Boolean);
const media = /\.(?:png|jpe?g|webp|gif|bmp|ico|avif|heic|tiff?|mp4|webm|pdf)$/i;
const fixture = /^(?:tests|docs|examples|tools)\//;
const blockedNames = new Set([
  '6a9fec7faf975f2e5c0758f12eaf01993430358ba60bae15188ec8fb3c4c213c',
  '9e7c39e2063ac3c93cbf5494f314f030f947e83b4265c75a27101bf499be6c35',
  'da5a634993e1ba9b7ae073817b5fcf74c268abc1ccba458abf935299d95dae7f',
]);

// Public documentation references and protocol endpoints used by contract tests.
const publicHosts = new Set([
  'api-docs.deepseek.com', 'api.anthropic.com', 'api.deepseek.com', 'api.github.com',
  'api.moonshot.cn', 'api.openai.com', 'api.search.brave.com', 'api.siliconflow.cn',
  'code.claude.com', 'developers.openai.com', 'docs.github.com', 'docs.siliconflow.cn',
  'github.com', 'learn.microsoft.com', 'lite.duckduckgo.com', 'openai.com',
  'platform.claude.com', 'platform.kimi.com', 'release-assets.githubusercontent.com',
  'www.eclipse.org', 'www.electron.build', 'www.mozilla.org', 'www.w3.org',
]);
const syntheticHost = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|(?:[\w-]+\.)*example\.(?:com|org|net)|(?:[\w-]+\.)+(?:invalid|test|example|localhost))$/i;
const publicRepositories = new Set(['anqinou-art/mousecrew', 'anthropics/claude-code', 'example/asterium', 'zoeleelab/asterium']);
const testTailnet = /^(?:computer|isolated|server)\.tail-test\.ts\.net$/;

function scanText(text, strict, report, { checkUuids, allowPublicHosts, allowTestTailnet }) {
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const types = new Set();
    if (/\b(?:gh[pousr]_[\w-]{24,}|github_pat_[\w-]{30,}|sk-[\w-]{24,}|AKIA[A-Z0-9]{16}|xox[baprs]-[\w-]{12,})\b|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/i.test(line)
      || /\b(?:api[_-]?key|access[_-]?token|password|client[_-]?secret)["']?\s*[:=]\s*["'][a-z\d_/-]{24,}["']/i.test(line)) types.add('credential');
    if (/(?:[A-Z]:[\\/]+Users[\\/]+|\/(?:home|Users)\/)(?!fixture-user\b|QA\b|example-user\b)[\w.-]+|[A-Z]:[\\/]+(?:星丛|vault)|\/home\/ubuntu(?:\/|$)/i.test(line)) types.add('machine-path');
    if (strict) {
      if ([...line.normalize('NFC').matchAll(/(?=(\p{Script=Han}{2}))/gu)].some(match => blockedNames.has(hash(match[1])))) types.add('known-private-name');
      for (const [uuid] of (checkUuids ? line : '').matchAll(/\b[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\b/gi)) {
        if (!/^(?:0000000\d-0000-(?:0000|[47]000)-(?:0000|8000)-00000000000[\da-f]|([\da-f])\1{7}-\1{4}-\1{4}-\1{4}-\1{12})$/i.test(uuid)) types.add('opaque-uuid');
      }
      if (/\b(?:thread|sess|session)_[a-z\d]{16,}\b/i.test(line)) types.add('opaque-session-id');
      for (const match of line.matchAll(/\bhttps?:\/\/([^\s/\\\x22\x27<>)}\x60]+)/gi)) {
        const authority = match[1].replace(/[.,;]+$/, '');
        const host = authority.split('@').at(-1).split('$')[0].replace(/:\d*$/, '').toLowerCase();
        const allowedPublic = allowPublicHosts && publicHosts.has(host);
        if (!syntheticHost.test(host) && !(allowTestTailnet && testTailnet.test(host)) && !allowedPublic) types.add('unapproved-domain');
        if (allowedPublic && host === 'github.com') {
          const repository = line.slice(match.index + match[0].length).match(/^\/([\w.-]+\/[\w.-]+)/)?.[1];
          if (repository && !publicRepositories.has(repository.replace(/\.git$/, '').toLowerCase())) types.add('unapproved-repository');
        }
        if (authority.includes('@') && !/^(?:user:(?:pass|secret)|key:secret)@/.test(authority)) types.add('url-credential');
      }
      for (const match of line.matchAll(/[\w.+-]+@([\w.-]+\.[a-z]{2,})\b/gi)) {
        if (!syntheticHost.test(match[1]) && !['asterium.local', 'localhost.localdomain'].includes(match[1])) types.add('account-email');
      }
      if (/\b(?:private[_ -]?conversation|private[_ -]?chat|raw[_ -]?transcript)[_-][\w.-]+\.(?:jsonl?|md|txt)\b/i.test(line)) types.add('private-transcript-reference');
    }
    for (const type of types) report(index + 1, type);
  }
}

const args = process.argv.slice(2);
const mode = args[0];
if (args.length && !((mode === '--staged' && args.length === 1)
  || (mode === '--commit' && args.length === 2 && /^[a-f0-9]{40}$/.test(args[1]))
  || (mode === '--materials' && args.length === 2))) throw new Error('Usage: check:privacy [--staged | --commit <SHA> | --materials <directory>]');
const materialRoot = mode === '--materials' ? fs.realpathSync(args[1]) : null;
const base = materialRoot ?? root;
const list = materialRoot
  ? fs.readdirSync(base, { recursive: true }).map(name => name.split(path.sep).join('/'))
    .filter(name => !fs.lstatSync(path.join(base, name)).isDirectory())
  : entries(mode === '--commit' ? git('ls-tree', '-r', '--name-only', '-z', args[1])
    : git('ls-files', '-z', '--cached', ...(mode === '--staged' ? [] : ['--others', '--exclude-standard'])));
const read = name => {
  if (mode === '--commit' || mode === '--staged') return git('show', (mode === '--commit' ? args[1] : '') + ':' + name);
  const file = path.join(base, name);
  if (!fs.existsSync(file)) return null;
  const relative = path.relative(base, fs.realpathSync(file));
  if (fs.lstatSync(file).isSymbolicLink() || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Privacy scan refuses linked inputs');
  }
  return fs.readFileSync(file);
};
const manifest = 'scripts/privacy-media.json';
const approvedMedia = JSON.parse((materialRoot ? fs.readFileSync(path.join(root, manifest)) : read(manifest)).toString('utf8'));
const productMedia = materialRoot ? {} : Object.fromEntries(JSON.parse(read('docs/licensing/asset-provenance.json')).assets.map(asset => [asset.path, asset.sha256]));
if (materialRoot && list.length === 0) throw new Error('Release materials directory is empty');
const findings = [];
let checked = 0;
for (const name of new Set(list)) {
  if (!materialRoot && (/^(?:third_party|LICENSES)\//.test(name) || name === 'package-lock.json')) continue;
  const strict = Boolean(materialRoot) || fixture.test(name) || /^(?:README|.*\/README|CHANGELOG)[^/]*\.md$/i.test(name);
  const report = (line, type) => findings.push({ file: name, line, type });
  const rules = {
    checkUuids: materialRoot || name !== 'tools/installer/windows-shell.nsh',
    allowPublicHosts: !name.startsWith('examples/'),
    allowTestTailnet: !materialRoot && /^(?:tests|examples)\//.test(name),
  };
  scanText(name, strict, (_, type) => report(0, type), rules);
  if (/(?:^|\/)(?:\.env(?:\..*)?|auth\.json|credentials\.json|\.git|node_modules)(?:\/|$)|\.(?:sqlite3?|db|jsonl|pfx|pem|key|log|exe|dll|zip|7z|tar|gz)$/i.test(name)) report(0, 'private-artifact');
  if (!strict && !media.test(name) && !/\.(?:[cm]?[jt]sx?|json|ya?ml|md|txt|html|css|svg|ps1|nsh|nsi)$/i.test(name)) continue;
  const bytes = read(name);
  if (!bytes) continue;
  checked++;
  if (media.test(name)) {
    if ((approvedMedia[materialRoot ? 'materials/' + name : name] ?? productMedia[name]) !== hash(bytes)) report(0, 'media-review-required');
  } else if (bytes.includes(0)) {
    report(0, 'opaque-artifact');
  } else {
    scanText(bytes.toString('utf8'), strict, report, rules);
  }
}
for (const { file, line, type } of findings) console.error(JSON.stringify({ file, line, type }));
console.log('Privacy scan: ' + checked + ' files checked, ' + findings.length + ' findings');
if (findings.length) process.exitCode = 1;
