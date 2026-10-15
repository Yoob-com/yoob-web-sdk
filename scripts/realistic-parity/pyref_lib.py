import subprocess, numpy as np
VT = np.array([[1.165439, -0.004124, 1.57445, -219.925007], [1.16252, -0.38975, -0.79723, 133.58311], [1.166452, 2.016199, -0.006857, -276.328849]])
def host_rgb(pack_dir, P, h):
    W, H = P["hosts"]["width"], P["hosts"]["height"]
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", f"{pack_dir}/hosts.mp4", "-vf", f"select=eq(n\\,{h})", "-vsync", "0", "-frames:v", "1",
                          "-f", "rawvideo", "-pix_fmt", "yuv420p", "-"], capture_output=True, check=True).stdout
    Y = np.frombuffer(raw[:W*H], np.uint8).reshape(H, W).astype(np.float64)
    def up(C):
        C = C.astype(np.float64); nx = np.concatenate([C[:, 1:], C[:, -1:]], 1)
        h_ = np.zeros((C.shape[0], W)); h_[:, 0::2] = C; h_[:, 1::2] = (C + nx) / 2
        ny = np.concatenate([h_[1:], h_[-1:]], 0); v = np.zeros((H, W)); v[0::2] = h_; v[1::2] = (h_ + ny) / 2; return v
    U = up(np.frombuffer(raw[W*H:W*H+W*H//4], np.uint8).reshape(H//2, W//2)); V = up(np.frombuffer(raw[W*H+W*H//4:], np.uint8).reshape(H//2, W//2))
    return np.clip(np.round(np.stack([VT[c, 0]*Y + VT[c, 1]*U + VT[c, 2]*V + VT[c, 3] for c in range(3)], -1)), 0, 255).astype(np.uint8)
