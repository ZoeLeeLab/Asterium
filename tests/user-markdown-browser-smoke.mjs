import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium } from 'playwright-core';
import { autoTestEvidence, createTestViteServer, launchTestBrowser, runAutoTest } from './helpers/autoTest.mjs';

/* global document, getComputedStyle */

// Measure the production component and styles in a real layout engine. jsdom
// cannot detect anonymous line boxes produced by preserved block separators.
await runAutoTest(async () => {
  const evidence = autoTestEvidence('user-markdown-browser-smoke', process.env.ASTERIUM_UI_EVIDENCE_DIR);
  await mkdir(evidence, { recursive: true });
  const server = await createTestViteServer({ configFile: 'vite.renderer.config.ts', server: { host: '127.0.0.1', port: 0 } });
  let browser;
  try {
    const { MarkdownContent } = await server.ssrLoadModule(path.resolve('src/renderer/components/chat/MarkdownContent.tsx'));
    const cases = {
      tight: '合成验收摘要\n\n- 第一项\n- 第二项\n- 第三项\n- 第四项',
      loose: '合成验收摘要\n\n- 第一项\n\n- 第二项\n\n- 第三项',
      nested: '1. 父项\n   - 子项一\n   - 子项二\n\n2. 下一项',
      quote: '> 第一段\n>\n> - 引用列表\n>\n> 第二段',
      table: '| 列一 | 列二 |\n| --- | --- |\n| 值一 | 值二 |\n\n后续段落',
      code: '前段\n\n```text\n  第一行\n\n    第二行\n```\n\n后段',
      headings: '# 标题\n\n段落\n\n---\n\n## 二级标题\n\n后段',
      hardBreaks: '第一行  \n第二行',
    };
    const styles = (await Promise.all(['globals.css', 'appearance.css'].map((file) =>
      readFile(path.resolve('src/renderer/styles', file), 'utf8')))).join('\n');
    const sections = Object.entries(cases).map(([name, text]) => `<section data-case="${name}">${[true, false].map((user) =>
      `<div class="message-bubble" data-author="${user ? 'user' : 'assistant'}">${renderToStaticMarkup(React.createElement(MarkdownContent, { className: user ? 'message-content--user' : '' }, text))}</div>`).join('')}</section>`).join('');
    const manual = renderToStaticMarkup(React.createElement(MarkdownContent, { className: 'message-content--user' }, '第一行  空格\n第二行\n第三行'));
    const inlineList = renderToStaticMarkup(React.createElement(MarkdownContent, { className: 'message-content--user' }, '- [链接一](https://example.com/one)\n  [链接二](https://example.com/two)\n  - 子项'));
    browser = await launchTestBrowser(chromium, { executablePath: process.env.ASTERIUM_BROWSER_EXE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const page = await browser.newPage({ reducedMotion: 'reduce' });
    const results = [];
    const failures = [];
    for (const width of [400, 1200]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const fontSize of [14, 18]) {
        await page.setContent(`<!doctype html><meta charset="utf-8"><style>${styles}
          html,body { height:auto; overflow:auto; }
          body { padding:16px; background:#fff; color:#222; font-family:Arial; --content-font-size:${fontSize}px; --text-strong:#222; }
          section { margin-bottom:16px; }
          .message-bubble { width:100%; }
          </style>${sections}<div id="manual" class="message-bubble">${manual}</div><div id="inline-list" class="message-bubble">${inlineList}</div>`);
        const layout = await page.evaluate(() => {
          const pairs = [...document.querySelectorAll('section')].map((section) => {
            const user = section.querySelector('[data-author="user"] .markdown-content');
            const assistant = section.querySelector('[data-author="assistant"] .markdown-content');
            return { name: section.dataset.case, user: user.getBoundingClientRect().height, assistant: assistant.getBoundingClientRect().height };
          });
          const manual = document.querySelector('#manual p');
          const firstLink = document.querySelector('#inline-list a');
          const secondLink = document.querySelectorAll('#inline-list a')[1];
          return { pairs, manual: { height: manual.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(manual).lineHeight), text: manual.textContent }, inlineGap: secondLink.getBoundingClientRect().top - firstLink.getBoundingClientRect().top };
        });
        results.push({ width, fontSize, ...layout });
        for (const pair of layout.pairs) if (Math.abs(pair.user - pair.assistant) > 1) failures.push({ width, fontSize, ...pair });
        assert.equal(layout.manual.text, '第一行  空格\n第二行\n第三行');
        assert.ok(Math.abs(layout.manual.height - 3 * layout.manual.lineHeight) < 1, 'Manual line breaks must remain visible');
        assert.ok(Math.abs(layout.inlineGap - layout.manual.lineHeight) < 1, 'Inline list line breaks must remain visible');
      }
    }
    await writeFile(path.join(evidence, 'measurements.json'), JSON.stringify({ results, failures }, null, 2));
    await page.screenshot({ path: path.join(evidence, 'synthetic-markdown.png'), fullPage: true });
    assert.deepEqual(failures, [], 'User Markdown must not create extra block-spacing line boxes');

    const { createTestState } = await server.ssrLoadModule(path.resolve('tests/fixtures/applicationState.ts'));
    const state = createTestState();
    const message = { ...state.conversations[0].messages[1], id: 'fixture-user-markdown', content: cases.loose };
    state.conversations[0].messages = [message];
    const appPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await appPage.addInitScript(({ fixture, message }) => {
      localStorage.setItem('asterium.prototype.v7', JSON.stringify(fixture));
      // Group transcripts come from Main's ledger, never localStorage.
      globalThis.asteriumStudio = {
        onRoomChanged: () => () => undefined,
        syncRoom: async (metadata) => ({ metadata, cursors: [], mutedPartnerIds: [], models: {}, rotationOffset: 0,
          settings: { speakingMode: 'free_discussion', selectedPartnerIds: [], discussionProtectionEnabled: true },
          messages: metadata.roomId === fixture.activeGroupChatId ? [{
          messageId: message.id, authorId: message.authorId, authorType: 'user', content: message.content,
          status: 'completed', seq: 1, createdAt: '2026-01-01T00:00:00.000Z',
        }] : [] }),
      };
    }, { fixture: state, message });
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    for (const [route, target] of [['chat', 'chat'], ['studio/discussion', 'studio']]) {
      await appPage.goto(`${origin}/#/${route}`);
      await appPage.reload();
      const bubble = appPage.locator(`#${target}-message-fixture-user-markdown .message-content--user`);
      await bubble.waitFor({ state: 'visible' });
      assert.equal(await bubble.locator('li').count(), 3);
      assert.equal(await bubble.evaluate((node) => [node, ...node.querySelectorAll('ul, li')]
        .flatMap((element) => [...element.childNodes])
        .filter((child) => child.nodeType === 3 && /^[\t \r\n]*\n[\t \r\n]*$/.test(child.textContent ?? '')).length), 0);
      await appPage.screenshot({ path: path.join(evidence, `${target}-user-bubble.png`) });
    }
    console.log(JSON.stringify({ status: 'passed', comparisons: results.length * Object.keys(cases).length, pages: ['chat', 'studio/discussion'], manualLineBreaks: true, inlineListLineBreaks: true, realApiCalled: false, evidence }));
  } finally {
    await browser?.close();
    await server.close();
  }
});
