/**
 * What a component test needs of the window that jsdom does not give it: a `matchMedia` that answers every query
 * false, which the Assistant reads as a wide screen with the sidebar beside the page rather than a drawer over it, and
 * a `ResizeObserver` that observes nothing, for the parts that watch their own width with no layout to measure.
 * Called from each test file's `beforeEach`, since a test may replace either.
 */
export function stubWideWindow(): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })
  });
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  });
}
