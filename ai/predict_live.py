"""เก็บ 1 วินาที (125 จังหวะ) แล้วรันโมเดลของเพื่อนทำนาย"""
import json, math
import numpy as np
import scipy.stats as st
import onnxruntime as ort
import rtde.rtde as rtde
import rtde.rtde_config as rtde_config

HOST   = "172.20.10.3"      # แก้ตาม IP ของ VM
PORT   = 30004
WINDOW = 125                # ตามที่โมเดลกำหนด (1 วินาที @ 125 Hz)
MODEL  = "../Model_RF_v2"   # 8 คลาส — ตัวเก่า 9 คลาสอยู่ที่ ../Model_RF

CLASSES   = json.load(open(f"{MODEL}/classes.json"))
SC        = np.load(f"{MODEL}/scaler.npz")
MEAN, STD = SC["mean"], SC["std"]
SESS      = ort.InferenceSession(f"{MODEL}/rf.onnx", providers=["CPUExecutionProvider"])
OUT       = [o.name for o in SESS.get_outputs()][-1]


def channels(s):
    """ประกอบ 23 channel ตามลำดับที่ README กำหนด"""
    q = list(s.actual_q)
    q[5] -= 2 * math.pi                      # ปรับรอบข้อมือ
    i = list(s.actual_current)
    p = list(s.actual_TCP_pose)
    v = list(s.actual_TCP_speed)
    f = list(s.actual_TCP_force)
    tcp_spd = math.sqrt(v[0]**2 + v[1]**2 + v[2]**2)   # 3 แกนเชิงเส้น
    tcp_frc = math.sqrt(sum(x * x for x in f))         # ทั้ง 6 แกน
    return q + i + [p[0], p[1], p[2] - 0.261] + [tcp_spd, tcp_frc] + f


def features(win):
    """(125,23) -> (1,161) — สูตรเดียวกับ predict_example_rf.py ของเพื่อนเป๊ะ"""
    X = ((np.asarray(win, dtype=np.float32) - MEAN) / STD)[None]
    m  = X.mean(1); s = X.std(1); mx = X.max(1); mn = X.min(1)
    rms = np.sqrt((X ** 2).mean(1))
    sk = st.skew(X, axis=1, bias=False, nan_policy="omit")
    ku = st.kurtosis(X, axis=1, bias=False, nan_policy="omit")
    return np.nan_to_num(np.hstack([m, s, mx, mn, rms, sk, ku]).astype(np.float32))


conf = rtde_config.ConfigFile("record_config.xml")
names, types = conf.get_recipe("out")
con = rtde.RTDE(HOST, PORT)
con.connect()
con.send_output_setup(names, types, frequency=125)
con.send_start()

print("collecting 125 samples (1 second)...")
win = []
while len(win) < WINDOW:
    s = con.receive()
    if s is None:
        break
    win.append(channels(s))
con.send_pause()
con.disconnect()

probs = np.asarray(SESS.run([OUT], {"features": features(win)})[0])[0]
order = np.argsort(probs)[::-1]

print(f"\nPREDICTION: {CLASSES[order[0]]}   ({probs[order[0]]:.3f})\n")
for k in order:
    print(f"  {CLASSES[k]:<22}{probs[k]:.4f}  {'#' * int(probs[k] * 40)}")