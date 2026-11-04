export type View = { x: number; y: number; w: number; h: number };
export type Rect = { left: number; top: number; width: number; height: number };
export type Point = { x: number; y: number };

export const MIN_SCALE: number;
export const MAX_SCALE: number;
export const FIT: View;
export function clampScale(scale: number): number;
export function scaleOf(view: View, fit?: View): number;
export function pixelsPerUnit(view: View, rect: Rect): number;
export function toMap(view: View, rect: Rect, cx: number, cy: number): Point;
export function zoomAt(view: View, factor: number, at: Point, fit?: View): View;
export function panBy(view: View, dx: number, dy: number, rect: Rect): View;
export function wheelFactor(event: { deltaY: number; deltaMode: number; ctrlKey: boolean }): number;
export function centreOf(view: View): Point;
export function approach(now: View, goal: View, share: number): View;
export function arrived(now: View, goal: View): boolean;
