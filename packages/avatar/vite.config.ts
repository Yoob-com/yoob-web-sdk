import { copyFileSync, mkdirSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";

/** Audio worklets are loaded by URL from `dist/worklets/`. */
function copyWorklets(): Plugin {
  return {
    name: "yoob-copy-worklets",
    writeBundle() {
      mkdirSync("dist/worklets", { recursive: true });
      for (const name of ["playback-worklet.js", "mic-worklet.js"]) {
        copyFileSync(`src/engine/audio/${name}`, `dist/worklets/${name}`);
      }
    },
  };
}

/**
 * ONNX Runtime's bundle refers to its WebAssembly binary with `new URL("…wasm", import.meta.url)`. Library mode would
 * inline that 23 MB binary into every worker. The SDK always sets `ort.env.wasm.wasmPaths` to the copy on the Yoob
 * CDN, so replace those references with a plain string that is never fetched.
 */
function externalOrtWasm(): Plugin {
  return {
    name: "yoob-external-ort-wasm",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("onnxruntime-web")) return null;
      const replaced = code.replace(/new URL\("(ort-wasm-[a-z-]+(?:\.[a-z]+)?\.wasm)",import\.meta\.url\)/g, 'new URL("https://cdn.yoob.com/v1/runtime/onnxruntime-web-1.27.0/$1")');
      return replaced === code ? null : { code: replaced, map: null };
    },
  };
}

// Library build. Workers and audio worklets are emitted as separate files next to index.js and loaded with
// `new URL(..., import.meta.url)`, which Vite, webpack 5, esbuild and Rollup consumers all resolve.
export default defineConfig({
  publicDir: false,
  // Relative URLs, so workers and worklets resolve next to index.js wherever a bundler places the package.
  base: "./",
  plugins: [externalOrtWasm(), copyWorklets()],
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    // Worklets must be real files: a data: URL breaks pages whose CSP has no data: script source.
    assetsInlineLimit: (file) => (/-worklet\.js$/.test(file) ? false : undefined),
    lib: {
      // `@yoob/avatar/livekit` is its own file, so the core never carries LiveKit code.
      entry: { index: "src/index.ts", livekit: "src/livekit.ts" },
      formats: ["es"],
      fileName: (_format, name) => `${name}.js`,
    },
    rollupOptions: {
      // The LiveKit entry's files import the core as "./index.js": keep that import rather than following it, so
      // index.js stays the whole core and the LiveKit entry loads the same copy.
      //
      // This is load-bearing in a way that is easy to miss. Let Rollup follow the import and it hoists the core into
      // a shared chunk, leaving index.js a stub — and the core builds its worker and worklet URLs from
      // `import.meta.url`, which then points at `dist/chunks/` instead of `dist/`. Workers survive it (Vite rewrites
      // those to `../workers/…`); worklets are plain `new URL("./worklets/…", moduleBase)` and do not, so audio dies
      // with a 404 that names a path nobody wrote. Any new file in this entry has to be listed here.
      external: (id, importer) =>
        /^livekit-client(\/|$)/.test(id)
        || (id === "./index.js" && /src[\\/](livekit|live-conversation)\.ts$/.test(importer ?? "")),
      output: { assetFileNames: "assets/[name]-[hash][extname]", chunkFileNames: "chunks/[name]-[hash].js" },
    },
  },
  worker: {
    format: "es",
    plugins: () => [externalOrtWasm()],
    rollupOptions: {
      output: { entryFileNames: "workers/[name]-[hash].js", chunkFileNames: "workers/[name]-[hash].js" },
    },
  },
});
