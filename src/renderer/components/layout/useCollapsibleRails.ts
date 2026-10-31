import { useEffect, useState } from 'react';

export function useCollapsibleRails(page: 'chat' | 'studio') {
  const key = `asterium.${page}.collapsedRails.v1`;
  const [collapsed, setCollapsed] = useState<{ left: boolean; right: boolean }>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(key) ?? '{}');
      return { left: stored?.left === true, right: stored?.right === true };
    } catch { return { left: false, right: false }; }
  });
  useEffect(() => { localStorage.setItem(key, JSON.stringify(collapsed)); }, [collapsed, key]);
  return { ...collapsed, toggle: (side: 'left' | 'right') => setCollapsed((current) => ({ ...current, [side]: !current[side] })) };
}
