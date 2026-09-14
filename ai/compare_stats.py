"""เก็บข้อมูลจาก RTDE 1 ช่วง แล้วเทียบสถิติกับ scaler.npz ของเพื่อน"""
import math, time
import numpy as np
import rtde.rtde as rtde
import rtde.rtde_config as rtde_config

HOST    = "172.20.10.3"      # แก้ตาม IP ของ VM
PORT    = 30004
SECONDS = 60                 # เก็บ 1 นาที ให้ครอบคลุมหลายรอบ

NAMES = ["q0","q1","q2","q3","q4","q5","i0","i1","i2","i3","i4","i5",
         "tcp_x","tcp_y","tcp_z","tcp_speed_scalar","tcp_force_scalar",
         "fx","fy","fz","tx","ty","tz"]


def channels(s):
    """ประกอบ 23 channel ตามลำดับที่โมเดลต้องการ"""
    q = list(s.actual_q)
    q[5] = q[5] - 2 * math.pi        # ปรับรอบข้อมือให้ตรงกับข้อมูลฝึก (สำคัญมาก)
    i = list(s.actual_current)
    p = list(s.actual_TCP_pose)
    v = list(s.actual_TCP_speed)
    f = list(s.actual_TCP_force)
    tcp_spd = math.sqrt(v[0]**2 + v[1]**2 + v[2]**2)   # 3 แกนเชิงเส้นเท่านั้น
    tcp_frc = math.sqrt(sum(x*x for x in f))           # ทั้ง 6 แกน

    # ── ชดเชยความยาวเครื่องมือ ──
    # เพื่อนติด RG2 gripper และตั้ง TCP ไว้ที่ปลายนิ้ว ส่วนเราไม่มี gripper (TCP=0)
    # ค่า tcp_z ของเราจึงสูงกว่าเขา 0.261 m ตลอดเวลา
    # ลบตรงนี้แทนการตั้ง TCP ในหุ่น เพราะการตั้งจริงทำให้ waypoint เอื้อมไม่ถึง
    tcp_xyz = [p[0], p[1], p[2] - 0.261]

    return q + i + tcp_xyz + [tcp_spd, tcp_frc] + f


conf = rtde_config.ConfigFile("record_config.xml")
names, types = conf.get_recipe("out")
con = rtde.RTDE(HOST, PORT)
con.connect()
con.send_output_setup(names, types, frequency=125)
con.send_start()

print(f"เก็บ {SECONDS} วินาที (URSim ต้องกด Play เดินวนอยู่)...")
rows, t0 = [], time.time()
while time.time() - t0 < SECONDS:
    s = con.receive()
    if s is None:
        break
    rows.append(channels(s))
con.send_pause()
con.disconnect()

X = np.array(rows, dtype=np.float64)
d = np.load("../Model_RF_v2/scaler.npz")
fmean, fstd = d["mean"], d["std"]
omean = X.mean(0)

print(f"\nเก็บได้ {len(X)} จังหวะ ({len(X)/125:.1f} วินาที)\n")
print(f"{'channel':<18}{'ours':>10}{'friend':>10}{'gap(sd)':>10}")
print("-" * 48)
far = 0
for n, a, b, s_ in zip(NAMES, omean, fmean, fstd):
    z = abs(a - b) / s_ if s_ > 0 else 0.0
    if z >= 1:
        far += 1
    mark = "" if z < 1 else ("  <-- far" if z < 3 else "  <-- VERY FAR")
    print(f"{n:<18}{a:>10.3f}{b:>10.3f}{z:>10.2f}{mark}")
print(f"\nchannels beyond 1 sd: {far}/23")