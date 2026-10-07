#!/usr/bin/env node
// Builds a FeatherTalk web character pack (packages/avatar/FORMAT.md) from a Luna app face folder and its ONNX models.
//
//   node scripts/feathertalk-pack.mjs --face <iOS face folder> --onnx <dir with renderer.onnx / renderer.fp16.onnx>
//        --encoder <encoder.onnx> --id <character id> --out <pack dir> [--renderer fp16|fp32] [--name <display name>]
//
// The face folder is only read. Every file taken from its pack is checked against the pack's own receipts first. The
// output directory is replaced. Never point --out inside a committed folder: packs hold model weights (`packs/` is
// ignored by git). Needs ffmpeg and ffprobe.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) =>
  value.startsWith("--") ? [...pairs, [value.slice(2), all[index + 1]]] : pairs, []));
for (const name of ["face", "onnx", "encoder", "id", "out"]) if (!args[name]) fail(`missing --${name}`);
const expand = (p) => path.resolve(p.replace(/^~(?=\/)/, process.env.HOME));
const face = expand(args.face), onnxDir = expand(args.onnx), encoderFile = expand(args.encoder), out = expand(args.out);
const id = args.id;
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) fail(`invalid id ${id}`);
const precision = args.renderer ?? "fp16";
if (!["fp16", "fp32"].includes(precision)) fail("--renderer must be fp16 or fp32");

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const readJSON = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
function fail(message) { console.error(`feathertalk-pack: ${message}`); process.exit(1); }

// 1. The iOS face folder.
const settings = readJSON(path.join(face, "face.json"));
const packDir = path.join(face, settings.pack ?? "pack");
const manifest = readJSON(path.join(packDir, "manifest.json"));
const manifestSHA = sha256(fs.readFileSync(path.join(packDir, "manifest.json")));
function verified(rel) {
  const receipt = manifest.files[rel];
  if (!receipt) fail(`${rel} has no receipt in ${packDir}/manifest.json`);
  const data = fs.readFileSync(path.join(packDir, rel));
  if (data.length !== receipt.bytes || sha256(data) !== receipt.sha256) fail(`${rel} does not match its receipt`);
  return data;
}
check(manifest.version === 1 && manifest.fps === 25 && manifest.sampleRate === 16000 && manifest.samplesPerFrame === 640
  && manifest.encoderTailSamples === 80 && manifest.channelOrder === "BGR", "runtime contract");
check(JSON.stringify(manifest.encoderWindowFrames) === JSON.stringify([8, 13, 14, 15, 16, 17, 18, 19, 20, 21]), "encoder windows");
check(manifest.frames.length === manifest.sourceHostFrames && manifest.videoContainer === true, "host frames");
const videoFile = manifest.frames[0].file;
manifest.frames.forEach((frame, index) => {
  const [x0, y0, x1, y1] = frame.bbox;
  check(frame.row === index && (frame.frame ?? index) === index && frame.file === videoFile && x1 - x0 === y1 - y0
    && x0 >= 0 && y0 >= 0 && x1 <= frame.width && y1 <= frame.height, `host ${index}`);
});
function check(ok, what) { if (!ok) fail(`${packDir}: ${what}`); }

const calm = readJSON(path.join(face, "calm-window.json"));
delete calm._doc;
const poses = fs.existsSync(path.join(face, "host-poses.json")) ? readJSON(path.join(face, "host-poses.json")) : null;
const still = readJSON(path.join(face, "still", "still.json"));
check(still.host === calm.first, "still.host is not the calm window's first host (the app then shows no head path)");

// 2. Output.
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "still"), { recursive: true });
const files = {};
function write(rel, data) {
  fs.writeFileSync(path.join(out, rel), data);
  files[rel] = { bytes: data.length, sha256: sha256(data) };
}

write("closed_audio.f32", verified("closed_audio.f32"));
const hevc = verified(videoFile);
write("hosts.mp4", hevc);
for (const name of ["base.jpg", ...still.blinks]) write(`still/${name}`, fs.readFileSync(path.join(face, "still", name)));

// 3. Models. The ONNX export's own receipts (INDEX.json entry / export.json) are checked when present.
const rendererName = precision === "fp16" ? "renderer.fp16.onnx" : "renderer.onnx";
const renderer = fs.readFileSync(path.join(onnxDir, rendererName));
const exportRecord = ["export.json", "parity.json"].map((name) => path.join(onnxDir, name)).filter(fs.existsSync)
  .map((file) => ({ [path.basename(file)]: readJSON(file) })).reduce((all, one) => ({ ...all, ...one }), {});
const indexFile = path.join(path.dirname(onnxDir), "INDEX.json");
const indexEntry = fs.existsSync(indexFile) ? readJSON(indexFile).faces?.find((entry) => entry.id === path.basename(onnxDir)) : undefined;
if (indexEntry) {
  if (indexEntry.identity !== manifest.identity) fail(`ONNX export is ${indexEntry.identity}, the face is ${manifest.identity}`);
  const receipt = indexEntry.files?.[rendererName];
  if (receipt && (receipt.bytes !== renderer.length || receipt.sha256 !== sha256(renderer))) fail(`${rendererName} does not match INDEX.json`);
}
write("renderer.onnx", renderer);
write("encoder.onnx", fs.readFileSync(encoderFile));

// 4. Host videos: the HEVC as shipped, and an H.264 fallback.
const hevcIndex = videoIndex(path.join(out, "hosts.mp4"), manifest.frames.length);
const colour = probeColour(path.join(out, "hosts.mp4"));
const h264Path = path.join(out, "hosts.h264.mp4");
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", path.join(out, "hosts.mp4"), "-map", "0:v:0", "-c:v", "libx264", "-preset", "slow",
  "-profile:v", "high", "-g", "15", "-keyint_min", "15", "-sc_threshold", "0", "-bf", "0", "-crf", "14", "-pix_fmt", "yuv420p",
  "-colorspace", colour.matrix, "-color_primaries", colour.primaries, "-color_trc", colour.transfer, "-color_range", colour.range,
  "-fps_mode", "passthrough", "-movflags", "+faststart", "-an", h264Path]);
const h264Index = videoIndex(h264Path, manifest.frames.length);
files["hosts.h264.mp4"] = { bytes: fs.statSync(h264Path).size, sha256: sha256(fs.readFileSync(h264Path)) };
const psnr = /average:([0-9.]+|inf)/.exec(spawnSync("ffmpeg", ["-v", "info", "-i", h264Path, "-i", path.join(out, "hosts.mp4"),
  "-lavfi", "psnr", "-f", "null", "-"], { encoding: "utf8" }).stderr ?? "")?.[1];

// 5. Face settings, as the app derives them (LipTiming.instantLips, LipPicture.face(identity:)).
const lead = clampInt(settings.lipLeadMilliseconds ?? 0, 0, 200);
const lookahead = Math.max(0, Math.min(12, settings.earlyLookaheadFrames ?? Math.round(lead / 40) + 1));
const instantLips = {
  lookaheadFrames: lookahead,
  batchFrames: Math.max(1, Math.min(6, settings.earlyBatchFrames ?? 1)),
  standIn: settings.standIn === "silence" ? "silence" : "mirror",
  voiceDelayMilliseconds: clampInt(settings.voiceDelayMilliseconds ?? Math.max(0, (2 * lookahead + 1) * 20 - lead + 30 + 20), 0, 1000),
};
const articulationGain = Number.isFinite(settings.articulationGain) ? Math.max(0.5, Math.min(2, settings.articulationGain)) : 1;
function clampInt(value, low, high) { return Math.max(low, Math.min(high, Math.round(value))); }

const pack = {
  format: "feathertalk-web",
  schema: 1,
  id,
  name: args.name ?? settings.name ?? id,
  identity: manifest.identity,
  audio: {
    sampleRate: 16000, fps: 25, samplesPerFrame: 640, encoderTailSamples: 80,
    waveformMean: manifest.waveformMean, waveformStd: manifest.waveformStd, encoderWindowFrames: manifest.encoderWindowFrames,
  },
  windows: { lookahead: manifest.lookahead, left: manifest.leftContext, right: manifest.rightContext, bootstrap: manifest.bootstrap },
  geometry: {
    inner: manifest.innerSize, output: manifest.outputSize, outer: manifest.outerSize,
    hole: manifest.hole ?? { x: 4, y: 4, width: 135, height: 130 }, featherPixels: manifest.featherPixels ?? 8, channelOrder: "BGR",
  },
  models: {
    encoder: { file: "encoder.onnx", input: "audio", output: "hidden", batch: true },
    renderer: { file: "renderer.onnx", image: "image", audio: "audio", output: "clip_0", precision },
    closedAudio: "closed_audio.f32",
  },
  hosts: {
    width: manifest.frames[0].width, height: manifest.frames[0].height, count: manifest.frames.length,
    boxes: manifest.frames.map((frame) => frame.bbox),
    colour,
    videos: [
      { file: "hosts.mp4", ...hevcIndex },
      { file: "hosts.h264.mp4", ...h264Index },
    ],
  },
  calmWindow: calm,
  hostPoses: poses,
  still: {
    base: "still/base.jpg", host: still.host, rect: still.rect, sequence: still.sequence,
    blinks: still.blinks.map((name) => `still/${name}`),
  },
  face: { voice: settings.voice ?? null, lipLeadMilliseconds: lead, articulationGain },
  instantLips,
  lipPicture: lipPicture(manifest.identity),
  files,
  source: {
    faceFolder: face, faceId: settings.id, iosManifestSHA256: manifestSHA, iosIdentity: manifest.identity,
    iosRendererReceipt: manifest.source?.renderer ?? null, onnx: { dir: onnxDir, renderer: rendererName, index: indexEntry ?? null, ...exportRecord },
    h264PSNR: psnr ? Number(psnr) : null, built: new Date().toISOString(),
  },
};
fs.writeFileSync(path.join(out, "pack.json"), JSON.stringify(pack, null, 1));
const total = Object.values(files).reduce((sum, file) => sum + file.bytes, 0);
console.log(`${id}: ${manifest.identity}, ${manifest.frames.length} hosts, renderer ${precision} ${(renderer.length / 1e6).toFixed(1)} MB, `
  + `HEVC ${(hevc.length / 1e6).toFixed(1)} MB, H.264 ${(files["hosts.h264.mp4"].bytes / 1e6).toFixed(1)} MB (${psnr} dB), `
  + `lip picture ${pack.lipPicture ? "yes" : "none"}, articulation ${articulationGain}, ${(total / 1e6).toFixed(1)} MB in ${out}`);

/** Codec string, decoder description and per-frame byte ranges of the first video track, frames in display order. */
function videoIndex(file, expectedFrames) {
  const data = fs.readFileSync(file);
  const entry = sampleEntry(data);
  const packets = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries",
    "packet=pts,dts,pos,size,flags", "-of", "json", file], { encoding: "utf8", maxBuffer: 64 << 20 })).packets;
  if (packets.length !== expectedFrames) fail(`${path.basename(file)} has ${packets.length} frames, the pack ${expectedFrames}`);
  const ordered = [...packets].sort((a, b) => Number(a.pts) - Number(b.pts));
  if (ordered.some((packet, index) => packet !== packets[index])) fail(`${path.basename(file)} reorders frames (B-frames)`);
  const keys = packets.map((packet) => packet.flags.startsWith("K"));
  const interval = keys.indexOf(true, 1);
  if (!keys[0] || interval <= 0 || keys.some((key, index) => key !== (index % interval === 0))) {
    fail(`${path.basename(file)}: keyframes are not every ${interval} frames`);
  }
  return {
    codec: entry.codec, description: entry.description.toString("base64"), keyframeInterval: interval,
    frames: packets.map((packet) => [Number(packet.pos), Number(packet.size)]),
  };
}

/** The video sample entry's codec string and its hvcC / avcC (moov/trak/mdia/minf/stbl/stsd). */
function sampleEntry(data) {
  const boxes = (start, end) => {
    const list = [];
    for (let at = start; at + 8 <= end;) {
      let size = data.readUInt32BE(at), header = 8;
      const type = data.toString("latin1", at + 4, at + 8);
      if (size === 1) { size = Number(data.readBigUInt64BE(at + 8)); header = 16; }
      if (size === 0) size = end - at;
      if (size < header || at + size > end) fail("malformed MP4");
      list.push({ type, start: at + header, end: at + size });
      at += size;
    }
    return list;
  };
  const child = (box, type) => boxes(box.start, box.end).find((b) => b.type === type);
  const moov = boxes(0, data.length).find((b) => b.type === "moov");
  for (const trak of boxes(moov.start, moov.end).filter((b) => b.type === "trak")) {
    const mdia = child(trak, "mdia"), handler = mdia && child(mdia, "hdlr");
    if (!handler || data.toString("latin1", handler.start + 8, handler.start + 12) !== "vide") continue;
    const stsd = child(child(child(mdia, "minf"), "stbl"), "stsd");
    const [entry] = boxes(stsd.start + 8, stsd.end);
    const config = boxes(entry.start + 78, entry.end).find((b) => b.type === "hvcC" || b.type === "avcC");
    if (!config) fail(`no hvcC/avcC in ${entry.type}`);
    const description = data.subarray(config.start, config.end);
    return { codec: config.type === "hvcC" ? hevcCodec(entry.type, description) : avcCodec(entry.type, description), description };
  }
  fail("no video track");
}

function avcCodec(fourcc, avcC) {
  return `${fourcc}.${[avcC[1], avcC[2], avcC[3]].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** RFC 6381 / ISO 14496-15 Annex E codec string from an hvcC record. */
function hevcCodec(fourcc, hvcC) {
  const space = hvcC[1] >> 6, tier = (hvcC[1] >> 5) & 1, profile = hvcC[1] & 31;
  let compat = hvcC.readUInt32BE(2), reversed = 0;
  for (let bit = 0; bit < 32; bit += 1) { reversed = (reversed << 1) | (compat & 1); compat >>>= 1; }
  const constraints = [...hvcC.subarray(6, 12)];
  while (constraints.length && constraints[constraints.length - 1] === 0) constraints.pop();
  return [fourcc, `${["", "A", "B", "C"][space]}${profile}`, (reversed >>> 0).toString(16), `${tier ? "H" : "L"}${hvcC[12]}`,
    ...constraints.map((b) => b.toString(16))].join(".");
}

function probeColour(file) {
  const [stream] = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries",
    "stream=color_space,color_primaries,color_transfer,color_range", "-of", "json", file], { encoding: "utf8" })).streams;
  return { matrix: stream.color_space, primaries: stream.color_primaries, transfer: stream.color_transfer, range: stream.color_range };
}

/**
 * LipPicture.face(identity:) (language-companions AvatarRuntime/LipPicture.swift, with the astrid-b350 build's
 * Astrid B350 identity): the unsharp amount, the teeth's extra amount and the mouth region, or null.
 */
function lipPicture(identity) {
  const softness = 24 / 288;
  const table = {
    "avatars20-r2-f01-valentina-e24": [1.2, 0.48, 0.38, 0.45, 0.28, 20, 1.5],
    "avatars20-r2-f04-leonie-e24": [1.2, 0.48, 0.50, 0.45, 0.38, -20, 1.5],
    "avatars20-r2-f08-astrid-e24": [1.2, 0.48, 0.54, 0.45, 0.38, -20, 1.5],
    "astrid-exp-B350-e174": [1.2, 0.48, 0.54, 0.45, 0.38, -20, 1.5],
    "avatars20-r2-m01-santiago-e49": [1.2, 0.50, 0.34, 0.30, 0.43, 0, 0],
    "avatars20-r2-m03-julien-e24": [1.2, 0.42, 0.52, 0.50, 0.33, -20, 0],
    "avatars20-r2-m05-lars-e19": [1.2, 0.44, 0.52, 0.55, 0.38, -20, 1.5],
    "avatars20-r2-f10-linda-e24": [1.2, 0.56, 0.34, 0.30, 0.38, 20, 1.5],
  };
  const values = table[identity];
  if (!values) return null;
  const [sharpen, centerX, centerY, radiusX, radiusY, rotationDegrees, teeth] = values;
  return { sharpen, teeth, mouth: { centerX, centerY, radiusX, radiusY, rotationDegrees, softness } };
}
