"""The app-path sequences (head path hosts, speech blinks, silence mix, seal) of a web offline run against an iOS probe
report of the same pack, audio and settings (AvatarModelProbe --stream, 20 ms packets, instant lips)."""
import json, sys
r = json.load(open(sys.argv[1])); w = json.load(open(sys.argv[2]))
m = sorted(w["metas"], key=lambda x: x["frame"]); n = min(len(m), len(r["hosts"]))
eq = lambda k, rk, tol=0: sum(1 for i in range(n) if (abs(m[i][k] - r[rk][i]) <= tol if isinstance(r[rk][i], (int, float)) and m[i][k] is not None else m[i][k] == r[rk][i]))
print(json.dumps({"frames": n, "hosts": eq("host", "hosts"), "blinks": eq("blink", "blinks"), "raw": eq("raw", "raw", 1e-6),
                  "seal": eq("seal", "seal", 1e-6) if "seal" in m[0] else None}))
