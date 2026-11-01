import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

// No downloads, model access, extraction, execution or key material. All source
// inputs must already be available and match the reviewed public-source hashes.
export function prepareSourceMaterials({ projectRoot = root, cacheDirectory, destination }) {
  const target = path.resolve(destination);
  const relative = path.relative(projectRoot, target);
  if (!path.isAbsolute(destination) || target === path.parse(target).root || relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)) || fs.existsSync(target)) throw new Error('Use a fresh source-material directory outside the repository');
  if (!cacheDirectory || !path.isAbsolute(cacheDirectory)) throw new Error('An explicit absolute source-cache directory is required');
  const manifestBytes = fs.readFileSync(path.join(projectRoot, 'third_party/licenses/source-archives.json'));
  const manifest = JSON.parse(manifestBytes);
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.archives) || manifest.archives.length === 0) throw new Error('Invalid reviewed source manifest');
  const names = new Set();
  const sources = manifest.archives.map(entry => {
    if (typeof entry.file !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(entry.file) || names.has(entry.file) || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1) throw new Error('Invalid reviewed source manifest');
    names.add(entry.file);
    const filename = path.join(cacheDirectory, entry.file);
    if (!fs.lstatSync(filename).isFile()) throw new Error(`Not a regular source archive: ${entry.file}`);
    const bytes = fs.readFileSync(filename);
    if (bytes.length !== entry.bytes || sha(bytes) !== entry.sha256) throw new Error(`Source archive hash mismatch: ${entry.file}`);
    return { entry, bytes };
  });
  fs.mkdirSync(target, { recursive: true });
  for (const { entry, bytes } of sources) fs.writeFileSync(path.join(target, entry.file), bytes, { flag: 'wx' });
  fs.writeFileSync(path.join(target, 'source-archives.json'), manifestBytes, { flag: 'wx' });
  fs.copyFileSync(path.join(projectRoot, 'THIRD_PARTY_NOTICES.md'), path.join(target, 'THIRD_PARTY_NOTICES.md'), fs.constants.COPYFILE_EXCL);
  // The candidate caller passes the clean Git export; preserve relative links
  // between its public third-party notices and original reference files.
  fs.cpSync(path.join(projectRoot, 'third_party'), path.join(target, 'third_party'), { recursive: true, force: false, errorOnExist: true });
  fs.writeFileSync(path.join(target, 'BUILDING-SOURCES.md'), [
    '# 对应源码材料', '',
    '这些是固定上游源码材料及补丁，适用各自原许可。除明确整理的 StdUtils 外，保留原始归档；source-archives.json 区分上游哈希和整理后哈希。没有改写保留的库源码或重编这些库。这不是完整二进制 SBOM，也不声称可逐字节重建。', '',
    'ELK：上游声明基于 ELK 0.9.1 并纳入 PR 955。Java 基线、补丁、elkjs wrapper 及声明的 GWT/Guava/EMF/Xtext 首选源码一并提供。构建要求及版本见 wrapper 的 build.gradle 和 README；本项目没有把同号 Java 标签或某次 master 全树冒充成已复现的二进制。', '',
    'nsis7z 19.00：先解开原插件归档，再按其 DOC/nsis7z.txt 将 LZMA SDK 19.00 的 C/CPP 文件夹置入 Contrib/nsis7z；保留插件提供的 NSIS UI 文件，使用原包的 VS 2017 解决方案。StdUtils 的原始构建说明和 LGPL/接口澄清保留在其固定源码归档中。', '',
    'StdUtils：整理归档逐字节保留 90 个文件，仅排除 Date.exe、Zip.exe 两个上游打包辅助工具、.aps 缓存及 .vcxproj.user 个人 IDE 配置；DLL 项目未引用这些工具，原 make_pack.bat 的上游打包步骤不能直接照跑。项目引用的三个上游 .lib 构建输入仍保留，并非声称其由本项目从源码重建。完整清单、原归档哈希和排除原因见 third_party/installer/stdutils-1.14/stdutils-source-review.json；内嵌 RHash、BLAKE2 与 NSIS 接口的原始声明一并提供。', '',
    'MTX：分别提供 PPTX 内嵌的 1.4.2 与另行解析的 1.6.0，不用后者替代前者；原始 TypeScript、MPL 和 libeot 来源说明保留。', '',
    '正式候选还应在同一交付中加入与构建提交一致的星丛项目源码归档、许可证和实际构建说明。仅生成本目录不表示已经完成产品打包或人工验收。', '',
  ].join('\n'), { flag: 'wx' });
  const receipt = { schemaVersion: 1, manifestSha256: sha(manifestBytes), archives: sources.map(({ entry }) => entry), archiveBytes: sources.reduce((total, item) => total + item.bytes.length, 0) };
  fs.writeFileSync(path.join(target, 'source-materials-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
  const destination = option('--output');
  if (!destination) throw new Error('Use --cache <verified source-cache directory> --output <fresh directory>');
  const receipt = prepareSourceMaterials({ cacheDirectory: option('--cache'), destination });
  console.log(JSON.stringify({ archives: receipt.archives.length, bytes: receipt.archiveBytes }));
}
