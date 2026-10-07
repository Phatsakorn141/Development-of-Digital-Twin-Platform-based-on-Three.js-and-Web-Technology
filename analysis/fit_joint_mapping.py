"""
fit_joint_mapping.py — หาค่า offset / invert ที่ทำให้โมเดล 3D ขยับตรงกับหุ่นจริงที่สุด

แทนที่จะนั่งลองเปิด-ปิด invert ทีละข้อ สคริปต์นี้จำลอง rig ใน ur3.glb ตามทุกชุดค่า
ที่เป็นไปได้ แล้วเทียบกับ actual_tcp_pose ที่หุ่นจริงรายงาน หลายเฟรม เลือกชุดที่ดีที่สุด

ทำตามที่ app.js ทำเป๊ะ:
    v = raw * scale  ;  if invert: v = -v  ;  v += offset
    node.rotation[axis] = baseEuler[axis] + v      (Euler แบบ XYZ ของ Three.js)

ต้องมี:  friend226 เปิดอยู่ · ur3.glb · ไฟล์ .dtwp ที่ระบุ property/nodeNames ไว้แล้ว
รัน:     python analysis\fit_joint_mapping.py
         python analysis\fit_joint_mapping.py --run speed_100_001 --frames 30
"""
import json, struct, sys, io, math, glob, os, argparse, itertools
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
import numpy as np
from scipy.optimize import minimize
import psycopg2

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
GLB = os.path.join(ROOT, "ur3.glb")
DSN = "host=localhost port=5433 dbname=ur_anomaly user=ur_admin password=password"

NAMES = ["1 Shoulder Pan", "2 Shoulder Lift", "3 Elbow",
         "4 Wrist 1", "5 Wrist 2", "6 Wrist 3"]


# ──────────────────────────── glTF ────────────────────────────
def load_glb(path):
    with open(path, "rb") as fh:
        fh.read(12)
        ln, _ = struct.unpack("<I4s", fh.read(8))
        g = json.loads(fh.read(ln).decode("utf-8"))
    nodes = g["nodes"]
    byname = {n.get("name"): i for i, n in enumerate(nodes)}
    parent = {}
    for i, n in enumerate(nodes):
        for c in n.get("children", []):
            parent[c] = i
    return nodes, byname, parent


def quat_to_R(q):
    x, y, z, w = q
    return np.array([
        [1-2*(y*y+z*z), 2*(x*y-z*w),   2*(x*z+y*w)],
        [2*(x*y+z*w),   1-2*(x*x+z*z), 2*(y*z-x*w)],
        [2*(x*z-y*w),   2*(y*z+x*w),   1-2*(x*x+y*y)]])


def R_to_euler_xyz(R):
    """ลำดับ XYZ ตาม Three.js"""
    sy = float(np.clip(R[0, 2], -1.0, 1.0))
    y = math.asin(sy)
    if abs(sy) < 0.99999:
        return [math.atan2(-R[1, 2], R[2, 2]), y, math.atan2(-R[0, 1], R[0, 0])]
    return [math.atan2(R[2, 1], R[1, 1]), y, 0.0]


def euler_xyz_to_R(e):
    cx, sx = math.cos(e[0]), math.sin(e[0])
    cy, sy = math.cos(e[1]), math.sin(e[1])
    cz, sz = math.cos(e[2]), math.sin(e[2])
    return (np.array([[1,0,0],[0,cx,-sx],[0,sx,cx]])
            @ np.array([[cy,0,sy],[0,1,0],[-sy,0,cy]])
            @ np.array([[cz,-sz,0],[sz,cz,0],[0,0,1]]))


class Rig:
    """จำลอง rig — เตรียม euler ตั้งต้นไว้ล่วงหน้าเพื่อไม่ต้องคำนวณซ้ำทุกรอบ"""

    def __init__(self, nodes, byname, parent, node_for_joint, axis_for_joint):
        self.nodes, self.byname, self.parent = nodes, byname, parent
        self.node_idx = [byname[n] for n in node_for_joint]
        self.axis = ["xyz".index(a) for a in axis_for_joint]
        self.base_euler = {}
        for i, n in enumerate(nodes):
            self.base_euler[i] = R_to_euler_xyz(quat_to_R(n.get("rotation", [0, 0, 0, 1])))
        self.chain_cache = {}

    def _chain(self, idx):
        if idx not in self.chain_cache:
            c, i = [], idx
            while i is not None:
                c.append(i)
                i = self.parent.get(i)
            self.chain_cache[idx] = list(reversed(c))
        return self.chain_cache[idx]

    def world(self, target_idx, angles):
        """angles = มุมที่จะบวกเข้ากับ euler ตั้งต้นของแต่ละข้อ (6 ค่า)"""
        add = {}
        for k, ni in enumerate(self.node_idx):
            add[ni] = (self.axis[k], angles[k])
        M = np.eye(4)
        for i in self._chain(target_idx):
            n = self.nodes[i]
            e = list(self.base_euler[i])
            if i in add:
                ax, val = add[i]
                e[ax] += val
            R = euler_xyz_to_R(e)
            s = np.array(n.get("scale", [1, 1, 1]), dtype=float)
            L = np.eye(4)
            L[:3, :3] = R @ np.diag(s)
            L[:3, 3] = np.array(n.get("translation", [0, 0, 0]), dtype=float)
            M = M @ L
        return M


def rotvec_to_R(rv):
    th = float(np.linalg.norm(rv))
    if th < 1e-12:
        return np.eye(3)
    k = np.asarray(rv) / th
    K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + math.sin(th) * K + (1 - math.cos(th)) * (K @ K)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default="payload_heavy_001")
    ap.add_argument("--frames", type=int, default=24, help="สุ่มกี่เฟรมมาใช้ฟิต")
    ap.add_argument("--dtwp", default="", help="ระบุไฟล์ .dtwp เอง (ปกติใช้ตัวล่าสุดใน Downloads)")
    ap.add_argument("--write", nargs="?", const="ur3_fitted.dtwp", default="",
                    help="เขียนผลเป็นไฟล์ .dtwp พร้อมเปิดใช้ ไม่ต้องกรอกเลขเอง")
    args = ap.parse_args()

    dtwp = args.dtwp or max(glob.glob(os.path.expanduser(r"~\Downloads\*.dtwp")),
                            key=os.path.getmtime)
    d = json.load(open(dtwp, encoding="utf-8"))
    jm = {j.get("name"): j for j in d["joints"]}
    print(f"rig      : {os.path.basename(GLB)}")
    print(f"mapping  : {os.path.basename(dtwp)}")

    node_for = [(jm[n].get("nodeNames") or [None])[0] for n in NAMES]
    axis_for = [jm[n].get("property", "rotation.y").split(".")[-1] for n in NAMES]
    print("ข้อ -> กระดูก/แกน : " + ", ".join(
        f"{n.split()[0]}:{nd}.{ax}" for n, nd, ax in zip(NAMES, node_for, axis_for)))

    nodes, byname, parent = load_glb(GLB)
    rig = Rig(nodes, byname, parent, node_for, axis_for)
    i_shoulder = byname["ShoulderBone"]
    i_tool = byname["ToolBone"]

    # ── ดึงเฟรมจากฐานข้อมูล ──
    conn = psycopg2.connect(DSN)
    cur = conn.cursor()
    cur.execute("SELECT count(*) FROM telemetry WHERE run_id=%s", (args.run,))
    total = cur.fetchone()[0]
    if not total:
        sys.exit(f"ไม่พบ run '{args.run}'")
    step = max(1, total // args.frames)
    cur.execute(f"""
        SELECT actual_q, actual_tcp_pose FROM (
            SELECT actual_q, actual_tcp_pose,
                   row_number() OVER (ORDER BY time) AS rn
            FROM telemetry WHERE run_id=%s) s
        WHERE rn %% {step} = 0 LIMIT %s
    """, (args.run, args.frames))
    frames = [([float(v) for v in q], [float(v) for v in p]) for q, p in cur.fetchall()]
    conn.close()
    print(f"ข้อมูล   : {args.run}  ใช้ {len(frames)} เฟรม จาก {total} แถว\n")

    # ── เป้าหมาย: หน้าแปลนของ UR3 จริง เทียบกับข้อไหล่ ──
    # ToolBone ในโมเดลอยู่ตำแหน่งหน้าแปลน ไม่ใช่ TCP (ซึ่งเยื้องไปตามความยาว gripper)
    # จึงเทียบกับ FK ของ UR3 ที่คำนวณถึงหน้าแปลนพอดี
    SCALE = 11.12
    A = [0.0, -0.24365, -0.21325, 0.0, 0.0, 0.0]
    D = [0.15190, 0.0, 0.0, 0.11235, 0.08535, 0.08190]
    ALPHA = [math.pi/2, 0.0, 0.0, math.pi/2, -math.pi/2, 0.0]

    def ur3_flange(q):
        T = np.eye(4)
        for i in range(6):
            ct, st = math.cos(q[i]), math.sin(q[i])
            ca, sa = math.cos(ALPHA[i]), math.sin(ALPHA[i])
            T = T @ np.array([
                [ct, -st*ca,  st*sa, A[i]*ct],
                [st,  ct*ca, -ct*sa, A[i]*st],
                [0.0,    sa,     ca,    D[i]],
                [0.0,   0.0,    0.0,     1.0]])
        return T

    # หุ่นใช้ Z ขึ้น ; โมเดลใช้ Y ขึ้น → (xr, yr, zr) -> (xr, zr, -yr)
    to_model = lambda v: np.array([v[0], v[2], -v[1]])

    targets = []
    for q, pose in frames:
        T = ur3_flange(q)
        p_rel = T[:3, 3] - np.array([0.0, 0.0, D[0]])   # เทียบข้อไหล่
        targets.append((q, to_model(T[:3, 2]), to_model(p_rel)))

    def simulate(params, signs):
        """คืน (ทิศเครื่องมือ, ตำแหน่งเทียบไหล่ หน่วยเมตร) ของทุกเฟรม"""
        out = []
        for q, _, _ in targets:
            ang = [q[k] * signs[k] + params[k] for k in range(6)]
            base = rig.world(i_shoulder, ang)[:3, 3]
            M = rig.world(i_tool, ang)
            tip = (M[:3, 3] - base) / SCALE
            ydir = M[:3, 1] / (np.linalg.norm(M[:3, 1]) or 1)
            out.append((ydir, tip))
        return out

    def cost(params, signs):
        """ทิศเครื่องมือ + ตำแหน่งสามมิติเต็ม — ตำแหน่งเต็มเป็นตัวบังคับทิศหันและความสูง
        ถ้าใช้แค่ระยะแนวราบ คำตอบจะไม่ยูนีค (เจอมาแล้ว ได้ 5 ชุด cost เท่ากัน)"""
        c = 0.0
        for (q, tdir, pos), (ydir, tip) in zip(targets, simulate(params, signs)):
            c += float(np.sum((ydir - tdir) ** 2)) * 3.0    # ทิศ สำคัญสุด
            c += float(np.sum((tip - pos) ** 2)) * 10.0     # ตำแหน่ง 3 มิติ (เมตร)
        return c / len(targets)

    print("กำลังค้นหา 64 ชุด invert ...")
    results = []
    start = [float(jm[n].get("offset", 0)) for n in NAMES]
    for combo in itertools.product([1, -1], repeat=6):
        r = minimize(cost, start, args=(combo,), method="Powell",
                     options={"maxiter": 4000, "xtol": 1e-3, "ftol": 1e-3})
        results.append((r.fun, combo, r.x))
    results.sort(key=lambda t: t[0])

    print(f"\n{'อันดับ':<7}{'cost':>9}   invert (1=ปิด, -1=เปิด)        offset (rad)")
    print("-" * 92)
    for rank, (c, combo, x) in enumerate(results[:5], 1):
        iv = " ".join("เปิด" if s < 0 else " ปิด " for s in combo)
        off = " ".join(f"{v:+6.3f}" for v in x)
        print(f"{rank:<7}{c:>9.5f}   {iv}   {off}")

    best_c, best_combo, best_x = results[0]
    print(f"\n{'='*92}\nชุดที่ดีที่สุด\n{'='*92}")
    print(f"{'ข้อ':<18}{'property':<12}{'invert':>8}{'offset':>10}")
    print("-" * 50)
    for k, n in enumerate(NAMES):
        print(f"{n:<18}{'rotation.'+axis_for[k]:<12}"
              f"{'เปิด' if best_combo[k] < 0 else 'ปิด':>8}{best_x[k]:>10.3f}")

    sim = simulate(best_x, best_combo)
    derr = np.mean([float(np.linalg.norm(y - t)) for (_, t, _), (y, _) in zip(targets, sim)])
    herr = np.mean([abs(math.hypot(tp[0], tp[2]) - math.hypot(p[0], p[2]))
                    for (_, _, p), (_, tp) in zip(targets, sim)])
    print(f"\nคลาดเคลื่อนเฉลี่ย  ทิศเครื่องมือ {math.degrees(derr):.1f}°   "
          f"ระยะแนวราบ {herr*1000:.0f} มม.")
    # ── เขียนผลกลับเป็นไฟล์ — ตอบคำถามอาจารย์ข้อ 1 ──
    # ไม่ต้องจดเลขไปกรอกใน Edit Joint เอง ได้ไฟล์ .dtwp ที่เว็บโหลดได้ทันที
    if args.write:
        from datetime import datetime, timezone
        out = args.write if os.path.isabs(args.write) else os.path.join(ROOT, args.write)
        for k, n in enumerate(NAMES):
            # ข้อ 6 หมุนรอบแกนตัวเอง ตำแหน่งกับทิศแกน Y ของ ToolBone ไม่เปลี่ยนตาม
            # สคริปต์จึงหาค่าข้อนี้ไม่ได้ (ได้ค่ามั่วทุกครั้ง) — คงค่าเดิมจากไฟล์ต้นทางไว้
            if k == 5:
                continue
            j = jm[n]                      # dict เดียวกับใน d["joints"] แก้ตรงนี้ = แก้ในไฟล์
            j["offset"]   = round(float(best_x[k]), 3)
            j["invert"]   = bool(best_combo[k] < 0)
            j["property"] = "rotation." + axis_for[k]
        d["exportedAt"] = datetime.now(timezone.utc).isoformat()
        with open(out, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=2)
        print(f"\nเขียนแล้ว : {out}   (ข้อ 6 คงค่าเดิมจาก {os.path.basename(dtwp)})")
    else:
        print("\nเอาค่า invert/offset ข้างบนไปใส่ใน Edit Joint ของแต่ละข้อ (ยกเว้นข้อ 6)")
        print("หรือรันซ้ำพร้อม --write เพื่อให้เขียนไฟล์ .dtwp ให้เลย")


if __name__ == "__main__":
    main()
