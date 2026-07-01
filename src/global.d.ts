// DOM types not included in @cloudflare/workers-types but available at runtime

declare module '*.wasm' {
  const module: WebAssembly.Module;
  export default module;
}


interface ImageData {
  readonly data: Uint8ClampedArray;
  readonly height: number;
  readonly width: number;
  readonly colorSpace?: PredefinedColorSpace;
}

type PredefinedColorSpace = 'display-p3' | 'srgb';

type FormDataEntryValue = File | string;
