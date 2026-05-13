export function shellPanelHeightForDrag(startHeight: number, startY: number, currentY: number): number {
  const delta = startY - currentY;
  return Math.min(Math.max(startHeight + delta, 140), 420);
}
