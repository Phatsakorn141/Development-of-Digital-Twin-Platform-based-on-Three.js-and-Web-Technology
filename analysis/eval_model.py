"""ประเมินโมเดล 8 คลาสของเพื่อน บนข้อมูลจริงใน friend226 — เทียบกับตัวเก่า 9 คลาส"""
import json, math, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
import numpy as np, scipy.stats as st, onnxruntime as ort, psycopg2
from collections import defaultdict

NEW = r"C:\Users\palm\Downloads\web_digitaltwin\web_digitaltwin\models"
DSN = "host=localhost port=5433 dbname=ur_anomaly user=ur_admin password=password"

CLASSES = json.load(open(f"{NEW}/classes.json"))
SC = np.load(f"{NEW}/scaler.npz"); MEAN, STD = SC["mean"], SC["std"]
SESS = ort.InferenceSession(f"{NEW}/rf.onnx", providers=["CPUExecutionProvider"])
OUT = [o.name for o in SESS.get_outputs()][-1]
print(f"โมเดล {len(CLASSES)} คลาส: {CLASSES}\n")

# ── taxonomy ใหม่: payload_normal ถูกยุบเข้า normal ──
REMAP = {"payload_normal": "normal"}


def predict(rows):
    win = []
    for q, i, pose, v, f in rows:
        spd = math.sqrt(v[0]**2 + v[1]**2 + v[2]**2)
        frc = math.sqrt(sum(x * x for x in f))
        win.append(list(q) + list(i) + [pose[0], pose[1], pose[2]] + [spd, frc] + list(f))
    X = ((np.asarray(win, dtype=np.float32) - MEAN) / STD)[None]
    m = X.mean(1); s = X.std(1); mx = X.max(1); mn = X.min(1)
    rms = np.sqrt((X ** 2).mean(1))
    sk = st.skew(X, axis=1, bias=False, nan_policy="omit")
    ku = st.kurtosis(X, axis=1, bias=False, nan_policy="omit")
    F = np.nan_to_num(np.hstack([m, s, mx, mn, rms, sk, ku]).astype(np.float32))
    p = np.asarray(SESS.run([OUT], {"features": F})[0])[0]
    k = int(p.argmax())
    return CLASSES[k], float(p[k])


conn = psycopg2.connect(DSN); cur = conn.cursor()
cur.execute("""
    SELECT e.run_id, e.anomaly_type FROM experiment_runs e
    WHERE EXISTS (SELECT 1 FROM telemetry t WHERE t.run_id = e.run_id)
    ORDER BY e.run_id
""")
runs = cur.fetchall()

stat = defaultdict(lambda: [0, 0])
conf_mat = defaultdict(lambda: defaultdict(int))
skipped = set()

for run_id, atype in runs:
    truth = REMAP.get(atype, atype)
    if truth not in CLASSES:
        skipped.add(atype)
        continue
    cur.execute("SELECT count(*) FROM telemetry WHERE run_id=%s", (run_id,))
    n = cur.fetchone()[0]
    if n < 2000:
        continue
    variant = run_id.rsplit("_", 1)[0]
    for frac in (0.25, 0.45, 0.65):
        cur.execute("""
            SELECT actual_q, actual_current, actual_tcp_pose,
                   actual_tcp_speed, actual_tcp_force
            FROM telemetry WHERE run_id=%s ORDER BY time OFFSET %s LIMIT 125
        """, (run_id, int(n * frac)))
        rows = cur.fetchall()
        if len(rows) < 125:
            continue
        lab, _ = predict(rows)
        stat[(truth, variant)][1] += 1
        stat[(truth, variant)][0] += (lab == truth)
        conf_mat[truth][lab] += 1

print(f"{'ป้ายใหม่':<22}{'run prefix':<30}{'ความแม่น':>12}")
print("-" * 66)
th = tn = 0
for (truth, variant), (h, n) in sorted(stat.items()):
    print(f"{truth:<22}{variant:<30}{h}/{n:<5}{h/n*100:5.0f}%")
    th += h; tn += n
print("-" * 66)
print(f"{'รวม':<52}{th}/{tn}  {th/tn*100:.1f}%")

if skipped:
    print(f"\nข้ามคลาสที่โมเดลใหม่ไม่รู้จัก: {sorted(skipped)}")

print("\nทายผิดไปเป็นอะไร (แถว=เฉลย)")
for a in sorted(conf_mat):
    top = sorted(conf_mat[a].items(), key=lambda kv: -kv[1])[:4]
    print(f"  {a:<22}" + "  ".join(f"{k}:{v}" for k, v in top))
conn.close()
