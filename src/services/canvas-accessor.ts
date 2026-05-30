/**
 * @fileoverview DataCanvas accessor — module-level singleton wired in setup().
 * @module services/canvas-accessor
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';

let _canvas: DataCanvas | undefined;

/** Set the DataCanvas instance (called from createApp's setup()). */
export function setCanvas(c: DataCanvas | undefined): void {
  _canvas = c;
}

/** Get the DataCanvas instance. Returns undefined when canvas is not enabled. */
export function getCanvas(): DataCanvas | undefined {
  return _canvas;
}
