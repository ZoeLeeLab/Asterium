import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { createPortal } from 'react-dom';

export interface RailControls {
  left: boolean;
  right: boolean;
  toggle: (side: 'left' | 'right') => void;
}

export function WindowRailControls({ rails }: { rails: RailControls }) {
  // Glass panels establish a fixed-position containing block; use the window instead.
  return createPortal(<div className="window-rail-controls" aria-label="侧栏显示">
    <button className="window-rail-control window-rail-control--left" type="button" aria-label={`${rails.left ? '展开' : '收起'}左侧栏`} title={`${rails.left ? '展开' : '收起'}左侧栏`} aria-expanded={!rails.left} onClick={() => rails.toggle('left')}>{rails.left ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}</button>
    <button className="window-rail-control window-rail-control--right" type="button" aria-label={`${rails.right ? '展开' : '收起'}右侧栏`} title={`${rails.right ? '展开' : '收起'}右侧栏`} aria-expanded={!rails.right} onClick={() => rails.toggle('right')}>{rails.right ? <PanelRightOpen size={17} /> : <PanelRightClose size={17} />}</button>
  </div>, document.body);
}
