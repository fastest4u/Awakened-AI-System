import '@testing-library/jest-dom/vitest';

if (typeof window !== 'undefined') {
  window.scrollTo = () => {};
  Element.prototype.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};

  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  if (typeof globalThis.DOMMatrixReadOnly === 'undefined') {
    class MockDOMMatrixReadOnly {
      a = 1;
      b = 0;
      c = 0;
      d = 1;
      e = 0;
      f = 0;
      m11 = 1;
      m12 = 0;
      m21 = 0;
      m22 = 1;
      m41 = 0;
      m42 = 0;
      is2D = true;
      isIdentity = true;

      constructor(init?: string | number[]) {
        if (Array.isArray(init) && init.length >= 6) {
          [this.a, this.b, this.c, this.d, this.e, this.f] = init;
          this.m11 = this.a;
          this.m12 = this.b;
          this.m21 = this.c;
          this.m22 = this.d;
          this.m41 = this.e;
          this.m42 = this.f;
        }
      }

      inverse() {
        return new MockDOMMatrixReadOnly();
      }

      multiply() {
        return new MockDOMMatrixReadOnly();
      }

      transformPoint(p?: { x?: number; y?: number }) {
        return { x: p?.x ?? 0, y: p?.y ?? 0, z: 0, w: 1 };
      }
    }
    (globalThis as Record<string, unknown>).DOMMatrixReadOnly = MockDOMMatrixReadOnly;
    (globalThis as Record<string, unknown>).DOMMatrix = MockDOMMatrixReadOnly;
  }

  if (typeof HTMLElement !== 'undefined') {
    const ownWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    if (!ownWidth || ownWidth.configurable) {
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
        configurable: true,
        get() {
          return parseFloat(this.style?.width) || 960;
        },
      });
    }
    const ownHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    if (!ownHeight || ownHeight.configurable) {
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
        configurable: true,
        get() {
          return parseFloat(this.style?.height) || 620;
        },
      });
    }
  }
}
