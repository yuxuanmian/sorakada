/**
 * Whether this click completes one pair in a browser multi-click sequence.
 *
 * Browsers keep increasing `MouseEvent.detail` while clicks remain close enough
 * together: a rapid pair is 1,2, but another pair can therefore arrive as 3,4
 * rather than starting over at 1,2. Listening only for `dblclick` can lose that
 * second pair, while every positive even click count closes exactly one pair.
 */
export function completesExplorerDoubleClick(clickCount: number): boolean {
  return (
    Number.isInteger(clickCount) && clickCount > 0 && clickCount % 2 === 0
  );
}
