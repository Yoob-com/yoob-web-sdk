import json, sys, numpy as np
ref_dir, web_dir, pack = sys.argv[1], sys.argv[2], sys.argv[3]
S = 448
rep = json.load(open(f"{ref_dir}/stream-report.json")); web = json.load(open(f"{web_dir}/report.json"))
boxes = json.load(open(f"{pack}/pack.json"))["hosts"]["boxes"]
ref = np.memmap(f"{ref_dir}/faces.bgr", np.uint8, "r").reshape(-1, S, S, 3)
wf = np.memmap(f"{web_dir}/faces.bgr", np.uint8, "r").reshape(-1, S, S, 3)
order = sorted(range(len(web["metas"])), key=lambda i: web["metas"][i]["frame"]); metas = [web["metas"][i] for i in order]; n = min(len(metas), len(ref) - 0, int(sys.argv[4]) if len(sys.argv) > 4 else 10**9)
hosts_ok = sum(1 for i in range(n) if metas[i]["host"] == rep["hosts"][i]); blink_ok = sum(1 for i in range(n) if metas[i]["blink"] == rep["blinks"][i])
raw_ok = sum(1 for i in range(n) if abs(metas[i]["raw"] - rep["raw"][i]) < 1e-6)
rows = []
for i in range(n):
    x, y = metas[i]["x"], metas[i]["y"]; rx, ry, rh = rep["faceWindows"][i]
    x0, y0, x1, y1 = boxes[metas[i]["host"]]; side = x1 - x0
    mx0, mx1 = int(x0 + .2 * side) - x, int(x0 + .8 * side) - x; my0, my1 = int(y0 + .55 * side) - y, int(y0 + .95 * side) - y
    a = ref[i].astype(np.int16); b = wf[order[i]].astype(np.int16); d = np.abs(a - b)
    rows.append((d.mean(), d[my0:my1, mx0:mx1].mean(), d.max(), metas[i]["raw"], (x, y) == (rx, ry)))
r = np.array([[a, b, c, d] for a, b, c, d, _ in rows])
speech = r[:, 3] < 1
print(json.dumps({"frames": n, "hosts_equal": hosts_ok, "blinks_equal": blink_ok, "raw_equal": raw_ok,
  "window_mae": round(float(r[:, 0].mean()), 3), "mouth_mae_all": round(float(r[:, 1].mean()), 3),
  "mouth_mae_speech": round(float(r[speech, 1].mean()), 3) if speech.any() else None, "mouth_mae_speech_p95": round(float(np.percentile(r[speech, 1], 95)), 3) if speech.any() else None,
  "mouth_mae_silence": round(float(r[~speech, 1].mean()), 3) if (~speech).any() else None, "max_abs": int(r[:, 2].max()), "speech_frames": int(speech.sum())}))
if len(sys.argv) > 5:
    from PIL import Image
    picks = [int(v) for v in sys.argv[5].split(",")]
    strip = np.concatenate([np.concatenate([ref[i][..., ::-1], wf[order[i]][..., ::-1], np.clip(np.abs(ref[i].astype(int) - wf[order[i]].astype(int)) * 8, 0, 255).astype(np.uint8)[..., ::-1]], 0) for i in picks], 1)
    Image.fromarray(strip).save(f"{web_dir}/strip.jpg", quality=90); print("strip", f"{web_dir}/strip.jpg")
