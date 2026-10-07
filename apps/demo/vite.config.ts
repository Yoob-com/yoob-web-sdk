import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";

/**
 * Development only. FeatherTalk character packs from a local directory (`YOOB_PACKS_DIR`, served at /packs/<id>/, built
 * with scripts/feathertalk-pack.mjs), test audio from `YOOB_REF_DIR` (/ref/), and the parity page's results written to
 * `YOOB_PARITY_OUT` (POST /__parity/<run>/<file>, `?append=1` to append). Nothing here is part of the SDK.
 */
function localPacks(): Plugin {
  const serve = (prefix: string, dir: string | undefined) => (req: { url?: string }, res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (b?: unknown) => void }, next: () => void) => {
    if (!dir || !req.url?.startsWith(prefix)) return next();
    const rel = decodeURIComponent(req.url.slice(prefix.length).split("?")[0]);
    const file = path.resolve(dir, rel);
    if (!file.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
    res.setHeader("content-type", file.endsWith(".json") ? "application/json" : file.endsWith(".jpg") ? "image/jpeg" : "application/octet-stream");
    res.setHeader("cache-control", "no-store");
    res.end(fs.readFileSync(file));
  };
  return {
    name: "yoob-local-packs",
    apply: "serve",
    configureServer(server) {
      // On the SDK's sources (YOOB_SDK_SOURCE=1) the audio worklets sit next to their module, not in dist/worklets/.
      server.middlewares.use((req, _res, next) => {
        if (req.url?.includes("/src/engine/audio/worklets/")) req.url = req.url.replace("/src/engine/audio/worklets/", "/src/engine/audio/");
        next();
      });
      server.middlewares.use(serve("/packs/", process.env.YOOB_PACKS_DIR));
      server.middlewares.use(serve("/ref/", process.env.YOOB_REF_DIR));
      server.middlewares.use((req, res, next) => {
        const out = process.env.YOOB_PARITY_OUT;
        if (!out || req.method !== "POST" || !req.url?.startsWith("/__parity/")) return next();
        const [rel, query] = req.url.slice("/__parity/".length).split("?");
        const file = path.resolve(out, decodeURIComponent(rel));
        if (!file.startsWith(path.resolve(out) + path.sep)) { res.statusCode = 400; return res.end(); }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const body = Buffer.concat(chunks);
          if (query === "append=1") fs.appendFileSync(file, body); else fs.writeFileSync(file, body);
          res.end("ok");
        });
      });
    },
  };
}

// /yoob-session goes to your backend (Examples: ../../examples/token-server). Here it is proxied to port 3100.
// YOOB_SDK_SOURCE=1 runs the demo on the SDK's TypeScript sources instead of its build (packages/avatar/dist).
const sdkSource = process.env.YOOB_SDK_SOURCE === "1"
  ? { "@yoob/avatar": path.resolve(import.meta.dirname, "../../packages/avatar/src/index.ts") } : undefined;

export default defineConfig({
  plugins: [localPacks()],
  resolve: sdkSource ? { alias: sdkSource } : undefined,
  server: {
    proxy: { "/yoob-session": "http://127.0.0.1:3100", "/yoob-voice": "http://127.0.0.1:3100", "/openai-secret": "http://127.0.0.1:3100" },
  },
  optimizeDeps: { exclude: ["@yoob/avatar", "onnxruntime-web"] },
});
