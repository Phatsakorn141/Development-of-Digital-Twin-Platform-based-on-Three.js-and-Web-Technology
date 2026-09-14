"""Does the classifier's verdict drift as the robot heats up over a long run?"""
import json, math, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
import numpy as np, scipy.stats as st, onnxruntime as ort, psycopg2

ROOT = r"D:\Development-of-Digital-Twin-Platform-based-on-Three.js-and-Web-Technology\Model_RF"
DSN  = "host=localhost port=5433 dbname=ur_anomaly user=ur_admin password=password"

CLASSES = json.load(open(f"{ROOT}/classes.json"))
SC = np.load(f"{ROOT}/scaler.npz"); MEAN, STD = SC["mean"], SC["std"]
SESS = ort.InferenceSession(f"{ROOT}/rf.onnx", providers=["CPUExecutionProvider"])
OUT = [o.name for o in SESS.get_outputs()][-1]


def probs_of(rows):
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
    return np.asarray(SESS.run([OUT], {"features": F})[0])[0]


conn = psycopg2.connect(DSN); cur = conn.cursor()
cur.execute("SELECT count(*) FROM telemetry WHERE run_id='long_run'")
n = cur.fetchone()[0]
print(f"long_run: {n} แถว = {n/125/60:.1f} นาที   สุ่มตรวจทุก ~2 นาที\n")

print(f"{'นาทีที่':>7}  {'J6 temp':>8}  {'ทำนาย':<22}{'conf':>6}   p(normal)")
print("-" * 70)

step = 125 * 120          # ทุก 2 นาที
counts = {}
for off in range(0, n - 125, step):
    cur.execute("""
        SELECT actual_q, actual_current, actual_tcp_pose,
               actual_tcp_speed, actual_tcp_force, joint_temperatures
        FROM telemetry WHERE run_id='long_run' ORDER BY time OFFSET %s LIMIT 125
    """, (off,))
    raw = cur.fetchall()
    if len(raw) < 125:
        break
    rows = [r[:5] for r in raw]
    temp = np.mean([r[5][5] for r in raw])
    p = probs_of(rows)
    k = int(p.argmax())
    lab = CLASSES[k]
    counts[lab] = counts.get(lab, 0) + 1
    pn = p[CLASSES.index("normal")]
    print(f"{off/125/60:>7.1f}  {temp:>8.2f}  {lab:<22}{p[k]:>6.2f}   {pn:.3f}")

print("-" * 70)
print("สรุปคำทำนายตลอด run (เฉลยคือ normal):")
for k, v in sorted(counts.items(), key=lambda kv: -kv[1]):
    print(f"   {k:<24}{v} ครั้ง")
conn.close()
