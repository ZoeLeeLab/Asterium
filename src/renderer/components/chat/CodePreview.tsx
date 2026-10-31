import { useState } from 'react';

const tokenPattern = /(\/\/[^\n]*|#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:const|let|var|function|return|if|else|for|while|class|interface|type|import|export|from|async|await|new|throw|try|catch|def|in|true|false|null|None|public|private|readonly|extends|implements)\b|\b\d+(?:\.\d+)?\b)/g;
function tokens(line: string) {
  return line.split(tokenPattern).map((part, index) => <span key={index} className={/^['"`]/.test(part) ? 'code-string' : /^(\/\/|#)/.test(part) ? 'code-comment' : /^(const|let|var|function|return|if|else|for|while|class|interface|type|import|export|from|async|await|new|throw|try|catch|def|in|true|false|null|None|public|private|readonly|extends|implements)$/.test(part) ? 'code-keyword' : /^\d/.test(part) ? 'code-number' : undefined}>{part}</span>);
}
export function CodePreview({ text, diff = false }: { text: string; diff?: boolean }) {
  const [copied, setCopied] = useState(false);
  const lines = text.split('\n');
  return <div className="code-preview"><div className="code-preview-toolbar"><small>{diff ? '变更差异' : '只读源码'} · {lines.length} 行</small><button className="text-button" type="button" onClick={() => { void navigator.clipboard?.writeText(text).then(() => setCopied(true)).catch(() => setCopied(false)); }}>{copied ? '已复制' : '复制'}</button></div><pre className="code-preview-lines">{lines.slice(0, 20000).map((line, index) => <span className={`code-line ${diff ? line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-remove' : line.startsWith('@@') ? 'diff-section' : '' : ''}`} key={index}><span className="code-line-number" aria-hidden="true">{index + 1}</span><code>{text.length < 200000 && !diff ? tokens(line || ' ') : line || ' '}</code></span>)}</pre>{lines.length > 20000 && <p>仅显示前 20000 行，请用系统应用查看完整文件。</p>}</div>;
}
