import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'third_party', 'licenses');
const inputs = JSON.parse(fs.readFileSync(path.join(directory, 'inputs.json'), 'utf8'));
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const blocks = new Map();
const components = [];
const missing = [];

function resolveSource(relative) {
  const target = path.resolve(root, relative);
  if (!target.startsWith(root + path.sep)) throw new Error(`Source outside repository: ${relative}`);
  return target;
}

for (const component of inputs.components) {
  if (component.metadataPath) {
    const metadata = JSON.parse(fs.readFileSync(resolveSource(component.metadataPath), 'utf8'));
    if (metadata.version !== component.expectedHostVersion) throw new Error(`Dependency version changed: ${component.id}`);
  }
  const licenses = [];
  for (const sourcePath of component.noticeFiles) {
    const bytes = fs.readFileSync(resolveSource(sourcePath));
    const sha256 = hash(bytes);
    let block = blocks.get(sha256);
    if (!block) {
      block = { bytes, labels: [] };
      blocks.set(sha256, block);
    }
    block.labels.push(`${component.id} — ${sourcePath}`);
    licenses.push({ sourcePath, sha256, bytes: bytes.length });
  }
  if (!licenses.length) missing.push(component.id);
  components.push({ ...component, noticeFiles: undefined, licenses });
}

const buffers = [Buffer.from('ASTERIUM THIRD-PARTY LICENSES AND NOTICES\n\nThis file preserves upstream texts. It does not license Asterium itself or replace component terms. The component inventory is a conservative dependency closure, not proof that every listed component is shipped. See manifest.json and SOURCES.md for scope and unresolved items.\n')];
const sections = [];
let position = buffers[0].length;
for (const [sha256, block] of [...blocks].sort(([a], [b]) => a.localeCompare(b))) {
  const header = Buffer.from(`\n${'='.repeat(78)}\nSHA-256: ${sha256}\n${block.labels.sort().join('\n')}\n${'-'.repeat(78)}\n`);
  buffers.push(header, block.bytes, Buffer.from('\n'));
  sections.push({ sha256, offset: position + header.length, bytes: block.bytes.length });
  position += header.length + block.bytes.length + 1;
}
const aggregate = Buffer.concat(buffers);
const manifest = Buffer.from(JSON.stringify({
  schemaVersion: 1,
  scope: inputs.scope,
  sourceReviewDate: inputs.sourceReviewDate,
  packageLockSha256: hash(fs.readFileSync(path.join(root, 'package-lock.json'))),
  aggregateSha256: hash(aggregate),
  components,
  sections,
  missingLicenseText: missing,
  excludedOptionalPlatforms: inputs.excludedOptionalPlatforms,
  unresolvedItems: inputs.unresolvedItems,
  releaseClearance: 'not-granted; unresolved items remain',
}, null, 2) + '\n');

const outputs = [['THIRD_PARTY_LICENSES.txt', aggregate], ['manifest.json', manifest]];
if (process.argv.includes('--check')) {
  for (const [name, bytes] of outputs) {
    if (!fs.readFileSync(path.join(directory, name)).equals(bytes)) throw new Error(`Third-party notices out of date: ${name}`);
  }
} else {
  for (const [name, bytes] of outputs) fs.writeFileSync(path.join(directory, name), bytes);
}
for (const section of sections) {
  if (hash(aggregate.subarray(section.offset, section.offset + section.bytes)) !== section.sha256) throw new Error('License text bytes changed');
}
console.log(JSON.stringify({ mode: process.argv.includes('--check') ? 'check' : 'write', components: components.length, originalTexts: blocks.size, aggregateBytes: aggregate.length, missingLicenseText: missing, releaseClearance: 'not-granted' }));
if (missing.length) process.exitCode = 1;
