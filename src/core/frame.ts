import type { Container } from 'pixi.js';
import { Signal } from './Signal';

/**
 * Global per-frame tick (dt in ms, clamped), emitted by the App before
 * rendering. Components subscribe through UIComponent.onFrame so the
 * subscription dies with the component.
 */
export const frame = new Signal<[dt: number]>();

/** Monotonic frame counter, handy for once-per-frame caches. */
export const frameStats = { count: 0, time: 0 };

/** The Pixi stage, registered by the App, used for on-screen checks. */
export const scene: { stage: Container | null } = { stage: null };
