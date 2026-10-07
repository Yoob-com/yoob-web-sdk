"""The renderer on the closed-mouth window over the calm window's first host, Python app path (ffmpeg decode, VideoToolbox
colour fit, cv2 INTER_AREA crops, ONNX fp32) against the iOS probe's closed-crop.png (Core ML, the pack's renderer)."""
import json, sys, numpy as np, cv2, onnxruntime as ort
import os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from pyref_lib import host_rgb
pack_dir, ref_png, onnx = sys.argv[1], sys.argv[2], sys.argv[3]
P = json.load(open(f"{pack_dir}/pack.json")); g = P["geometry"]; inner, output, outer = g["inner"], g["output"], g["outer"]
face = outer // (output // inner); hole = g["hole"]; h = P["calmWindow"]["first"]
rgb = host_rgb(pack_dir, P, h); x0, y0, x1, y1 = P["hosts"]["boxes"][h]; box = rgb[y0:y1, x0:x1, ::-1].copy()
fc = cv2.resize(box, (face, face), interpolation=cv2.INTER_AREA); b = (face - inner) // 2; inn = fc[b:b+inner, b:b+inner]
img = np.concatenate([inn.transpose(2, 0, 1)] * 2, 0).astype(np.float32) / 255
img[3:, hole["y"]:hole["y"]+hole["height"], hole["x"]:hole["x"]+hole["width"]] = 0
audio = np.fromfile(f"{pack_dir}/closed_audio.f32", "<f4").reshape(1, 40, 1024)
y = ort.InferenceSession(onnx, providers=["CPUExecutionProvider"]).run(None, {"image": img[None], "audio": audio})[0][0]
crop = np.clip(np.trunc(y * np.float32(255)), 0, 255).astype(np.uint8).transpose(1, 2, 0)
ref = cv2.imread(ref_png)
s = output // inner; d = np.abs(ref.astype(int) - crop.astype(int)); hy, hx = hole["y"] * s, hole["x"] * s
dh = d[hy:hy + hole["height"] * s, hx:hx + hole["width"] * s]
print(json.dumps({"pack": P["id"], "host": h, "crop_mae": round(float(d.mean()), 3), "hole_mae": round(float(dh.mean()), 3), "max": int(d.max()), "p99": float(np.percentile(d, 99))}))
