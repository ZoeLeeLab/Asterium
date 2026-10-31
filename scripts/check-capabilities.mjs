import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';

const fields = ['name', 'id', 'appliesTo', 'protocols', 'permissionBoundary', 'status', 'codeEntries', 'tests', 'docs', 'lastVerifiedCommit'];
const arrays = ['appliesTo', 'protocols', 'codeEntries', 'tests', 'docs'];
export function validateEntry(source, { ids, exists, commitExists, committedPathExists }) {
  const errors = [];
  let entry;
  try {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
    if (!match) throw new Error('Missing frontmatter');
    entry = parse(match[1], { uniqueKeys: true });
  } catch { return ['Invalid YAML frontmatter']; }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return ['Invalid entry'];
  for (const key of fields) if (!(key in entry)) errors.push(`Missing ${key}`);
  for (const key of Object.keys(entry)) if (!fields.includes(key)) errors.push(`Unknown ${key}`);
  for (const key of ['name', 'permissionBoundary']) if (typeof entry[key] !== 'string' || !entry[key].trim()) errors.push(`Invalid ${key}`);
  if (typeof entry.id !== 'string' || !/^asterium\.[a-z][a-z0-9.-]*$/.test(entry.id)) errors.push('Invalid id');
  else if (ids.has(entry.id)) errors.push(`Duplicate id ${entry.id}`);
  else ids.add(entry.id);
  if (!['stable', 'experimental', 'deprecated'].includes(entry.status)) errors.push('Invalid status');
  for (const key of arrays) if (!Array.isArray(entry[key]) || !entry[key].length || entry[key].some(v => typeof v !== 'string' || !v.trim())) errors.push(`Invalid ${key}`);
  const validCommit = typeof entry.lastVerifiedCommit === 'string' && /^[a-f0-9]{40}$/.test(entry.lastVerifiedCommit) && commitExists(entry.lastVerifiedCommit);
  if (!validCommit) errors.push('Invalid lastVerifiedCommit');
  for (const key of ['codeEntries', 'tests', 'docs']) {
    for (const value of Array.isArray(entry[key]) ? entry[key] : []) {
      if (typeof value !== 'string' || value.includes('\\') || path.posix.isAbsolute(value) || /(^|\/)\.\.(\/|$)/.test(value) || /^[a-z]:/i.test(value) || !exists(value)) errors.push(`Invalid path ${key}: ${value}`);
      else if (key === 'codeEntries' && validCommit && !committedPathExists(entry.lastVerifiedCommit, value)) errors.push(`Code absent at commit: ${value}`);
    }
  }
  return errors;
}

export function checkCapabilities(root) {
  const git = args => {
    try { execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, ...args], { cwd: root, stdio: 'ignore' }); return true; }
    catch { return false; }
  };
  const ids = new Set();
  const commits = new Map();
  const index = fs.readFileSync(path.join(root, 'docs/capabilities/index.md'), 'utf8');
  const directory = path.join(root, 'docs/capabilities/entries');
  const errors = [];
  const files = fs.readdirSync(directory).filter(file => file.endsWith('.md')).sort();
  if (!files.length) errors.push('No capability entries');
  for (const file of files) {
    const problems = validateEntry(fs.readFileSync(path.join(directory, file), 'utf8'), {
      ids,
      exists: value => fs.existsSync(path.join(root, value)) && fs.statSync(path.join(root, value)).isFile(),
      commitExists: sha => { if (!commits.has(sha)) commits.set(sha, git(['cat-file', '-e', `${sha}^{commit}`])); return commits.get(sha); },
      committedPathExists: (sha, value) => git(['cat-file', '-e', `${sha}:${value}`]),
    });
    if (!index.includes(`(entries/${file})`)) problems.push('Missing index link');
    errors.push(...problems.map(problem => `${file}: ${problem}`));
  }
  return { count: files.length, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkCapabilities(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  if (result.errors.length) { console.error(result.errors.join('\n')); process.exitCode = 1; }
  else console.log(`Capabilities verified: ${result.count}`);
}
