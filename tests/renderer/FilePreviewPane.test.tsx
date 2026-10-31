import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { FilePreviewPane, type PreviewTab } from '../../src/renderer/components/chat/FilePreviewPane';
import type { ArtifactInfo } from '../../src/preload/electron-api';

function artifactInfo(previewKind: ArtifactInfo['previewKind'], name: string, mediaType: string): ArtifactInfo {
  return {
    id: name, name, extension: `.${name.split('.').pop()}`, mediaType, previewKind,
    sourceKind: 'local_path', registrationMethod: 'manual', availability: 'available',
    cached: false, createdAt: '2026-09-20T00:00:00.000Z',
  };
}

function previewTab(info: ArtifactInfo, content: PreviewTab['content']): PreviewTab {
  return { id: info.id, name: info.name, artifactRef: info.id, mediaType: info.mediaType, createdAt: info.createdAt, content };
}

describe('FilePreviewPane', () => {
  it('renders HTML in a script-free, network-isolated sandbox', () => {
    const info = artifactInfo('html', 'page.html', 'text/html');
    const tab = previewTab(info, { info, text: '<script>window.evil=1</script><img src="https://tracker.example/a.png" onerror="evil()"><h1>安全正文</h1>' });
    const view = render(<FilePreviewPane tabs={[tab]} activeId={tab.id} onActive={() => undefined} onClose={() => undefined} />);
    const frame = view.container.querySelector('iframe');
    expect(frame).toHaveAttribute('sandbox', '');
    const source = frame?.getAttribute('srcdoc') ?? '';
    expect(source).toContain('安全正文');
    expect(source).toContain("default-src 'none'");
    expect(source).not.toContain('<script');
    expect(source).not.toContain('tracker.example');
    expect(source).not.toContain('onerror');
  });

  it('previews workbook cells and switches between worksheets locally', async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['项目', '状态'], ['星丛', '完成']]), '总览');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['伙伴'], ['本地伙伴']]), '伙伴');
    const dataUrl = `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${XLSX.write(workbook, { bookType: 'xlsx', type: 'base64' })}`;
    const info = artifactInfo('sheet', 'status.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const tab = previewTab(info, { info, dataUrl });
    render(<FilePreviewPane tabs={[tab]} activeId={tab.id} onActive={() => undefined} onClose={() => undefined} />);
    expect(await screen.findByRole('tab', { name: '总览' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('星丛')).toBeInTheDocument();
    screen.getByRole('tab', { name: '伙伴' }).click();
    await waitFor(() => expect(screen.getByText('本地伙伴')).toBeInTheDocument());
  });
});
