/* global window, document, getComputedStyle, requestAnimationFrame, cancelAnimationFrame, KeyboardEvent */
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { build, preview } from 'vite';
import { autoTestOutput, createTestViteServer, launchTestBrowser, runAutoTest } from './helpers/autoTest.mjs';

await runAutoTest(async () => {
  const outDir = autoTestOutput();
  const config = { configFile: 'vite.renderer.config.ts', logLevel: 'error', cacheDir: autoTestOutput(), build: { outDir, emptyOutDir: false } };
  await build(config);
  const server = await preview({ ...config, preview: { host: '127.0.0.1', port: 0 } });
  try {
    const edgeRoot = process.env['ProgramFiles(x86)'] ?? process.env.ProgramFiles;
    const browser = await launchTestBrowser(chromium, { headless: true,
      ...(process.platform === 'win32' && edgeRoot ? { executablePath: path.join(edgeRoot, 'Microsoft', 'Edge', 'Application', 'msedge.exe') } : {}) });
    const context = await browser.newContext({ viewport: { width: 1380, height: 860 } });
    const loader = await createTestViteServer({ configFile: 'vite.renderer.config.ts', server: { middlewareMode: true } });
    const { SingleChatHistoryStore } = await loader.ssrLoadModule(path.resolve('src/main/conversation/SingleChatHistoryStore.ts'));
    const history = new SingleChatHistoryStore(autoTestOutput());
    let importCount = 0;
    await context.exposeBinding('fixtureChatHistory', async (_, operation, value) => {
      if (operation === 'open') return history.openRecent();
      if (operation === 'write') return history.write(value);
      if (operation === 'page') return history.readPage(value);
      if (operation === 'search') return history.search(value);
      assert.equal(operation, 'migrate');
      await history.initialize(async () => { importCount++; return { ...value, deletedConversationIds: [] }; });
      return history.openRecent();
    });
    const page = await context.newPage();
    const turns = 300;
    await page.addInitScript((turnCount) => {
      const createdAt = '2026-09-07T09:00:00.000Z';
      const partnerId = 'fixture-partner', conversationId = 'fixture-chat', userId = 'asterium:user:local';
      const markdown = '## 示例回复\n\n这里有 **粗体**、列表和代码。\n\n- 项目一\n- 项目二\n\n| A | B |\n| --- | --- |\n| 示例 | 内容 |\n\n```ts\nconst value = 12;\n```';
      const messages = Array.from({ length: turnCount * 2 }, (_, index) => ({
        id: `fixture-message-${index}`, authorId: index % 2 ? partnerId : userId, createdAt, status: 'delivered',
        content: index % 2 ? `${markdown}\n\n示例 ${index}` : index === 0 ? '示例提问 0 独有检索词甲乙丙' : `示例提问 ${index}`,
        ...(index % 2 ? { runId: 'fixture-turn-' + Math.floor(index / 2), runState: 'completed' } : {}),
        ...(index === turnCount * 2 - 2 ? { clientMessageId: 'fixture-client-message' } : {}),
      }));
      localStorage.setItem('asterium.prototype.v7', JSON.stringify({
        version: 7, userProfile: { id: userId, displayName: '示例用户', introduction: '', audience: 'all', updatedAt: createdAt },
        partners: [{ id: partnerId, publicIdentity: { displayName: '示例伙伴', introduction: '', expertise: '', mentionName: '示例伙伴' },
          status: 'online', isPrototype: false, createdAt, accent: '#69a7ff', profileManagement: { userProfile: false, personality: false, memoryMode: 'self_managed' },
          defaultPermissionMode: 'manual', sourceMode: 'local_cli', adapterType: 'codex_cli', location: 'local', sessionMode: 'resume', connectionKind: 'local_codex',
          partnerRootGrantId: 'fixture-grant' }],
        activePartnerId: partnerId, activeConversationId: conversationId, projects: [], groupChats: [],
        conversations: [{ id: conversationId, partnerId, title: '合成长对话', permissionMode: 'manual', planMode: 'default',
          sessionId: 'fixture-session', partnerRootGrantId: 'fixture-grant', updatedAt: createdAt, messages }],
      }));
      const fixture = window.__longChat = { polls: 0, sends: 0, deltas: 0, batches: [], historyReads: [] };
      window.asteriumDelegation = { list: async () => { fixture.polls++; return structuredClone(fixture.batches); } };
      window.asteriumConversations = {
        listDeleted: async () => [],
        openHistory: () => window.fixtureChatHistory('open'),
        migrateHistory: input => window.fixtureChatHistory('migrate', input),
        writeHistory: input => window.fixtureChatHistory('write', input),
        readHistoryPage: input => window.fixtureChatHistory('page', input),
        searchHistory: input => window.fixtureChatHistory('search', input),
      };
      window.asteriumAgents = {
        onEvent: (listener) => { fixture.listener = listener; return () => { fixture.listener = undefined; }; },
        sendLocalCliMessage: async () => { fixture.sends++; },
        readCodexHistory: async (request) => {
          fixture.historyReads.push(request);
          const offset = request.cursor ? Number(request.cursor) : 0;
          const lastTurn = turnCount - offset - 1;
          const count = Math.min(lastTurn + 1, 30);
          return {
            turns: Array.from({ length: count }, (_, position) => {
              const turn = lastTurn - position;
              const user = messages[turn * 2], reply = messages[turn * 2 + 1];
              return { id: reply.runId, state: 'completed', startedAt: createdAt, items: [
                { id: user.id, kind: 'user', text: user.content },
                { id: reply.id, kind: 'assistant', text: reply.content + (turn === turnCount - 1 ? '\n\n原线程恢复的末尾。' : '') },
              ] };
            }),
            ...(lastTurn >= count ? { nextCursor: String(offset + count) } : {}),
          };
        },
      };
      fixture.startReply = () => {
        const base = { protocolVersion: 2, connectionSource: 'local_cli', partnerId, conversationId, runId: 'fixture-run', sessionId: 'fixture-session',
          clientMessageId: 'fixture-client-message', occurredAt: createdAt };
        let sequence = 0;
        const send = (type, fields = {}) => fixture.listener({ ...base, type, sequence: ++sequence, eventId: `fixture-event-${sequence}`, ...fields });
        send('session.bound', { isNew: false });
        send('message.accepted');
        fixture.timer = window.setInterval(() => {
          fixture.deltas++;
          send('text.delta', { text: `片段 ${fixture.deltas}。 ` });
          if (fixture.deltas === 24 || fixture.deltas === 48) send('tool.completed', {
            toolCallId: 'fixture-tool-' + fixture.deltas, outcome: 'success', summary: '合成工具完成',
          });
        }, 80);
        fixture.finishReply = () => { window.clearInterval(fixture.timer); send('run.completed'); };
      };
    }, turns);
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/#/chat`);
    const viewport = page.getByRole('navigation', { name: '快速选择对话回合' });
    const marks = viewport.getByRole('button');
    await viewport.waitFor();
    const list = page.locator('.message-list');
    await list.getByText('原线程恢复的末尾。', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__longChat.historyReads[0].threadId), 'fixture-session');
    assert.equal(await list.locator('.message-row').count(), 80);
    assert.equal(await marks.count(), 40);
    assert.match(await marks.first().getAttribute('aria-label'), /^第 261 轮/);
    assert.equal(await list.getByText(/独有检索词/).count(), 0);

    await page.getByRole('button', { name: '搜索当前对话', exact: true }).click();
    await page.getByRole('searchbox', { name: '搜索当前对话正文' }).fill('独有检索词');
    await list.getByText(/独有检索词/).waitFor();
    await page.waitForFunction(() => document.getElementById('chat-message-fixture-message-0')?.classList.contains('is-reference-target'));
    await page.getByRole('button', { name: '关闭当前对话搜索' }).click();
    await page.getByRole('button', { name: '回到最新消息', exact: true }).click();
    await list.getByText('原线程恢复的末尾。', { exact: true }).waitFor();

    await page.getByRole('button', { name: '加载更早消息', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.message-list > .message-row').length >= 160);
    await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
    const rail = await viewport.evaluate((element) => ({
      height: element.clientHeight, scrollHeight: element.scrollHeight, scrollTop: element.scrollTop,
      width: getComputedStyle(element).scrollbarWidth, markHeight: getComputedStyle(element.firstElementChild, '::before').height,
    }));
    assert.ok(await marks.count() >= 80 && await marks.count() < turns);
    assert.ok(rail.height <= 200 && rail.scrollHeight > rail.height && rail.scrollHeight - rail.height - rail.scrollTop <= 80);
    assert.equal(rail.width, 'none');
    assert.equal(rail.markHeight, '3px');

    const bottom = await list.evaluate(element => element.scrollTop);
    await viewport.hover();
    await page.mouse.wheel(0, -1100);
    await page.waitForFunction(initial => document.querySelector('.turn-navigator__viewport').scrollTop < initial - 40, rail.scrollTop);
    assert.equal(await list.evaluate(element => element.scrollTop), bottom, 'rail scroll must not move the chat');
    const markIndex = await viewport.evaluate(element => Math.ceil(element.scrollTop / element.firstElementChild.offsetHeight) + 4);
    await marks.nth(markIndex).hover();
    await page.locator('.turn-navigator__preview').waitFor({ state: 'visible' });
    const targetIndex = Number((await marks.nth(markIndex).getAttribute('aria-label')).match(/示例提问 (\d+)/)[1]);
    await marks.nth(markIndex).click();
    await page.waitForFunction(index => {
      const target = document.getElementById('chat-message-fixture-message-' + index).getBoundingClientRect();
      const listTop = document.querySelector('.message-list').getBoundingClientRect().top;
      return target.top >= listTop && target.top < listTop + 150;
    }, targetIndex);
    await page.getByRole('button', { name: '回到底部', exact: true }).click();

    // The mock crosses the same serialization boundary on every poll. Changed receipts still appear and disappear.
    await page.evaluate(() => {
      window.__longChat.batches = [{ id: 'fixture-batch', conversationId: 'fixture-chat', partnerId: 'fixture-partner',
        turnId: 'fixture-turn', messageId: 'fixture-message-598', requestId: 'fixture-request', createdAt: 0,
        tasks: [{ id: 'fixture-task', targetPartnerId: 'fixture-partner', instruction: '示例委派', status: 'running' }] }];
    });
    const receipt = page.getByText('正在等小弟汇报回来', { exact: true });
    await receipt.waitFor();
    await page.evaluate(() => { window.__longChat.batches = []; });
    await receipt.waitFor({ state: 'detached' });

    const editor = page.locator('.message-canvas .composer textarea');
    const cdp = await context.newCDPSession(page);
    const sample = async (scenario, input, expected) => {
      await editor.fill('');
      await editor.focus();
      const before = await page.evaluate(() => {
        const result = { tasks: [], frameGaps: [], compositions: 0, polls: window.__longChat.polls, deltas: window.__longChat.deltas };
        const observer = new PerformanceObserver(list => result.tasks.push(...list.getEntries().map(entry => entry.duration)));
        observer.observe({ type: 'longtask' });
        const onComposition = () => { result.compositions++; };
        document.addEventListener('compositionupdate', onComposition);
        let last = performance.now();
        let frame;
        const tick = (now) => { result.frameGaps.push(now - last); last = now; frame = requestAnimationFrame(tick); };
        frame = requestAnimationFrame(tick);
        window.__longChat.stopSample = () => {
          cancelAnimationFrame(frame);
          document.removeEventListener('compositionupdate', onComposition);
          result.tasks.push(...observer.takeRecords().map(entry => entry.duration));
          observer.disconnect();
          return {
            polls: window.__longChat.polls - result.polls, deltas: window.__longChat.deltas - result.deltas,
            compositions: result.compositions, longTasksMs: result.tasks.map(Math.round),
            worstFrameMs: Math.round(Math.max(0, ...result.frameGaps)),
          };
        };
        return document.querySelectorAll('.message-list > .message-row').length;
      });
      await input();
      assert.equal(await editor.inputValue(), expected);
      const result = await page.evaluate(() => window.__longChat.stopSample());
      assert.ok(before >= 80 && before < turns * 2 && result.polls > 0);
      console.log(JSON.stringify({ scenario, ...result }));
      return result;
    };

    const draft = 'abcde '.repeat(12);
    await sample('idle', () => editor.pressSequentially(draft, { delay: 36 }), draft);
    await page.evaluate(() => window.__longChat.startReply());
    await list.getByText(/片段 1。/).waitFor();
    const busy = await sample('replying', () => editor.pressSequentially(draft, { delay: 36 }), draft);
    assert.ok(busy.deltas >= 8, 'reply must keep updating while typing');
    assert.match(await list.locator('.message-row').last().innerText(), /片段/);
    await viewport.locator('[aria-current="true"]').focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    const afterJump = await page.evaluate(() => window.__longChat.deltas);
    await page.waitForFunction(count => window.__longChat.deltas >= count + 3, afterJump);
    assert.ok(await list.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight) > 100, 'streaming must not pull the reader away from the selected turn');
    const phrase = '星丛中文输入测试';
    const composeChinese = async () => {
      for (const character of phrase) {
        await cdp.send('Input.imeSetComposition', { text: character, selectionStart: 1, selectionEnd: 1 });
        assert.equal(await editor.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true }))), true);
        await cdp.send('Input.insertText', { text: character });
        await new Promise(resolve => setTimeout(resolve, 160));
      }
    };
    const replyingIme = await sample('replying-chinese-ime', composeChinese, phrase);
    assert.ok(replyingIme.compositions >= phrase.length && replyingIme.deltas >= 8);
    await page.evaluate(() => window.__longChat.finishReply());
    const ime = await sample('chinese-ime', composeChinese, phrase);
    assert.ok(ime.compositions >= phrase.length);
    assert.equal(await page.evaluate(() => window.__longChat.sends), 0, 'composing Enter must not send');
    const recorded = (await history.readConversation('fixture-chat')).conversation.messages.find(message => message.runId === 'fixture-run');
    assert.equal(recorded?.runState, 'completed');
    assert.equal(recorded?.timeline?.filter(item => item.kind === 'tool' && item.state === 'success').length, 2);
    assert.equal(importCount, 1);
    for (let pageNumber = 0; pageNumber < 3; pageNumber++) {
      const older = page.getByRole('button', { name: '加载更早消息', exact: true });
      if (!await older.count()) break;
      await older.click();
      await older.waitFor({ state: 'visible' }).catch(() => undefined);
    }
    assert.ok(await list.locator('.message-row').count() <= 240);
    await page.reload();
    await list.getByText(/片段 1。/).waitFor();
    assert.equal(importCount, 1, 'the legacy snapshot must not re-run the migration');
    await context.close();
    await loader.close();
  } finally {
    await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
  }
});
