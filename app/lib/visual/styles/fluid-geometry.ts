export type FluidEllipse = {
  x: number;
  y: number;
  radiusX: number;
  radiusY: number;
  angle: number;
};

const MAX_GRID_SIZE = 80;
const MAX_ELLIPSES = 4;
const MAX_FIELD_EXTENT = 0.56;
const MAX_EDGE_COUNT = 2 * MAX_GRID_SIZE * (MAX_GRID_SIZE + 1);
const field = new Float32Array((MAX_GRID_SIZE + 1) * (MAX_GRID_SIZE + 1));
const ellipseX = new Float32Array(MAX_ELLIPSES);
const ellipseY = new Float32Array(MAX_ELLIPSES);
const ellipseRadiusX = new Float32Array(MAX_ELLIPSES);
const ellipseRadiusY = new Float32Array(MAX_ELLIPSES);
const ellipseCosine = new Float32Array(MAX_ELLIPSES);
const ellipseSine = new Float32Array(MAX_ELLIPSES);
const nodeX = new Float32Array(MAX_EDGE_COUNT);
const nodeY = new Float32Array(MAX_EDGE_COUNT);
const edgeCrossing = new Uint8Array(MAX_EDGE_COUNT);
const neighborA = new Int32Array(MAX_EDGE_COUNT);
const neighborB = new Int32Array(MAX_EDGE_COUNT);
const visited = new Uint8Array(MAX_EDGE_COUNT);
const loopNodes = new Int32Array(MAX_EDGE_COUNT);
const bestLoopNodes = new Int32Array(MAX_EDGE_COUNT);

/**
 * Samples a smooth union of a central ellipse and overlapping fluid lobes,
 * traces its center-connected marching-squares boundary and resamples it into
 * a reusable closed contour. Coordinates in ellipse inputs use short-edge units.
 */
export function writeMetaballContour(
  target: Float32Array,
  outputCount: number,
  width: number,
  height: number,
  shortEdge: number,
  gridSize: number,
  core: FluidEllipse,
  lobes: readonly FluidEllipse[],
  smoothness: number,
): number {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !Number.isFinite(shortEdge) ||
    width <= 0 ||
    height <= 0 ||
    shortEdge <= 0 ||
    outputCount < 3 ||
    target.length < outputCount * 2
  )
    return 0;

  const cells = Math.max(16, Math.min(MAX_GRID_SIZE, Math.round(gridSize)));
  const columns = cells + 1;
  const rowStride = columns;
  const horizontalEdgeCount = cells * (cells + 1);
  const edgeCount = 2 * horizontalEdgeCount;
  const ellipseCount = Math.min(MAX_ELLIPSES, 1 + lobes.length);
  const centerX = width / 2;
  const centerY = height / 2;

  setEllipse(0, core);
  for (let index = 1; index < ellipseCount; index++) setEllipse(index, lobes[index - 1]);

  const softness = Math.max(0.001, Math.min(0.12, smoothness));
  let envelope = 0;
  for (let ellipse = 0; ellipse < ellipseCount; ellipse++) {
    const extentX =
      Math.abs(ellipseX[ellipse]) +
      Math.hypot(
        ellipseRadiusX[ellipse] * ellipseCosine[ellipse],
        ellipseRadiusY[ellipse] * ellipseSine[ellipse],
      );
    const extentY =
      Math.abs(ellipseY[ellipse]) +
      Math.hypot(
        ellipseRadiusX[ellipse] * ellipseSine[ellipse],
        ellipseRadiusY[ellipse] * ellipseCosine[ellipse],
      );
    envelope = Math.max(envelope, extentX, extentY);
  }
  // Small blobs use a tighter field so the bounded grid resolves their necks
  // and lobes at the same spatial quality as larger sizes.
  const padding = Math.max(0.01, envelope * 0.2, softness * 0.75);
  const extent = Math.min(MAX_FIELD_EXTENT, envelope + padding);
  if (extent <= envelope + softness * 0.25) return 0;
  const step = (2 * extent) / cells;
  for (let yIndex = 0; yIndex <= cells; yIndex++) {
    const y = -extent + yIndex * step;
    for (let xIndex = 0; xIndex <= cells; xIndex++) {
      const x = -extent + xIndex * step;
      let distance = ellipseDistance(x, y, 0);
      for (let ellipse = 1; ellipse < ellipseCount; ellipse++)
        distance = smoothMinimum(distance, ellipseDistance(x, y, ellipse), softness);
      field[yIndex * rowStride + xIndex] = distance;
    }
  }

  // The box is deliberately larger than every permitted core/lobe envelope.
  // Refuse a clipped field rather than allowing a contour to open at its edge.
  for (let index = 0; index <= cells; index++) {
    if (
      field[index] < 0 ||
      field[cells * rowStride + index] < 0 ||
      field[index * rowStride] < 0 ||
      field[index * rowStride + cells] < 0
    )
      return 0;
  }

  edgeCrossing.fill(0, 0, edgeCount);
  neighborA.fill(-1, 0, edgeCount);
  neighborB.fill(-1, 0, edgeCount);
  visited.fill(0, 0, edgeCount);

  for (let yIndex = 0; yIndex <= cells; yIndex++) {
    const fieldRow = yIndex * rowStride;
    const y = -extent + yIndex * step;
    for (let xIndex = 0; xIndex < cells; xIndex++) {
      const left = field[fieldRow + xIndex];
      const right = field[fieldRow + xIndex + 1];
      if (left < 0 !== right < 0) {
        const edge = yIndex * cells + xIndex;
        const mix = crossingMix(left, right);
        edgeCrossing[edge] = 1;
        nodeX[edge] = -extent + (xIndex + mix) * step;
        nodeY[edge] = y;
      }
    }
  }

  for (let yIndex = 0; yIndex < cells; yIndex++) {
    const fieldRow = yIndex * rowStride;
    for (let xIndex = 0; xIndex <= cells; xIndex++) {
      const bottom = field[fieldRow + xIndex];
      const top = field[fieldRow + rowStride + xIndex];
      if (bottom < 0 !== top < 0) {
        const edge = horizontalEdgeCount + yIndex * (cells + 1) + xIndex;
        const mix = crossingMix(bottom, top);
        edgeCrossing[edge] = 1;
        nodeX[edge] = -extent + xIndex * step;
        nodeY[edge] = -extent + (yIndex + mix) * step;
      }
    }
  }

  for (let yIndex = 0; yIndex < cells; yIndex++) {
    const fieldRow = yIndex * rowStride;
    for (let xIndex = 0; xIndex < cells; xIndex++) {
      const bottomLeft = field[fieldRow + xIndex];
      const bottomRight = field[fieldRow + xIndex + 1];
      const topRight = field[fieldRow + rowStride + xIndex + 1];
      const topLeft = field[fieldRow + rowStride + xIndex];
      const caseCode =
        (bottomLeft < 0 ? 1 : 0) |
        (bottomRight < 0 ? 2 : 0) |
        (topRight < 0 ? 4 : 0) |
        (topLeft < 0 ? 8 : 0);
      if (caseCode === 0 || caseCode === 15) continue;

      const bottom = yIndex * cells + xIndex;
      const right = horizontalEdgeCount + yIndex * (cells + 1) + xIndex + 1;
      const top = (yIndex + 1) * cells + xIndex;
      const left = horizontalEdgeCount + yIndex * (cells + 1) + xIndex;
      let first = -1;
      let second = -1;
      let crossings = 0;
      if (edgeCrossing[bottom]) {
        first = bottom;
        crossings++;
      }
      if (edgeCrossing[right]) {
        if (crossings === 0) first = right;
        else second = right;
        crossings++;
      }
      if (edgeCrossing[top]) {
        if (crossings === 0) first = top;
        else if (crossings === 1) second = top;
        crossings++;
      }
      if (edgeCrossing[left]) {
        if (crossings === 0) first = left;
        else if (crossings === 1) second = left;
        crossings++;
      }

      if (crossings === 2) {
        connect(first, second);
      } else if (crossings === 4) {
        const determinant = bottomLeft * topRight - bottomRight * topLeft;
        const centerValue = (bottomLeft + bottomRight + topRight + topLeft) * 0.25;
        const centerInside =
          determinant === 0 ? centerValue < 0 : caseCode === 5 ? determinant > 0 : determinant < 0;
        if (caseCode === 5) {
          if (centerInside) {
            connect(bottom, right);
            connect(top, left);
          } else {
            connect(left, bottom);
            connect(right, top);
          }
        } else if (centerInside) {
          connect(left, bottom);
          connect(right, top);
        } else {
          connect(bottom, right);
          connect(top, left);
        }
      }
    }
  }

  let bestCount = 0;
  let bestArea = 0;
  let bestContainsCore = false;
  for (let start = 0; start < edgeCount; start++) {
    if (visited[start] || neighborA[start] < 0 || neighborB[start] < 0) continue;
    let previous = -1;
    let current = start;
    let loopCount = 0;
    let closed = false;
    while (loopCount < edgeCount) {
      if (current === start && loopCount > 0) {
        closed = true;
        break;
      }
      if (current < 0 || visited[current]) break;
      visited[current] = 1;
      loopNodes[loopCount++] = current;
      const next = neighborA[current] !== previous ? neighborA[current] : neighborB[current];
      previous = current;
      current = next;
    }
    if (!closed || loopCount < 3) continue;

    const area = loopArea(loopNodes, loopCount);
    const containsCore = polygonContains(loopNodes, loopCount, core.x, core.y);
    if (
      (containsCore && !bestContainsCore) ||
      (containsCore === bestContainsCore && area > bestArea)
    ) {
      bestContainsCore = containsCore;
      bestArea = area;
      bestCount = loopCount;
      for (let index = 0; index < loopCount; index++) bestLoopNodes[index] = loopNodes[index];
    }
  }
  if (bestCount < 3 || bestArea <= 1e-10) return 0;

  let perimeter = 0;
  for (let index = 0; index < bestCount; index++) {
    const current = bestLoopNodes[index];
    const next = bestLoopNodes[(index + 1) % bestCount];
    perimeter += Math.hypot(nodeX[next] - nodeX[current], nodeY[next] - nodeY[current]);
  }
  if (!Number.isFinite(perimeter) || perimeter <= 1e-6) return 0;

  let segment = 0;
  let segmentStart = 0;
  let firstNode = bestLoopNodes[0];
  let secondNode = bestLoopNodes[1];
  let segmentLength = Math.hypot(
    nodeX[secondNode] - nodeX[firstNode],
    nodeY[secondNode] - nodeY[firstNode],
  );
  for (let index = 0; index < outputCount; index++) {
    const distance = (perimeter * index) / outputCount;
    while (
      segment < bestCount - 1 &&
      (segmentLength <= 1e-8 || distance > segmentStart + segmentLength)
    ) {
      segmentStart += segmentLength;
      segment++;
      firstNode = bestLoopNodes[segment];
      secondNode = bestLoopNodes[(segment + 1) % bestCount];
      segmentLength = Math.hypot(
        nodeX[secondNode] - nodeX[firstNode],
        nodeY[secondNode] - nodeY[firstNode],
      );
    }
    const mix = segmentLength > 1e-8 ? (distance - segmentStart) / segmentLength : 0;
    target[index * 2] =
      centerX + (nodeX[firstNode] + (nodeX[secondNode] - nodeX[firstNode]) * mix) * shortEdge;
    target[index * 2 + 1] =
      centerY + (nodeY[firstNode] + (nodeY[secondNode] - nodeY[firstNode]) * mix) * shortEdge;
  }
  return outputCount;
}

function setEllipse(index: number, ellipse: FluidEllipse) {
  ellipseX[index] = finite(ellipse.x);
  ellipseY[index] = finite(ellipse.y);
  ellipseRadiusX[index] = Math.max(0.001, Math.abs(finite(ellipse.radiusX, 0.001)));
  ellipseRadiusY[index] = Math.max(0.001, Math.abs(finite(ellipse.radiusY, 0.001)));
  const angle = finite(ellipse.angle);
  ellipseCosine[index] = Math.cos(angle);
  ellipseSine[index] = Math.sin(angle);
}

function ellipseDistance(x: number, y: number, index: number) {
  const dx = x - ellipseX[index];
  const dy = y - ellipseY[index];
  const localX = dx * ellipseCosine[index] + dy * ellipseSine[index];
  const localY = -dx * ellipseSine[index] + dy * ellipseCosine[index];
  const radiusX = ellipseRadiusX[index];
  const radiusY = ellipseRadiusY[index];
  const normalized = Math.sqrt((localX / radiusX) ** 2 + (localY / radiusY) ** 2);
  return (normalized - 1) * Math.min(radiusX, radiusY);
}

function smoothMinimum(first: number, second: number, softness: number) {
  const blend = Math.max(softness - Math.abs(first - second), 0) / softness;
  return Math.min(first, second) - blend * blend * softness * 0.25;
}

function crossingMix(first: number, second: number) {
  const denominator = first - second;
  return denominator === 0 ? 0.5 : Math.max(0, Math.min(1, first / denominator));
}

function connect(first: number, second: number) {
  if (first === second || first < 0 || second < 0) return;
  if (neighborA[first] < 0) neighborA[first] = second;
  else neighborB[first] = second;
  if (neighborA[second] < 0) neighborA[second] = first;
  else neighborB[second] = first;
}

function loopArea(nodes: Int32Array, count: number) {
  let twiceArea = 0;
  for (let index = 0; index < count; index++) {
    const first = nodes[index];
    const second = nodes[(index + 1) % count];
    twiceArea += nodeX[first] * nodeY[second] - nodeX[second] * nodeY[first];
  }
  return Math.abs(twiceArea * 0.5);
}

function polygonContains(nodes: Int32Array, count: number, x: number, y: number) {
  let inside = false;
  for (let index = 0, previous = count - 1; index < count; previous = index++) {
    const first = nodes[index];
    const second = nodes[previous];
    const firstY = nodeY[first];
    const secondY = nodeY[second];
    if (firstY > y !== secondY > y) {
      const crossingX =
        nodeX[first] + ((nodeX[second] - nodeX[first]) * (y - firstY)) / (secondY - firstY);
      if (x < crossingX) inside = !inside;
    }
  }
  return inside;
}

function finite(value: number, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}
