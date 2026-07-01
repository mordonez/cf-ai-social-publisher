import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';

// Stub .wasm imports so vitest (Node) can load modules that import them.
// Wrangler bundles .wasm as WebAssembly.Module at build time; in tests we
// never invoke processImage so null stubs are sufficient.
const wasmStub: Plugin = {
  name: 'wasm-test-stub',
  enforce: 'pre',
  resolveId(id) {
    if (id.endsWith('.wasm')) return `\0wasm-stub:${id}`;
  },
  load(id) {
    if (id.startsWith('\0wasm-stub:')) return 'export default null;';
  },
};

export default defineConfig({
  plugins: [wasmStub],
  test: {
    environment: 'node',
    setupFiles: ['./test-setup.ts'],
  },
});
