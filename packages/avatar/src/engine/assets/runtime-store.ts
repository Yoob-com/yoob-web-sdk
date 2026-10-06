// Runtime assets for the render worker, served from the Yoob CDN (see ../../cdn.ts).
import { ChunkStore, type CdnAccess, type CharacterManifest } from "../../cdn";

export interface RuntimeAssetRecord {
  bytes: number;
  sha256: string;
}

export interface RuntimeAssetManifest {
  version: string;
  total_bytes: number;
  files: Record<string, RuntimeAssetRecord>;
}

export interface RuntimeAssetConfig extends CdnAccess {
  /** The verified character manifest (the page checked its signature). */
  manifest: CharacterManifest;
  /** Where the patched ONNX Runtime WebAssembly binary is served. */
  ortWasmUrl: string;
}

export interface RuntimeAssetEvent {
  level: "info" | "success" | "warning";
  message: string;
  path?: string;
  loaded?: number;
  total?: number;
  aggregateLoaded?: number;
  aggregateTotal?: number;
  cached?: boolean;
  elapsedMs?: number;
}

type EventSink = (event: RuntimeAssetEvent) => void;

export class RuntimeAssetStore {
  private readonly chunks: ChunkStore;
  private readonly manifestValue: RuntimeAssetManifest;
  private loaded = 0;

  constructor(private readonly config: RuntimeAssetConfig, private readonly onEvent: EventSink = () => undefined) {
    this.chunks = new ChunkStore(config, config.manifest);
    const files: Record<string, RuntimeAssetRecord> = {};
    for (const file of config.manifest.files) files[file.path] = { bytes: file.size, sha256: file.sha256 };
    this.manifestValue = {
      version: config.manifest.runtime?.assetVersion ?? config.manifest.version,
      total_bytes: config.manifest.files.reduce((sum, file) => sum + file.size, 0),
      files,
    };
  }

  get manifest(): RuntimeAssetManifest {
    return this.manifestValue;
  }

  async initialize(): Promise<RuntimeAssetManifest> {
    return this.manifestValue;
  }

  /** Forgets a file's bytes, so a model handed to ORT is not also kept on the heap for the session. */
  release(path: string): void {
    this.chunks.release(path);
  }

  async bytes(path: string): Promise<ArrayBuffer> {
    const started = performance.now();
    const data = await this.chunks.bytes(path, (bytes, cached) => {
      this.loaded += bytes;
      this.onEvent({
        level: "info",
        message: cached ? `Loaded ${path} from cache` : `Downloading ${path}`,
        path,
        cached,
        aggregateLoaded: this.loaded,
        aggregateTotal: this.manifestValue.total_bytes,
      });
    });
    this.onEvent({ level: "success", message: `Verified ${path}`, path, elapsedMs: performance.now() - started });
    return data;
  }

  async json<T>(path: string): Promise<T> {
    return JSON.parse(new TextDecoder().decode(await this.bytes(path))) as T;
  }
}
