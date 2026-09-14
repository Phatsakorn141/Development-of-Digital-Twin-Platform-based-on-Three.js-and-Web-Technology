"""occlusion กับโมเดล 8 คลาสของเพื่อน (Model_RF_v2)"""
import json, math, sys, io, time
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
import numpy as np, scipy.stats as st, onnxruntime as ort, psycopg2

ROOT = r"D:\Development-of-Digital-Twin-Platform-based-on-Three.js-and-Web-Technology\Model_RF_v2"
DSN  = "host=localhost port=5433 dbname=ur_anomaly user=ur_admin password=password"
OUT_JSON = "occlusion_v2.json"

CLASSES = json.load(open(f"{ROOT}/classes.json"))
SC = np.load(f"{ROOT}/scaler.npz"); MEAN, STD = SC["mean"], SC["std"]
SESS = ort.InferenceSession(f"{ROOT}/rf.onnx", providers=["CPUExecutionProvider"])
OUT = [o.name for o in SESS.get_outputs()][-1]
print(f"{len(CLASSES)} คลาส: {CLASSES}\n")

CH = (["q0", "q1", "q2", "q3", "q4", "q5"]
    + ["i0", "i1", "i2", "i3", "i4", "i5"]
    + ["tcp_x", "tcp_y", "tcp_z", "tcp_speed", "tcp_force"]
    + ["fx", "fy", "fz", "tx", "ty", "tz"])
assert len(CH) == 23


def feats(win):
    X = ((np.asarray(win, dtype=np.float32) - MEAN) / STD)[None]
    m = X.mean(1); s = X.std(1); mx = X.max(1); mn = X.min(1)
    rms = np.sqrt((X ** 2).mean(1))
    sk = st.skew(X, axis=1, bias=False, nan_policy="omit")
    ku = st.kurtosis(X, axis=1, bias=False, nan_policy="omit")
    return np.nan_to_num(np.hstack([m, s, mx, mn, rms, sk, ku]).astype(np.float32))


def run_model(F):
    return np.asarray(SESS.run([OUT], {"features": F})[0])[0]


def build(rows):
    out = []
    for q, i, pose, v, f in rows:
        spd = math.sqrt(v[0]**2 + v[1]**2 + v[2]**2)
        frc = math.sqrt(sum(x * x for x in f))
        out.append(list(q) + list(i) + [pose[0], pose[1], pose[2]] + [spd, frc] + list(f))
    return out


# เลือก run ที่โมเดลทำได้ดี — วัด attribution ของคำตอบที่ผิดไม่มีความหมาย
# anomaly_type ใน DB ยังเป็น taxonomy เก่า จึงต้องระบุทั้งป้ายเดิมและแพทเทิร์นชื่อ run
PICK = {
    "friction":            ("friction",            "friction_band_%"),
    "normal":              ("normal",              "baseline_30hz_%"),
    "payload_heavy":       ("payload_heavy",       "payload_heavy_0%"),
    "payload_forced_drop": ("payload_forced_drop", "anomaly_payload_forced_drop_%"),
    "payload_heavy_drop":  ("payload_heavy_drop",  "payload_heavy_drop_%"),
    "gripper_low":         ("gripper_low",         "gripper_low_%"),
    "speed_30":            ("speed_30",            "speed_30_%"),
    "speed_100":           ("speed_100",           "speed_100_%"),
}

conn = psycopg2.connect(DSN); cur = conn.cursor()
heat, base_conf = {}, {}
t0 = time.time()

for cls, (atype, pat) in PICK.items():
    cur.execute("""
        SELECT e.run_id FROM experiment_runs e
        WHERE e.anomaly_type = %s AND e.run_id LIKE %s
          AND EXISTS (SELECT 1 FROM telemetry t WHERE t.run_id = e.run_id)
        ORDER BY e.run_id LIMIT 3
    """, (atype, pat))
    runs = [r[0] for r in cur.fetchall()]
    if not runs:
        print(f"ข้าม {cls}: ไม่พบ run ตาม {pat}")
        continue

    k = CLASSES.index(cls)
    acc = np.zeros(23); n = 0; bc = []

    for run_id in runs:
        cur.execute("SELECT count(*) FROM telemetry WHERE run_id=%s", (run_id,))
        total = cur.fetchone()[0]
        for frac in (0.3, 0.5, 0.7):
            cur.execute("""
                SELECT actual_q, actual_current, actual_tcp_pose,
                       actual_tcp_speed, actual_tcp_force
                FROM telemetry WHERE run_id=%s ORDER BY time OFFSET %s LIMIT 125
            """, (run_id, int(total * frac)))
            rows = cur.fetchall()
            if len(rows) < 125:
                continue
            F = feats(build(rows))
            p0 = run_model(F)[k]
            bc.append(float(p0))
            for c in range(23):
                G = F.copy()
                for s in range(7):
                    G[0, s * 23 + c] = 0.0
                acc[c] += p0 - run_model(G)[k]
            n += 1

    if n == 0:
        continue
    heat[cls] = (acc / n).tolist()
    base_conf[cls] = float(np.mean(bc))
    print(f"{cls:<22}{n} หน้าต่าง  ความมั่นใจฐาน {base_conf[cls]:.3f}  ({time.time()-t0:.0f}s)")

conn.close()
json.dump({"channels": CH, "classes": list(heat.keys()),
           "heat": heat, "base_conf": base_conf},
          open(OUT_JSON, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

FORCE = [16] + list(range(17, 23))
print(f"\n{'คลาส':<22}{'ฐาน':>7}{'แรง%':>7}   4 ช่องที่พึ่งมากสุด")
print("-" * 78)
for cls, v in heat.items():
    tot = sum(x for x in v if x > 0) or 1e-9
    fsh = sum(max(0, v[i]) for i in FORCE) / tot * 100
    top = sorted(range(23), key=lambda i: -v[i])[:4]
    print(f"{cls:<22}{base_conf[cls]:>7.2f}{fsh:>6.0f}%   "
          + "  ".join(f"{CH[i]}({v[i]:.2f})" for i in top))

print("\n--- ตารางสำหรับวางใน app.js ---")
for cls, v in heat.items():
    tot = sum(x for x in v if x > 0) or 1e-9
    fsh = round(sum(max(0, v[i]) for i in FORCE) / tot * 100)
    top = sorted(range(23), key=lambda i: -v[i])[:4]
    t = ", ".join(f"'{CH[i]}'" for i in top)
    print(f"    {cls + ':':<22}{{ top: [{t}],".ljust(70) + f"force: {fsh} }},")
