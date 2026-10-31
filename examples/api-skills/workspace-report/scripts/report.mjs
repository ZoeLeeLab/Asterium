import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const filename = process.argv[2] ?? 'workspace-report.md';
if (!/^[a-zA-Z0-9_-]{1,80}\.md$/.test(filename) || process.argv.length > 3) throw new Error('REPORT_FILENAME_INVALID');
const cwd = process.cwd();
const entries = await readdir(cwd, { withFileTypes: true });
const lines = entries.slice(0, 500).map((entry) => `- ${entry.isDirectory() ? '[目录]' : '[文件]'} ${entry.name.replace(/[\r\n]/g, ' ')}`);
const destination = path.join(cwd, filename);
await writeFile(destination, `# 工作区文件清单\n\n${lines.join('\n')}\n`, { flag: 'wx' });
console.log(JSON.stringify({ path: destination, entries: lines.length }));
