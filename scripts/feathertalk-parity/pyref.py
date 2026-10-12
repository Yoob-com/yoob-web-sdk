"""Python reproduction of the iOS app path for single frames (the parity reference where no iOS probe render exists).

For each dumped web frame (its renderer audio window and model crop, saved by the parity page): the host frame decoded by
ffmpeg (the same HEVC bitstream iOS decodes), converted to RGB with the VideoToolbox fit (image-ops VT_601_RGB), the
renderer crops cut as iOS DerivedCrops does (cv2 INTER_AREA, which DerivedCrops matches bit for bit), the renderer run in
ONNX Runtime CPU fp32, and the frame composed as AvatarCompositor does (LipPicture sharpening and matte, cv2 Lanczos-4,
feather, silence mix, blink picture). Prints model-crop and composed-window differences against the web engine."""
import json, os, sys, subprocess, numpy as np, cv2, onnxruntime as ort
pack_dir, run_dir, onnx = sys.argv[1], sys.argv[2], sys.argv[3]
P = json.load(open(f"{pack_dir}/pack.json")); R = json.load(open(f"{run_dir}/report.json"))
g = P["geometry"]; inner, output, outer = g["inner"], g["output"], g["outer"]; scale = output // inner; face = outer // scale
hole = g["hole"]; margin = (outer - output) // 2
W, H = P["hosts"]["width"], P["hosts"]["height"]
VT = np.array([[1.165439, -0.004124, 1.57445, -219.925007], [1.16252, -0.38975, -0.79723, 133.58311], [1.166452, 2.016199, -0.006857, -276.328849]])
sess = ort.InferenceSession(onnx, providers=["CPUExecutionProvider"])
def host_rgb(h):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", f"{pack_dir}/hosts.mp4", "-vf", f"select=eq(n\\,{h})", "-vsync", "0", "-frames:v", "1",
                          "-f", "rawvideo", "-pix_fmt", "yuv420p", "-"], capture_output=True, check=True).stdout
    Y = np.frombuffer(raw[:W*H], np.uint8).reshape(H, W).astype(np.float64)
    def up(C):
        C = C.astype(np.float64); nx = np.concatenate([C[:, 1:], C[:, -1:]], 1)
        h_ = np.zeros((C.shape[0], W)); h_[:, 0::2] = C; h_[:, 1::2] = (C + nx) / 2
        ny = np.concatenate([h_[1:], h_[-1:]], 0); v = np.zeros((H, W)); v[0::2] = h_; v[1::2] = (h_ + ny) / 2; return v
    U = up(np.frombuffer(raw[W*H:W*H+W*H//4], np.uint8).reshape(H//2, W//2)); V = up(np.frombuffer(raw[W*H+W*H//4:], np.uint8).reshape(H//2, W//2))
    rgb = np.stack([VT[c, 0]*Y + VT[c, 1]*U + VT[c, 2]*V + VT[c, 3] for c in range(3)], -1)
    return np.clip(np.round(rgb), 0, 255).astype(np.uint8)
def sharpen(crop, amount, teeth, region):
    c = crop.astype(np.float32); k = np.array([1, 4, 6, 4, 1], np.float32)
    pad = np.pad(c, ((2, 2), (2, 2), (0, 0)), mode="edge")
    hsum = sum(k[i] * pad[:, i:i + crop.shape[1]] for i in range(5)); vsum = sum(k[j] * hsum[j:j + crop.shape[0]] for j in range(5))
    blur = vsum / 256; amt = np.full(crop.shape[:2], amount, np.float32)
    if teeth:
        b, gg, r = c[..., 0], c[..., 1], c[..., 2]; luma = 0.299 * r + 0.587 * gg + 0.114 * b
        cb, cr = (b - luma) * 0.564, (r - luma) * 0.713
        st = lambda lo, hi, v: (lambda t: t * t * (3 - 2 * t))(np.clip((v - lo) / (hi - lo), 0, 1))
        amt = amount + teeth * st(120, 165, luma) * (1 - st(10, 20, np.sqrt(cb * cb + cr * cr))) * region
    return np.clip(np.round(c + amt[..., None] * (c - blur)), 0, 255).astype(np.uint8)
def mouth_weight(m, x, y, side):
    a = np.deg2rad(m["rotationDegrees"]); dx = x - m["centerX"] * side; dy = y - m["centerY"] * side
    al = dx * np.cos(a) + dy * np.sin(a); ac = -dx * np.sin(a) + dy * np.cos(a); rx, ry = m["radiusX"] * side, m["radiusY"] * side
    r = np.sqrt((al / rx) ** 2 + (ac / ry) ** 2); return np.clip(1 - (r - 1) * min(rx, ry) / (m["softness"] * side), 0, 1)
lp = P["lipPicture"]
metas = {m["frame"]: (i, m) for i, m in enumerate(R["metas"])}
S = 448; faces = np.memmap(f"{run_dir}/faces.bgr", np.uint8, "r").reshape(-1, S, S, 3)
import os
out = []
for name in sorted(os.listdir(f"{run_dir}/dump")):
    if not name.endswith(".window"): continue
    f = int(name.split(".")[0]); i, m = metas[f]; h = m["host"]
    window = np.fromfile(f"{run_dir}/dump/{f}.window", np.float32).reshape(1, 40, 1024)
    rgb = host_rgb(h); x0, y0, x1, y1 = P["hosts"]["boxes"][h]; side = x1 - x0
    box = rgb[y0:y1, x0:x1, ::-1].copy()
    fc = cv2.resize(box, (face, face), interpolation=cv2.INTER_AREA); b = (face - inner) // 2; inn = fc[b:b+inner, b:b+inner]
    img = np.concatenate([inn.transpose(2, 0, 1), inn.transpose(2, 0, 1)], 0).astype(np.float32) / 255
    img[3:, hole["y"]:hole["y"]+hole["height"], hole["x"]:hole["x"]+hole["width"]] = 0
    y = sess.run(None, {"image": img[None], "audio": window})[0][0]
    crop = np.clip(np.trunc(np.float32(y) * np.float32(255)), 0, 255).astype(np.uint8).transpose(1, 2, 0)
    rec = {"frame": f, "host": h, "raw": m["raw"], "blink": m["blink"]}
    if os.path.exists(f"{run_dir}/dump/{f}.crop"):
        web = np.fromfile(f"{run_dir}/dump/{f}.crop", np.uint8).reshape(output, output, 3)
        d = np.abs(web.astype(int) - crop.astype(int)); rec.update(crop_mae=round(float(d.mean()), 3), crop_max=int(d.max()), crop_p99=float(np.percentile(d, 99)))
    # Compose (AvatarCompositor): outer crop with the (sharpened) hole, Lanczos-4 to the box, matte or 8 px feather, mix.
    oc = cv2.resize(box, (outer, outer), interpolation=cv2.INTER_AREA)
    src = crop if not lp or (lp["sharpen"] == 0 and lp["teeth"] == 0) else sharpen(crop, lp["sharpen"], lp["teeth"],
        np.fromfunction(lambda yy, xx: mouth_weight(lp["mouth"], xx + .5, yy + .5, output), (output, output)) if lp["mouth"] else 1)
    px, py, pw, ph = hole["x"]*scale, hole["y"]*scale, hole["width"]*scale, hole["height"]*scale
    oc[py+margin:py+margin+ph, px+margin:px+margin+pw] = src[py:py+ph, px:px+pw]
    up = cv2.resize(oc, (side, side), interpolation=cv2.INTER_LANCZOS4).astype(np.float32)
    frame = rgb[..., ::-1].astype(np.float32).copy()
    yy, xx = np.mgrid[0:side, 0:side]; edge = np.minimum(np.minimum(xx + 1, side - xx), np.minimum(yy + 1, side - yy))
    if lp and lp["mouth"]:
        laid = np.zeros((outer, outer)); gy, gx = np.mgrid[py:py+ph, px:px+pw]; laid[gy+margin, gx+margin] = mouth_weight(lp["mouth"], gx, gy, output)
        alpha = cv2.resize(laid.astype(np.float32), (side, side), interpolation=cv2.INTER_LINEAR) * np.minimum(1, edge / 8)
        alpha = np.round(alpha * 255) / 255
    else: alpha = np.minimum(1, edge / 8).astype(np.float32)
    alpha = alpha * (1 - m["raw"])
    region = frame[y0:y1, x0:x1]
    frame[y0:y1, x0:x1] = np.clip(np.round(alpha[..., None] * up + (1 - alpha[..., None]) * region), 0, 255)
    if m["blink"] is not None:
        rx, ry, rw, rh = P["still"]["rect"]; pic = cv2.imread(pack_dir + "/" + P["still"]["blinks"][m["blink"]]).astype(np.float32)
        by, bx = np.mgrid[0:rh, 0:rw]; inset = np.minimum(np.minimum(bx + 1, rw - bx), np.minimum(by + 1, rh - by)); wgt = np.minimum(1, inset / 12)[..., None]
        frame[ry:ry+rh, rx:rx+rw] = np.clip(np.round(wgt * pic + (1 - wgt) * frame[ry:ry+rh, rx:rx+rw]), 0, 255)
    wx, wy = m["x"], m["y"]; ref = frame[wy:wy+S, wx:wx+S]; web = faces[i].astype(np.float32)
    d = np.abs(ref - web); mx0, mx1 = int(x0 + .2*side) - wx, int(x0 + .8*side) - wx; my0, my1 = int(y0 + .55*side) - wy, int(y0 + .95*side) - wy
    rec.update(window_mae=round(float(d.mean()), 3), mouth_mae=round(float(d[my0:my1, mx0:mx1].mean()), 3), window_max=int(d.max()))
    if len(sys.argv) > 4: np.save(f"{run_dir}/dump/{f}.pyref.npy", ref.astype(np.uint8))
    out.append(rec)
print(json.dumps({"pack": P["id"], "frames": out}))
