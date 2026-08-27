import type { SeeCoderApi } from '../preload/preload';

declare global {
  interface Window { seecoder: SeeCoderApi; }
}

export {};

