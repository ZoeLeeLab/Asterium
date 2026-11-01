import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const upstreamSha256 = '3687ab4e09005a8a0b93c1a07a36285d93466070e94b8bf6f12781fb53c419e1';
const prefix = 'stdutils-4e1117321001e54dcd2c52f72d3c359d5215e426/';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Read, never execute, the hash-pinned upstream archive. Keep required import
// libraries: they are declared build inputs, not a claim of source-built tools.
export function prepareStdUtilsSource({ archive, destination }) {
  const target = path.resolve(destination);
  const relative = path.relative(root, target);
  if (!path.isAbsolute(destination) || target === path.parse(target).root || relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)) || fs.existsSync(target)) throw new Error('Use a fresh directory outside the repository');
  if (sha(fs.readFileSync(archive)) !== upstreamSha256) throw new Error('Unexpected StdUtils upstream archive');
  const names = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(name => !name.endsWith('/')).sort();
  if (new Set(names).size !== names.length) throw new Error('Duplicate upstream paths');
  const retained = [], excluded = [], blocks = [], files = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || name.includes('\\') || name.slice(prefix.length).split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unexpected upstream path');
    const local = name.slice(prefix.length);
    const bytes = execFileSync('tar', ['-xOf', archive, name], { maxBuffer: 8 * 1024 * 1024 });
    const record = { file: local, bytes: bytes.length, sha256: sha(bytes) };
    if (/\.(exe|aps|vcxproj\.user)$/i.test(local)) { excluded.push(record); continue; }
    retained.push(record);
    files.push({ name: `stdutils-1.14/${local}`, bytes });
    if (/Contrib\/StdUtils\/(src\/(rhash|blake2)|include)\/.+\.(c|cpp|h)$/.test(local)) {
      const header = bytes.toString('utf8').match(/^\s*(\/\*[\s\S]*?\*\/)/)?.[1];
      if (header) blocks.push(`===== ${local} (source SHA-256 ${record.sha256}) =====\n${header}\n`);
    }
  }
  if (excluded.length !== 4 || retained.length < 80) throw new Error('Unexpected upstream inventory');
  // USTAR with fixed metadata: identical retained bytes yield identical output.
  const chunks = [];
  for (const { name, bytes } of files) {
    const header = Buffer.alloc(512);
    let filename = name, directory = '';
    if (Buffer.byteLength(filename) > 100) { const split = name.lastIndexOf('/'); directory = name.slice(0, split); filename = name.slice(split + 1); }
    if (Buffer.byteLength(filename) > 100 || Buffer.byteLength(directory) > 155) throw new Error('USTAR path too long');
    header.write(filename, 0, 100);
    for (const [offset, length, value] of [[100, 8, 0o644], [108, 8, 0], [116, 8, 0], [124, 12, bytes.length], [136, 12, 0]]) header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write('ustar\0', 257, 6); header.write('00', 263, 2); header.write(directory, 345, 155);
    header.write(header.reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  const output = gzipSync(Buffer.concat(chunks), { level: 9 });
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'stdutils-1.14-reviewed.tar.gz'), output, { flag: 'wx' });
  const receipt = { schemaVersion: 1, upstreamSha256, output: { file: 'stdutils-1.14-reviewed.tar.gz', bytes: output.length, sha256: sha(output) }, retained, excluded, limitation: 'Retained source bytes are unchanged. Required upstream .lib build inputs are retained; excluded Date.exe/Zip.exe packaging helpers and IDE files are not needed by the DLL project. No byte-identical rebuild is asserted. Original archive is preserved separately as audit evidence.' };
  fs.writeFileSync(path.join(target, 'stdutils-source-review.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  fs.writeFileSync(path.join(target, 'NESTED-NOTICES.txt'), blocks.join('\n'), { flag: 'wx' });
  for (const [subdir, filename] of [['rhash', 'RHash-COPYING.txt'], ['blake2', 'BLAKE2-CC0.txt']]) fs.writeFileSync(path.join(target, filename), execFileSync('tar', ['-xOf', archive, `${prefix}Contrib/StdUtils/src/${subdir}/COPYING.txt`]), { flag: 'wx' });
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
  const archive = option('--archive'), destination = option('--output');
  if (!archive || !destination) throw new Error('Use --archive <fixed upstream archive> --output <fresh directory>');
  const receipt = prepareStdUtilsSource({ archive, destination });
  console.log(JSON.stringify({ ...receipt.output, retained: receipt.retained.length, excluded: receipt.excluded.length }));
}
