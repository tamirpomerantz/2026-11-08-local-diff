import { GRID_SIZE, snapPosition, snapToGrid } from "./gridSnap.js";

function gridStep(size) {
  return Math.ceil(size / GRID_SIZE) * GRID_SIZE;
}

export const NODE_WIDTH = 220;
export const NODE_GAP = 24;
export const MIN_NODE_HEIGHT = 112;
const GRID_NUDGE = 32;

export function nodeScale(image) {
  return Number(image?.scale) >= 2 ? 2 : 1;
}

export function nodeWidth(image) {
  return NODE_WIDTH * nodeScale(image);
}

export function nodeHeight(image) {
  const width = Number(image?.width) || 1;
  const height = Number(image?.height) || 1;
  const frame = nodeWidth(image);
  return Math.max(MIN_NODE_HEIGHT * nodeScale(image), Math.round((frame * height) / width));
}

export function nodeBox(position, image) {
  return {
    x: position.x,
    y: position.y,
    w: nodeWidth(image),
    h: nodeHeight(image),
  };
}

function overlaps(a, b, gap = NODE_GAP) {
  return !(
    a.x + a.w + gap <= b.x ||
    b.x + b.w + gap <= a.x ||
    a.y + a.h + gap <= b.y ||
    b.y + b.h + gap <= a.y
  );
}

export function occupiedBoxes(nodes, exceptId) {
  return nodes
    .filter((node) => node.id !== exceptId)
    .map((node) => nodeBox(node.position, node.data?.image));
}

export function findFreePosition(origin, image, boxes) {
  const size = { w: nodeWidth(image), h: nodeHeight(image) };
  const start = snapPosition(origin);
  const stepX = gridStep(size.w + NODE_GAP);
  const stepY = gridStep(size.h + NODE_GAP);

  for (let row = 0; row < 24; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      const position = {
        x: snapToGrid(start.x + col * stepX),
        y: snapToGrid(start.y + row * stepY),
      };
      const box = { ...position, ...size };
      if (!boxes.some((other) => overlaps(box, other))) return position;
    }
  }

  return {
    x: snapToGrid(start.x + boxes.length * GRID_NUDGE),
    y: snapToGrid(start.y + boxes.length * GRID_NUDGE),
  };
}

export function centerOrigin(flowPoint, image) {
  return snapPosition({
    x: flowPoint.x - nodeWidth(image) / 2,
    y: flowPoint.y - nodeHeight(image) / 2,
  });
}

export function masonryColumnCount(count) {
  return count >= 10 ? 5 : 4;
}

export function masonryLayout(items, origin) {
  const cols = masonryColumnCount(items.length);
  const stride = gridStep(NODE_WIDTH + NODE_GAP);
  const heights = Array(cols).fill(0);
  const start = snapPosition(origin);
  return items.map((item) => {
    const image = item.image;
    const height = nodeHeight(image);
    const span = Math.min(cols, Math.max(1, Math.round(nodeWidth(image) / NODE_WIDTH)));
    let bestCol = 0;
    let bestY = Infinity;
    for (let col = 0; col <= cols - span; col += 1) {
      const y = Math.max(...heights.slice(col, col + span));
      if (y < bestY) {
        bestY = y;
        bestCol = col;
      }
    }
    const position = {
      x: start.x + bestCol * stride,
      y: snapToGrid(start.y + bestY),
    };
    const bottom = bestY + height + NODE_GAP;
    for (let col = bestCol; col < bestCol + span; col += 1) heights[col] = bottom;
    return { id: item.id, position };
  });
}
