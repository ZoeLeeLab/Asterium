import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { PrototypeProvider } from '../../src/renderer/app/PrototypeProvider';
import { ChatPage } from '../../src/renderer/pages/ChatPage';
import { SettingsPage } from '../../src/renderer/pages/SettingsPage';

describe('empty release workspace', () => {
  it('opens without test partners and provides a working add-partner route', async () => {
    localStorage.clear();
    render(<MemoryRouter initialEntries={['/chat']}><PrototypeProvider><Routes>
      <Route path="/chat" element={<ChatPage />} />
      <Route path="/settings/partners" element={<SettingsPage />} />
    </Routes></PrototypeProvider></MemoryRouter>);
    expect(screen.getByRole('heading', { name: '添加你的第一位伙伴' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^添加伙伴$/ }));
    expect(await screen.findByRole('heading', { name: '伙伴管理' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重置演示数据' })).not.toBeInTheDocument();
  });
});
