import { describe, expect, it } from 'vitest';
import { shellPanelHeightForDrag } from '../../src/frontend/shell-resize';

describe('shellPanelHeightForDrag', () => {
  it('increases height when dragging the top resize handle upward', () => {
    expect(shellPanelHeightForDrag(260, 300, 220)).toBe(340);
  });

  it('clamps shell panel height within supported bounds', () => {
    expect(shellPanelHeightForDrag(260, 300, 600)).toBe(140);
    expect(shellPanelHeightForDrag(260, 300, -300)).toBe(420);
  });
});
