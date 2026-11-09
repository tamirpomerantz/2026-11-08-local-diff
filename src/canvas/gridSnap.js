export const GRID_SIZE = 16;

export function snapToGrid(value) {
  return Math.round(value / GRID_SIZE) * GRID_SIZE;
}

export function snapPosition(position) {
  return {
    x: snapToGrid(position.x),
    y: snapToGrid(position.y),
  };
}
