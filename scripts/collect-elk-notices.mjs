import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Optional maintainer tool: yauzl is already locked through the Windows build tools.
// Normal notice verification uses the committed outputs and does not need source JARs.
const require = createRequire(import.meta.url);
const yauzl = require('yauzl');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceOption = process.argv.indexOf('--sources');
if (sourceOption < 0 || !process.argv[sourceOption + 1]) throw new Error('Use --sources <directory containing the fixed source JARs> [--check]');
const sources = path.resolve(process.argv[sourceOption + 1]);
const output = path.join(root, 'third_party', 'elkjs', '0.9.3');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const artifacts = [
  ['gwt-user', '2.10.0', 'gwt-user-2.10.0-sources.jar', '731ff22188418a1dfaca30c8956ea107e87219ba7c4fb32d2f059ede317660b9', 'org/gwtproject/gwt-user/2.10.0/gwt-user-2.10.0-sources.jar'],
  ['guava', '31.1-jre', 'guava-31.1-jre-sources.jar', '8ab1853cdaf936ec88be80c17302b7c20abafbd4f54d4fb54d7011c529e3a44a', 'com/google/guava/guava/31.1-jre/guava-31.1-jre-sources.jar'],
  ['guava-gwt', '31.1-jre', 'guava-gwt-31.1-jre.jar', '1f84944b947395d6a4302475284ccfedc5876be354e0926fbe794e41f8acfd23', 'com/google/guava/guava-gwt/31.1-jre/guava-gwt-31.1-jre.jar'],
  ['emf-common', '2.12.4', 'emf-common-2.12.4-sources.jar', '8dfc4e97ca8eee5474927e2b0c5f3bdbd9a52dcd5dff8c0b433b1e938b843bbe', 'com/genmymodel/emf/gwt/emf-common/2.12.4/emf-common-2.12.4-sources.jar'],
  ['emf-ecore', '2.12.4', 'emf-ecore-2.12.4-sources.jar', 'dd3b8c1c3bd0a27c1fbba908bcf0ff21a999148da4e68b3546bcde1dbce7b13a', 'com/genmymodel/emf/gwt/emf-ecore/2.12.4/emf-ecore-2.12.4-sources.jar'],
  ['xtext-xbase-lib', '2.28.0', 'xtext-xbase-lib-2.28.0-sources.jar', '2b35e9ccd4308f605e213371bb26f458b6a84bbd1e3a13cecaac0eba607db69f', 'org/eclipse/xtext/org.eclipse.xtext.xbase.lib/2.28.0/org.eclipse.xtext.xbase.lib-2.28.0-sources.jar'],
];

function headersFromJar(bytes) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(error);
      const entries = [];
      let total = 0;
      zip.on('error', reject);
      zip.on('end', () => resolve(entries));
      zip.on('entry', entry => {
        if (entry.fileName.startsWith('/') || entry.fileName.includes('\\') || entry.fileName.split('/').includes('..')) {
          zip.close(); return reject(new Error('Unsafe source entry'));
        }
        if (!entry.fileName.endsWith('.java')) { zip.readEntry(); return; }
        total += entry.uncompressedSize;
        if (entry.uncompressedSize > 4 * 1024 * 1024 || total > 128 * 1024 * 1024) {
          zip.close(); return reject(new Error('Unexpected source archive size'));
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return reject(streamError);
          const chunks = [];
          stream.on('error', reject);
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('end', () => {
            const content = Buffer.concat(chunks);
            const text = content.toString('utf8');
            const match = /^(?:\uFEFF|\s|\/\/[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)*?((?:\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))*)/.exec(text);
            const header = match ? content.subarray(0, Buffer.byteLength(match[0], 'utf8')) : Buffer.alloc(0);
            entries.push({ path: entry.fileName, header });
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

fs.mkdirSync(output, { recursive: true });
const manifests = [];
for (const [name, version, archive, digest, location] of artifacts) {
  const bytes = fs.readFileSync(path.join(sources, archive));
  if (sha(bytes) !== digest) throw new Error(`Source hash mismatch: ${archive}`);
  const entries = (await headersFromJar(bytes)).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const blocks = new Map();
  const noHeader = [];
  for (const entry of entries) {
    if (!entry.header.length) { noHeader.push(entry.path); continue; }
    const hash = sha(entry.header);
    if (!blocks.has(hash)) blocks.set(hash, { header: entry.header, paths: [] });
    blocks.get(hash).paths.push(entry.path);
  }
  const buffers = [Buffer.from(`${name} ${version}: original source-file headers\n\nConservative collection from the fixed upstream source JAR. Headers are preserved as bytes, including copyright and license notices; this does not claim every source file is included in Asterium. Full preferred source: https://repo.maven.apache.org/maven2/${location}\nArchive SHA-256: ${digest}\n`)];
  const sections = [];
  let offset = buffers[0].length;
  for (const [hash, block] of [...blocks].sort(([a], [b]) => a.localeCompare(b))) {
    const label = Buffer.from(`\n${'='.repeat(72)}\nHeader SHA-256: ${hash}\n${block.paths.join('\n')}\n${'-'.repeat(72)}\n`);
    buffers.push(label, block.header, Buffer.from('\n'));
    sections.push({ sha256: hash, offset: offset + label.length, bytes: block.header.length });
    offset += label.length + block.header.length + 1;
  }
  const result = Buffer.concat(buffers);
  for (const section of sections) if (sha(result.subarray(section.offset, section.offset + section.bytes)) !== section.sha256) throw new Error('Header bytes changed');
  const filename = `${name}-${version}-NOTICES.txt`;
  if (process.argv.includes('--check')) {
    if (!fs.readFileSync(path.join(output, filename)).equals(result)) throw new Error(`Stale headers: ${filename}`);
  } else fs.writeFileSync(path.join(output, filename), result);
  manifests.push({ name, version, archive, sourceUrl: `https://repo.maven.apache.org/maven2/${location}`, archiveSha256: digest, javaFiles: entries.length, filesWithoutLeadingHeader: noHeader, noticeFile: filename, noticeSha256: sha(result), sections });
}
const manifest = Buffer.from(JSON.stringify({ scope: 'Conservative original Java source-file headers from the fixed dependencies declared by elkjs 0.9.3; not an exact binary SBOM', artifacts: manifests }, null, 2) + '\n');
if (process.argv.includes('--check')) {
  if (!fs.readFileSync(path.join(output, 'source-notices.json')).equals(manifest)) throw new Error('Stale header manifest');
} else fs.writeFileSync(path.join(output, 'source-notices.json'), manifest);
console.log(JSON.stringify(manifests.map(({ name, javaFiles, filesWithoutLeadingHeader, sections }) => ({ name, javaFiles, noHeader: filesWithoutLeadingHeader.length, headers: sections.length }))));
