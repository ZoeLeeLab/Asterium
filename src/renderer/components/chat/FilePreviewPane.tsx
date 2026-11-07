import { CodePreview } from './CodePreview';
import { ExternalLink, FileQuestion, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { ConversationArtifact } from '../../types/domain';
import { MarkdownContent } from './MarkdownContent';

export interface PreviewTab extends ConversationArtifact {
  content?: { info: { previewKind: 'markdown' | 'text' | 'html' | 'pdf' | 'image' | 'word' | 'sheet' | 'slides' | 'unsupported' }; text?: string; dataUrl?: string; diff?: string };
  error?: string;
  open?: () => void;
}

interface FilePreviewPaneProps {
  tabs: PreviewTab[];
  activeId: string;
  onActive: (id: string) => void;
  onClose: (id: string) => void;
  onArtifactContextMenu?: (id: string, event: MouseEvent<HTMLElement>) => void;
  onMinimize?: () => void;
}

interface SheetPreviewData {
  names: string[];
  rows: Record<string, Array<Array<string | number | boolean>>>;
}

export function FilePreviewPane({ tabs, activeId, onActive, onClose, onMinimize, onArtifactContextMenu }: FilePreviewPaneProps) {
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0];
  if (!active) return null;
  return <section className="glass-panel file-preview-pane" aria-label="文件预览">
    {onMinimize && <button className="text-button studio-preview-minimize" type="button" onClick={onMinimize}>收起预览，返回浏览</button>}
    <header className="preview-tabs" role="tablist">
      {tabs.map((tab) => <button className={tab.id === active.id ? 'active' : ''} type="button" role="tab" aria-selected={tab.id === active.id} key={tab.id} onClick={() => onActive(tab.id)} onContextMenu={(event) => onArtifactContextMenu?.(tab.id, event)}><span>{tab.name}</span><i role="button" tabIndex={0} aria-label={`关闭 ${tab.name}`} onClick={(event) => { event.stopPropagation(); onClose(tab.id); }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.stopPropagation(); onClose(tab.id); } }}><X size={13} /></i></button>)}
    </header>
    <div className="preview-content" onContextMenu={(event) => {
      if (active.content?.info.previewKind === 'image' && event.target instanceof HTMLImageElement) onArtifactContextMenu?.(active.id, event);
    }}>{active.error ? <PreviewFallback tab={active} message={active.error} /> : !active.content ? <div className="preview-loading">正在读取文件…</div> : <PreviewContent key={active.id} tab={active} />}</div>
  </section>;
}

function PreviewContent({ tab }: { tab: PreviewTab }) {
  const result = tab.content!;
  const [source, setSource] = useState(false);
  if (result.diff !== undefined) return <><div className="code-preview-toolbar"><button className="text-button" type="button" onClick={() => setSource((value) => !value)}>{source ? '查看差异' : '查看源码'}</button></div><CodePreview text={source ? result.text ?? '该版本没有可预览源码（文件可能已删除或为二进制）' : result.diff || '没有文本差异'} diff={!source} /></>;
  if (result.info.previewKind === 'markdown') return <MarkdownContent className="preview-markdown">{result.text ?? ''}</MarkdownContent>;
  if (result.info.previewKind === 'text') return <CodePreview text={result.text ?? ''} />;
  if (result.info.previewKind === 'html') return <><div className="code-preview-toolbar"><button className="text-button" type="button" onClick={() => setSource((value) => !value)}>{source ? '安全预览' : '查看源码'}</button></div>{source ? <CodePreview text={result.text ?? ''} /> : <SandboxedDocument html={result.text ?? ''} title={tab.name} />}</>;
  if (result.info.previewKind === 'image') return <div className="preview-image"><img src={result.dataUrl} alt={tab.name} /></div>;
  if (result.info.previewKind === 'pdf' && result.dataUrl) return <PdfPreview dataUrl={result.dataUrl} />;
  if (result.info.previewKind === 'word' && result.dataUrl) return <WordPreview dataUrl={result.dataUrl} title={tab.name} />;
  if (result.info.previewKind === 'sheet' && result.dataUrl) return <SheetPreview dataUrl={result.dataUrl} />;
  if (result.info.previewKind === 'slides' && result.dataUrl) return <SlidesPreview dataUrl={result.dataUrl} />;
  return <PreviewFallback tab={tab} message="这个格式暂不支持在星丛中预览。" />;
}

function SandboxedDocument({ html, title }: { html: string; title: string }) {
  const source = useMemo(() => buildSandboxDocument(html), [html]);
  return <iframe className="preview-document-frame" title={`${title} 只读预览`} sandbox="" srcDoc={source} />;
}

function WordPreview({ dataUrl, title }: { dataUrl: string; title: string }) {
  const [preview, setPreview] = useState<{ dataUrl: string; html?: string; error?: string }>();
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const mammoth = (await import('mammoth')).default;
        const result = await mammoth.convertToHtml(
          { arrayBuffer: dataUrlToArrayBuffer(dataUrl) },
          { convertImage: mammoth.images.dataUri, externalFileAccess: false },
        );
        if (!cancelled) setPreview({ dataUrl, html: result.value || '<p>文档没有可显示的正文。</p>' });
      } catch (reason) {
        if (!cancelled) setPreview({ dataUrl, error: previewError(reason, 'Word 文档解析失败') });
      }
    })();
    return () => { cancelled = true; };
  }, [dataUrl]);
  if (preview?.dataUrl !== dataUrl) return <div className="preview-loading">正在整理 Word 文档版式…</div>;
  if (preview.error) return <div className="preview-loading">{preview.error}</div>;
  return <SandboxedDocument html={preview.html ?? ''} title={title} />;
}

function SheetPreview({ dataUrl }: { dataUrl: string }) {
  const [preview, setPreview] = useState<{ dataUrl: string; data?: SheetPreviewData; error?: string }>();
  const [activeSheet, setActiveSheet] = useState('');
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const XLSX = await import('xlsx');
        const workbook = XLSX.read(dataUrlToArrayBuffer(dataUrl), { cellHTML: false, bookVBA: false, sheetRows: 501, WTF: false });
        const names = workbook.SheetNames.slice(0, 50);
        const rows = Object.fromEntries(names.map((name) => {
          const values = XLSX.utils.sheet_to_json<Array<string | number | boolean>>(workbook.Sheets[name], { header: 1, raw: false, defval: '' });
          return [name, values.slice(0, 500).map((row) => row.slice(0, 100))];
        }));
        if (!cancelled) setPreview({ dataUrl, data: { names, rows } });
      } catch (reason) {
        if (!cancelled) setPreview({ dataUrl, error: previewError(reason, '表格解析失败') });
      }
    })();
    return () => { cancelled = true; };
  }, [dataUrl]);
  if (preview?.dataUrl !== dataUrl) return <div className="preview-loading">正在读取工作表…</div>;
  if (preview.error) return <div className="preview-loading">{preview.error}</div>;
  const data = preview.data!;
  if (!data.names.length) return <div className="preview-loading">工作簿中没有可显示的工作表。</div>;
  const selectedSheet = data.names.includes(activeSheet) ? activeSheet : data.names[0];
  const rows = data.rows[selectedSheet] ?? [];
  return <div className="preview-sheet">
    <div className="preview-sheet__tabs" role="tablist" aria-label="工作表">{data.names.map((name) => <button type="button" role="tab" aria-selected={name === selectedSheet} className={name === selectedSheet ? 'active' : ''} key={name} onClick={() => setActiveSheet(name)}>{name}</button>)}</div>
    <div className="preview-sheet__table"><table><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((value, columnIndex) => rowIndex === 0 ? <th scope="col" key={columnIndex}>{String(value)}</th> : <td key={columnIndex}>{String(value)}</td>)}</tr>)}</tbody></table>{!rows.length && <p>这张工作表没有内容。</p>}</div>
    {rows.length >= 500 && <small className="preview-sheet__limit">为保持流畅，仅显示前 500 行。</small>}
  </div>;
}

function SlidesPreview({ dataUrl }: { dataUrl: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<{ dataUrl: string; error?: string }>();
  useEffect(() => {
    let viewer: { destroy: () => void } | undefined;
    let cancelled = false;
    const controller = new AbortController();
    const container = containerRef.current;
    if (!container) return;
    container.replaceChildren();
    void (async () => {
      try {
        const { PptxViewer, RECOMMENDED_ZIP_LIMITS } = await import('@aiden0z/pptx-renderer/browser');
        if (cancelled) return;
        viewer = await PptxViewer.open(dataUrlToArrayBuffer(dataUrl), container, {
          fitMode: 'contain', scrollContainer: container, zipLimits: RECOMMENDED_ZIP_LIMITS,
          lazyMedia: true, lazySlides: true, renderMode: 'list', signal: controller.signal,
          listOptions: { windowed: true, batchSize: 3, initialSlides: 3, overscanViewport: 1, showSlideLabels: true },
          onRenderComplete: () => { if (!cancelled) setStatus({ dataUrl }); },
        });
        if (!cancelled) setStatus({ dataUrl });
      } catch (reason) {
        if (!cancelled) setStatus({ dataUrl, error: previewError(reason, 'PowerPoint 解析失败') });
      }
    })();
    return () => { cancelled = true; controller.abort(); viewer?.destroy(); container.replaceChildren(); };
  }, [dataUrl]);
  const current = status?.dataUrl === dataUrl ? status : undefined;
  return <div className="preview-slides-shell">{!current && <div className="preview-loading preview-loading--overlay">正在铺开幻灯片…</div>}{current?.error && <div className="preview-loading preview-loading--overlay">{current.error}</div>}<div className="preview-slides" ref={containerRef} onClickCapture={(event) => { if ((event.target as Element).closest('a')) event.preventDefault(); }} /></div>;
}

function PdfPreview({ dataUrl }: { dataUrl: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;
    container.replaceChildren();
    setError('');
    void (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        const document = await pdfjs.getDocument({ data: dataUrlToArrayBuffer(dataUrl) }).promise;
        for (let pageNumber = 1; pageNumber <= document.numPages && !cancelled; pageNumber += 1) {
          const page = await document.getPage(pageNumber);
          const initial = page.getViewport({ scale: 1 });
          const scale = Math.min(1.6, Math.max(.7, (container.clientWidth - 32) / initial.width));
          const viewport = page.getViewport({ scale });
          const canvas = window.document.createElement('canvas');
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          canvas.setAttribute('aria-label', `PDF 第 ${pageNumber} 页`);
          container.append(canvas);
          const context = canvas.getContext('2d');
          if (context) await page.render({ canvas, canvasContext: context, viewport }).promise;
        }
      } catch (reason) {
        if (!cancelled) setError(previewError(reason, 'PDF 渲染失败'));
      }
    })();
    return () => { cancelled = true; container.replaceChildren(); };
  }, [dataUrl]);
  return error ? <div className="preview-loading">{error}</div> : <div className="preview-pdf" ref={containerRef} />;
}

function buildSandboxDocument(input: string) {
  const parsed = new DOMParser().parseFromString(input, 'text/html');
  parsed.querySelectorAll('script, iframe, frame, frameset, object, embed, applet, link, base, form, input, button, textarea, select').forEach((node) => node.remove());
  parsed.querySelectorAll('*').forEach((element) => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc' || ((name === 'href' || name === 'src') && !value.startsWith('#') && !value.startsWith('data:image/'))) element.removeAttribute(attribute.name);
    }
  });
  const meta = parsed.createElement('meta');
  meta.httpEquiv = 'Content-Security-Policy';
  meta.content = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'";
  parsed.head.prepend(meta);
  const style = parsed.createElement('style');
  style.textContent = `:root{color-scheme:light}*{box-sizing:border-box}body{max-width:920px;margin:0 auto;padding:34px 40px 52px;color:#27384f;background:#fff;font:14px/1.72 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;overflow-wrap:anywhere}h1,h2,h3,h4{color:#17263b;line-height:1.32}img{max-width:100%;height:auto}table{max-width:100%;border-collapse:collapse}th,td{padding:7px 9px;border:1px solid #d8e0ea;text-align:left;vertical-align:top}blockquote{margin-left:0;padding-left:14px;border-left:3px solid #9db8d7;color:#63758b}pre{max-width:100%;padding:12px;overflow:auto;background:#f3f6fa;border-radius:7px}a{color:#557da9;text-decoration:none}`;
  parsed.head.append(style);
  return `<!doctype html>${parsed.documentElement.outerHTML}`;
}

function dataUrlToArrayBuffer(dataUrl: string) {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('文件内容编码无效');
  const metadata = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);
  const binary = metadata.includes(';base64') ? atob(payload) : decodeURIComponent(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function previewError(reason: unknown, fallback: string) {
  return reason instanceof Error && reason.message ? `${fallback}：${reason.message}` : fallback;
}

function PreviewFallback({ tab, message }: { tab: PreviewTab; message: string }) {
  return <div className="preview-fallback"><FileQuestion size={34} /><strong>{tab.name}</strong><p>{message}</p>{(tab.open || tab.artifactRef) && <button className="secondary-button" type="button" onClick={() => tab.open ? tab.open() : window.asteriumArtifacts?.open(tab.artifactRef)}><ExternalLink size={15} />用系统应用打开</button>}</div>;
}
