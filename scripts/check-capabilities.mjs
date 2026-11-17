import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';

const fields = ['name', 'id', 'appliesTo', 'protocols', 'permissionBoundary', 'status', 'codeEntries', 'tests', 'docs', 'lastVerifiedCommit'];
const arrays = ['appliesTo', 'protocols', 'codeEntries', 'tests', 'docs'];

function parseEntry(source) {
  try {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
    if (!match) throw new Error('Missing frontmatter');
    return { entry: parse(match[1], { uniqueKeys: true }) };
  } catch { return { invalidFrontmatter: true }; }
}

function isCommitHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
}

function isExistingPath(value, exists) {
  return typeof value === 'string' && !value.includes('\\') && !path.posix.isAbsolute(value)
    && !/(^|\/)\.\.(\/|$)/.test(value) && !/^[a-z]:/i.test(value) && exists(value);
}

function validateParsedEntry({ entry, invalidFrontmatter }, { ids, exists, commitExists, committedPathExists }) {
  if (invalidFrontmatter) return ['Invalid YAML frontmatter'];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return ['Invalid entry'];
  const errors = [];
  for (const key of fields) if (!(key in entry)) errors.push(`Missing ${key}`);
  for (const key of Object.keys(entry)) if (!fields.includes(key)) errors.push(`Unknown ${key}`);
  for (const key of ['name', 'permissionBoundary']) if (typeof entry[key] !== 'string' || !entry[key].trim()) errors.push(`Invalid ${key}`);
  if (typeof entry.id !== 'string' || !/^asterium\.[a-z][a-z0-9.-]*$/.test(entry.id)) errors.push('Invalid id');
  else if (ids.has(entry.id)) errors.push(`Duplicate id ${entry.id}`);
  else ids.add(entry.id);
  if (!['stable', 'experimental', 'deprecated'].includes(entry.status)) errors.push('Invalid status');
  for (const key of arrays) if (!Array.isArray(entry[key]) || !entry[key].length || entry[key].some(v => typeof v !== 'string' || !v.trim())) errors.push(`Invalid ${key}`);
  const validCommit = isCommitHash(entry.lastVerifiedCommit) && commitExists(entry.lastVerifiedCommit);
  if (!validCommit) errors.push('Invalid lastVerifiedCommit');
  for (const key of ['codeEntries', 'tests', 'docs']) {
    for (const value of Array.isArray(entry[key]) ? entry[key] : []) {
      if (!isExistingPath(value, exists)) errors.push(`Invalid path ${key}: ${value}`);
      else if (key === 'codeEntries' && validCommit && !committedPathExists(entry.lastVerifiedCommit, value)) errors.push(`Code absent at commit: ${value}`);
    }
  }
  return errors;
}

export function validateEntry(source, checks) {
  return validateParsedEntry(parseEntry(source), checks);
}

function existingGitRefs(root, refs) {
  if (!refs.length) return new Set();
  try {
    const output = execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, 'cat-file', '--batch-check=%(objectname) %(objecttype)', '-Z'], {
      cwd: root, input: refs.join('\0') + '\0', encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'],
    });
    const records = output.split('\0');
    if (records.pop() !== '' || records.length !== refs.length) return new Set();
    return new Set(refs.filter((_, index) => /^(?:[a-f0-9]{40}|[a-f0-9]{64}) (?:blob|tree|commit|tag)$/.test(records[index])));
  } catch { return new Set(); }
}

export function checkCapabilities(root) {
  const ids = new Set();
  const exists = value => fs.existsSync(path.join(root, value)) && fs.statSync(path.join(root, value)).isFile();
  const index = fs.readFileSync(path.join(root, 'docs/capabilities/index.md'), 'utf8');
  const directory = path.join(root, 'docs/capabilities/entries');
  const errors = [];
  const files = fs.readdirSync(directory).filter(file => file.endsWith('.md')).sort();
  const entries = files.map(file => ({ file, parsed: parseEntry(fs.readFileSync(path.join(directory, file), 'utf8')) }));
  const refs = new Set();
  for (const { parsed: { entry } } of entries) {
    const sha = entry?.lastVerifiedCommit;
    if (!isCommitHash(sha)) continue;
    refs.add(`${sha}^{commit}`);
    for (const value of Array.isArray(entry.codeEntries) ? entry.codeEntries : []) {
      if (isExistingPath(value, exists)) refs.add(`${sha}:${value}`);
    }
  }
  const existing = existingGitRefs(root, [...refs]);
  if (!files.length) errors.push('No capability entries');
  for (const { file, parsed } of entries) {
    const problems = validateParsedEntry(parsed, {
      ids, exists,
      commitExists: sha => existing.has(`${sha}^{commit}`),
      committedPathExists: (sha, value) => existing.has(`${sha}:${value}`),
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
