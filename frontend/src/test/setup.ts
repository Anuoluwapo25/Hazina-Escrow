import { vi } from 'vitest';

// Mock import.meta.env
vi.stubGlobal('import.meta.env', {
  VITE_API_URL: 'http://localhost:3000',
  VITE_API_KEY: 'test-api-key',
  VITE_STELLAR_NETWORK: 'testnet',
});

// Mock window.matchMedia with a plain function — not a `vi.fn()` — so that
// `vi.restoreAllMocks()`/`vi.resetAllMocks()` in individual test files can't
// wipe its implementation mid-suite and leave later mounts calling `undefined`.
vi.stubGlobal('matchMedia', (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
}));

// Mock WebSocket
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url: string) {
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      if (this.onopen) {
        this.onopen(new Event('open'));
      }
    }, 0);
  }

  url: string;
  readyState: number;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  send(_data: string) {
    // Mock send
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose(new CloseEvent('close'));
    }
  }
}

vi.stubGlobal('WebSocket', MockWebSocket);
