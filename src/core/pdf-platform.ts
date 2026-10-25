import { DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';

// PDF.js disables its Node polyfills when process.versions.electron is present.
// Utility processes have no DOM; supply the real canvas implementation before PDF.js evaluates.
for (const [name, value] of Object.entries({ DOMMatrix, ImageData, Path2D })) {
  if (!(name in globalThis)) Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
}
