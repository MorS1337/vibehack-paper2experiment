import type { AppAPI } from '../../shared/types.js';

/**
 * The preload bridge is the renderer's only privileged surface.
 * Never import electron or node modules from the renderer.
 */
export function getApi(): AppAPI | null {
  if (typeof window === 'undefined') return null;
  const candidate = window.paper2;
  if (!candidate || typeof candidate.snapshot !== 'function') return null;
  return candidate;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.trim() || error.name;
  }
  if (typeof error === 'string') {
    return error.trim() || 'Неизвестная ошибка';
  }
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message.trim() || 'Неизвестная ошибка';
  }
  return 'Неизвестная ошибка';
}
