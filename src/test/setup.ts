import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// jsdom doesn't ship ResizeObserver, but several components use it.
// Provide a no-op mock so smoke tests can mount without error.
globalThis.ResizeObserver = class {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
} as unknown as typeof ResizeObserver;
