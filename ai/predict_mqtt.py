"""
predict_mqtt.py — ฟัง MQTT ทำนายความผิดปกติ และสรุปผลสะสมเป็นช่วงเหตุการณ์

ปัญหาของการดูทีละหน้าต่าง: โมเดลทายผิดแบบสุ่มราว 30% บน run ปกติ
ถ้ารายงานทุกครั้งที่ทาย จะเตือนผิดนับหมื่นครั้งใน 2 ชั่วโมง

วิธีแก้: โหวตจากหลายหน้าต่างติดกัน แล้วรายงานเป็น "ช่วงเหตุการณ์" (episode)
ความผิดพลาดแบบสุ่มจะถูกเสียงข้างมากกลบ เหลือเฉพาะของจริงที่อยู่นานพอ

ติดตั้ง:  pip install paho-mqtt onnxruntime numpy scipy
รัน:
    python predict_mqtt.py                      ไม่จำกัดเวลา Ctrl+C เพื่อสรุป
    python predict_mqtt.py --minutes 120        รัน 2 ชั่วโมงแล้วสรุปอัตโนมัติ
    python predict_mqtt.py --minutes 10 --report 60
    python predict_mqtt.py --vote 25 --min-sec 5
"""
# ไลบรารีมาตรฐาน: argparse อ่าน argument · json แปลง payload · math ค่า π · time จับเวลา · sys
import argparse, json, math, time, sys
# deque = คิวความยาวจำกัด (หน้าต่างเลื่อน) · Counter = นับ · defaultdict = dict มีค่าเริ่มต้น
from collections import deque, Counter, defaultdict

# numpy คำนวณเป็นก้อนเมทริกซ์ · scipy.stats หา skew/kurtosis
import numpy as np
import scipy.stats as st
# onnxruntime รันโมเดลที่ export เป็น .onnx (ไม่ต้องติดตั้ง scikit-learn)
import onnxruntime as ort
# paho-mqtt ต่อ broker Mosquitto
import paho.mqtt.client as mqtt

# ── ค่าทั้งหมดมาจาก config/params.json (อ่านผ่าน params.py) ──
# WINDOW = hz × window_sec = 125 แถว · STRIDE = hz ÷ predict_per_sec = 25 แถว — คำนวณใน params.py
# เปลี่ยนชื่อ topic ให้สั้นลง: TOPIC_IN รับข้อมูล · TOPIC_OUT ส่งผลทาย · TOPIC_SESS ส่งสรุป
from params import (BROKER, PORT, WINDOW, STRIDE, MODEL, VOTE, MIN_EPISODE_SEC, REPORT_SEC,
                    TOPIC_TELEMETRY as TOPIC_IN, TOPIC_PREDICTION as TOPIC_OUT,
                    TOPIC_SESSION as TOPIC_SESS)

# ── โหลดโมเดลครั้งเดียวตอนเริ่ม ──
#   classes.json  ชื่อคลาสเรียงตามลำดับ output ของโมเดล
#   scaler.npz    mean/std ของชุดเทรน — ต้อง normalize แบบเดียวกันเป๊ะ
#   rf.onnx       Random Forest ที่ export เป็น ONNX (รันเร็ว ไม่ต้องมี sklearn)
# รายชื่อคลาส เช่น ["friction", "normal", "payload_heavy", ...] — ลำดับตรงกับ output
CLASSES   = json.load(open(f"{MODEL}/classes.json"))
# ค่า mean/std ของแต่ละช่อง (23 ช่อง) ที่ใช้ตอนเทรน
SC        = np.load(f"{MODEL}/scaler.npz")
MEAN, STD = SC["mean"], SC["std"]
# เปิดโมเดล ONNX รันบน CPU
SESS      = ort.InferenceSession(f"{MODEL}/rf.onnx", providers=["CPUExecutionProvider"])
# output ตัวสุดท้ายของ ONNX = ความน่าจะเป็นของแต่ละคลาส
OUT       = [o.name for o in SESS.get_outputs()][-1]


# ── channels — แปลง payload 1 แถว (1/125 วินาที) เป็นตัวเลข 23 ช่อง ──
def channels(p, fix_ursim):
    """
    ประกอบ 23 ช่องตามลำดับที่โมเดลเพื่อนต้องการ

    fix_ursim=True  → ข้อมูลสดจาก URSim ต้องปรับ 2 จุดให้ตรง convention ของเพื่อน
    fix_ursim=False → ข้อมูล replay จาก DB เพื่อนอยู่ใน convention นั้นอยู่แล้ว
    """
    # มุมข้อต่อ 6 ข้อ (rad) — list() เพื่อคัดลอก จะได้แก้ค่าโดยไม่กระทบ payload ต้นฉบับ
    q    = list(p["actual_q"])
    # ตำแหน่ง/ท่าปลายแขน [x, y, z, rx, ry, rz] (เมตร, rad)
    pose = list(p["actual_tcp_pose"])
    # URSim นับมุม J6 เกินไป 1 รอบ (2π) และวัดความสูง TCP ต่างจากหุ่นเพื่อน 0.261 ม.
    if fix_ursim:
        # ลบ 1 รอบออกจากมุม J6
        q[5] -= 2 * math.pi
        # ลดความสูง z ของปลายแขนให้ตรงกับหุ่นเพื่อน
        pose[2] -= 0.261

    # กระแสมอเตอร์ 6 ข้อ (A)
    i = list(p["actual_current"])
    # ความเร็วปลายแขน [vx, vy, vz, wx, wy, wz]
    v = list(p["actual_tcp_speed"])
    # แรง/แรงบิดที่ปลายแขน [fx, fy, fz, tx, ty, tz]
    f = list(p["actual_tcp_force"])

    # ความเร็ว/แรงรวมของปลายแขน = ขนาดของเวกเตอร์ (ความเร็วใช้แค่ xyz)
    # ความเร็วรวม = √(vx² + vy² + vz²)
    tcp_spd = math.sqrt(v[0]**2 + v[1]**2 + v[2]**2)
    # แรงรวม = √(ผลรวมกำลังสองของทั้ง 6 ค่า)
    tcp_frc = math.sqrt(sum(x * x for x in f))
    # 6 มุม + 6 กระแส + ตำแหน่ง xyz + ความเร็ว + แรงรวม + แรง/แรงบิด 6 แกน = 23 ช่อง
    return q + i + [pose[0], pose[1], pose[2]] + [tcp_spd, tcp_frc] + f


# ── features — แปลงหน้าต่าง 125 แถว × 23 ช่อง เป็นฟีเจอร์ 161 ตัวที่โมเดลรับ ──
def features(win):
    """(125,23) → (1,161) — สูตรเดียวกับ predict_live.py เป๊ะ ห้ามต่างแม้แต่นิดเดียว"""
    # normalize ด้วย mean/std ชุดเทรน แล้วเพิ่มมิติ batch → (1, 125, 23)
    X = ((np.asarray(win, dtype=np.float32) - MEAN) / STD)[None]
    # สถิติ 7 ตัวต่อช่อง (เฉลี่ย · ส่วนเบี่ยงเบน · สูงสุด · ต่ำสุด · RMS · ความเบ้ · ความโด่ง) × 23 = 161
    # axis 1 = แกนเวลา → ได้ค่าละ 23 ตัวต่อสถิติ
    m  = X.mean(1); s = X.std(1); mx = X.max(1); mn = X.min(1)
    # RMS = รากของค่าเฉลี่ยกำลังสอง (บอกความแรงของสัญญาณ)
    rms = np.sqrt((X ** 2).mean(1))
    # ความเบ้ (skewness) — การกระจายเอียงไปทางไหน
    sk = st.skew(X, axis=1, bias=False, nan_policy="omit")
    # ความโด่ง (kurtosis) — มีค่าพุ่งแหลมผิดปกติมากแค่ไหน
    ku = st.kurtosis(X, axis=1, bias=False, nan_policy="omit")
    # ช่องที่นิ่งสนิท (std = 0) ทำให้ skew/kurtosis เป็น NaN → แทนด้วย 0
    # ต่อ 7 ชุดเรียงกัน → (1, 161) ชนิด float32 ตามที่โมเดลต้องการ
    return np.nan_to_num(np.hstack([m, s, mx, mn, rms, sk, ku]).astype(np.float32))


# ── Session — เก็บคำทายทั้งหมดของการรันครั้งนี้ แล้วสรุปเป็นช่วงเหตุการณ์ ──
class Session:
    """สะสมคำทำนาย โหวตให้เรียบ แล้วรวบเป็นช่วงเหตุการณ์"""

    # สร้างตัวเก็บค่าเปล่า
    def __init__(self, vote, min_sec):
        self.vote    = deque(maxlen=vote)   # คำทำนายดิบล่าสุด ใช้โหวต
        self.min_sec = min_sec              # ช่วงที่สั้นกว่านี้ถือเป็นสัญญาณรบกวน ทิ้ง
        self.t0      = time.time()          # เวลาเริ่ม ใช้บอกว่ารันมากี่นาที
        self.raw     = Counter()            # นับคำทำนายดิบ
        self.raw_flips = 0                  # คำทำนายดิบเปลี่ยนกี่ครั้ง
        self.last_raw  = None               # คำทายดิบครั้งก่อน ใช้นับการเปลี่ยน
        self.episodes  = []                 # ช่วงที่ปิดแล้ว
        self.cur       = None               # ช่วงที่กำลังเปิดอยู่
        self.n         = 0                  # จำนวนคำทายทั้งหมด

    def add(self, label, conf):
        """ใส่คำทำนาย 1 ครั้ง คืนป้ายที่ผ่านการโหวตแล้ว (None ถ้ายังโหวตไม่ได้)"""
        # นับสถิติดิบ (ก่อนโหวต) ไว้ใช้ในรายงาน
        self.n += 1
        self.raw[label] += 1
        # คำทายดิบเปลี่ยนจากครั้งก่อน = นับเป็น 1 ครั้งที่ "กระพริบ"
        if self.last_raw is not None and label != self.last_raw:
            self.raw_flips += 1
        self.last_raw = label

        # โหวตเสียงข้างมากจาก N คำทำนายล่าสุด — ยังไม่ครบ N ยังไม่ตัดสิน
        self.vote.append(label)
        if len(self.vote) < self.vote.maxlen:
            return None
        # ป้ายที่ซ้ำมากสุดใน N ครั้งล่าสุด = ผลหลังโหวต
        smooth = Counter(self.vote).most_common(1)[0][0]

        # ป้ายหลังโหวตเหมือนเดิม = ต่อช่วงเดิม · เปลี่ยน = ปิดช่วงเก่าแล้วเปิดช่วงใหม่
        now = time.time()
        if self.cur is None:
            # ยังไม่มีช่วงเปิด → เปิดช่วงแรก
            self.cur = {"label": smooth, "start": now, "end": now, "n": 1, "conf": [conf]}
        elif smooth == self.cur["label"]:
            # ป้ายเดิม → ขยายเวลาจบของช่วง เก็บความมั่นใจไว้หาค่าเฉลี่ย
            self.cur["end"] = now
            self.cur["n"] += 1
            self.cur["conf"].append(conf)
        else:
            # ป้ายเปลี่ยน → ปิดช่วงเก่า เปิดช่วงใหม่
            self._close()
            self.cur = {"label": smooth, "start": now, "end": now, "n": 1, "conf": [conf]}
        return smooth

    # ── ปิดช่วงที่เปิดอยู่: คิดความยาวกับความมั่นใจเฉลี่ย แล้วย้ายเข้า episodes ──
    def _close(self):
        e = self.cur
        if e is None:
            return
        # ความยาวช่วง (วินาที)
        e["dur"] = e["end"] - e["start"]
        # แทนรายการความมั่นใจด้วยค่าเฉลี่ย
        e["conf"] = float(np.mean(e["conf"])) if e["conf"] else 0.0
        self.episodes.append(e)
        self.cur = None

    def snapshot(self):
        """ช่วงทั้งหมดรวมช่วงที่ยังเปิดอยู่ กรองตัวที่สั้นเกินออก"""
        # คัดลอกรายการ ไม่แก้ของจริง
        eps = list(self.episodes)
        # ช่วงที่ยังเปิดอยู่ คิดค่าแบบชั่วคราว (ไม่ปิดจริง)
        if self.cur:
            e = dict(self.cur)
            e["dur"] = e["end"] - e["start"]
            e["conf"] = float(np.mean(e["conf"])) if e["conf"] else 0.0
            eps.append(e)
        # ทิ้งช่วงที่สั้นกว่า min_sec — ถือเป็นสัญญาณรบกวน
        return [e for e in eps if e["dur"] >= self.min_sec]

    # ── report — พิมพ์ตารางสรุปช่วงเหตุการณ์ และคืน dict เดียวกัน ──
    # dict นี้ส่งขึ้น ur/session ให้หน้าเว็บ และบันทึกเป็น JSON ตอน --save
    def report(self, final=False):
        # el = เวลาที่รันมาแล้ว (วินาที)
        el = time.time() - self.t0
        eps = self.snapshot()
        # รวมต่อป้าย: กี่ช่วง และรวมกี่วินาที
        by = defaultdict(lambda: {"n": 0, "sec": 0.0})
        for e in eps:
            by[e["label"]]["n"] += 1
            by[e["label"]]["sec"] += e["dur"]
        # เวลารวมทุกช่วง ใช้คิดสัดส่วน (or 1e-9 กันหารศูนย์)
        covered = sum(v["sec"] for v in by.values()) or 1e-9

        # หัวตาราง
        bar = "=" * 66
        print(f"\n{bar}")
        print(f"สรุป{'ท้ายสุด' if final else 'ระหว่างทาง'}  "
              f"เดินมา {el/60:.1f} นาที  ทำนายไป {self.n} ครั้ง")
        print(bar)

        if not eps:
            print("ยังไม่มีช่วงเหตุการณ์ที่ยาวพอ — ลด --min-sec หรือรอนานกว่านี้")
        else:
            # ตาราง: ป้าย · จำนวนช่วง · เวลารวม (นาที) · % ของเวลาทั้งหมด — เรียงจากนานสุด
            print(f"{'สถานะ':<22}{'ครั้ง':>6}{'รวมเวลา':>12}{'สัดส่วน':>10}")
            print("-" * 66)
            for lab, v in sorted(by.items(), key=lambda kv: -kv[1]["sec"]):
                # ป้ายที่ไม่ใช่ normal ติด ⚠
                flag = "  " if lab == "normal" else " ⚠"
                print(f"{lab:<22}{v['n']:>6}{v['sec']/60:>10.1f} น{v['sec']/covered*100:>9.0f}%{flag}")

            # ไล่รายการช่วงที่ผิดปกติทีละช่วง พร้อมเวลาเริ่ม ความยาว ความมั่นใจ
            bad = [e for e in eps if e["label"] != "normal"]
            if bad:
                print(f"\nช่วงที่ผิดปกติ {len(bad)} ช่วง")
                print("-" * 66)
                for e in bad:
                    t = time.strftime("%H:%M:%S", time.localtime(e["start"]))
                    print(f"  {t}  {e['label']:<22}นาน {e['dur']:>6.1f} วิ  "
                          f"มั่นใจ {e['conf']:.2f}")
            else:
                print("\nไม่พบช่วงผิดปกติเลย")

        # ตัวเลขที่บอกว่าการโหวตช่วยได้แค่ไหน — เอาไปเขียนรายงานได้
        print(f"\nคำทำนายดิบเปลี่ยนไปมา {self.raw_flips} ครั้ง  "
              f"→  หลังโหวตเหลือ {len(eps)} ช่วง")
        if self.raw_flips:
            # % ที่การโหวตลดการกระพริบลง
            print(f"ลดสัญญาณรบกวนลง {(1 - len(eps)/self.raw_flips)*100:.1f}%")
        # 4 ป้ายที่ทายดิบบ่อยสุด เป็น %
        print(f"สัดส่วนคำทำนายดิบ: "
              + "  ".join(f"{k} {v/self.n*100:.0f}%"
                          for k, v in self.raw.most_common(4)))
        print(bar + "\n")

        # ค่าเดียวกับที่พิมพ์ ในรูป dict (แปลงเป็น JSON ได้)
        return {"elapsed_sec": el, "n": self.n, "raw_flips": self.raw_flips,
                "episodes": [{"label": e["label"], "start": e["start"],
                              "dur": e["dur"], "conf": e["conf"]} for e in eps],
                "by_label": {k: v for k, v in by.items()}}


# ── Predictor — หน้าต่างเลื่อน 125 แถว (1 วิ) ทำนายทุกครั้งที่มีแถวใหม่ครบ 25 แถว (5 ครั้ง/วิ) ──
class Predictor:
    def __init__(self, force_fix):
        # หน้าต่างเลื่อน: แถวใหม่เข้า แถวเก่าสุดหลุดออกเอง
        self.win       = deque(maxlen=WINDOW)
        # นับแถวใหม่ตั้งแต่ทายครั้งก่อน
        self.since     = 0
        # True/False = บังคับโหมด URSim/replay · None = ดูจาก payload
        self.force_fix = force_fix
        # hits/total = ทายถูก/ทั้งหมด (เทียบเฉลย) · skipped = แถวที่ข้อมูลไม่ครบ
        self.hits = self.total = self.skipped = 0

    # ป้อน 1 payload → คืนผลทาย (ถ้าถึงรอบทาย) หรือ None
    def feed(self, p):
        # ไม่บังคับโหมด → ดูจาก payload: ข้อมูล replay มีป้าย replay=True ไม่ต้องแก้แบบ URSim
        fix = self.force_fix if self.force_fix is not None else not p.get("replay")
        try:
            self.win.append(channels(p, fix))
        except (KeyError, TypeError, IndexError):
            # payload ขาดช่องที่ต้องใช้ → ข้ามแถวนี้ นับไว้รายงาน
            self.skipped += 1
            return None

        # ทำนายเมื่อหน้าต่างเต็มแล้ว และมีแถวใหม่ครบ STRIDE นับจากครั้งก่อน
        self.since += 1
        if len(self.win) < WINDOW or self.since < STRIDE:
            return None
        self.since = 0

        # รันโมเดล → ความน่าจะเป็นของทุกคลาส
        probs = np.asarray(SESS.run([OUT], {"features": features(list(self.win))})[0])[0]
        # คลาสที่ความน่าจะเป็นสูงสุด = คำทาย
        k = int(np.argmax(probs))
        # ผลที่ส่งไปหน้าเว็บ: คำทาย · ความมั่นใจ · เฉลย (ถ้ามี) · ความน่าจะเป็นทุกคลาส · เวลา
        return {"prediction": CLASSES[k], "confidence": float(probs[k]),
                "true_label": p.get("true_label"), "run_id": p.get("run_id"),
                "probs": {c: float(v) for c, v in zip(CLASSES, probs)},
                "t": time.time()}


# ── main — อ่าน argument → ต่อ MQTT → วนรับ telemetry: ทำนาย · โหวต · ส่งผล · สรุป ──
# หยุดเมื่อครบ --minutes หรือกด Ctrl+C แล้วพิมพ์สรุปท้ายสุด
def main():
    # ── argument ที่ปรับได้ตอนรัน (ค่าเริ่มต้นมาจาก params.json) ──
    ap = argparse.ArgumentParser(description="ทำนาย anomaly จาก MQTT พร้อมสรุปผลสะสม")
    ap.add_argument("--minutes",  type=float, default=0,
                    help="รันกี่นาทีแล้วหยุดสรุปอัตโนมัติ (0 = ไม่จำกัด)")
    ap.add_argument("--report",   type=float, default=REPORT_SEC,
                    help="พิมพ์สรุประหว่างทางทุกกี่วินาที")
    ap.add_argument("--vote",     type=int,   default=VOTE,
                    help="โหวตจากคำทำนายกี่ครั้งติดกัน (15 ≈ 3 วินาที)")
    ap.add_argument("--min-sec",  type=float, default=MIN_EPISODE_SEC,
                    help="ช่วงที่สั้นกว่านี้ถือเป็นสัญญาณรบกวน")
    ap.add_argument("--quiet",    action="store_true", help="ไม่พิมพ์ทีละคำทำนาย")
    ap.add_argument("--save",     default="", help="บันทึกสรุปเป็นไฟล์ JSON")
    ap.add_argument("--log",      default="", help="บันทึกทุกคำทำนายเป็นไฟล์ CSV")
    # --ursim กับ --replay ใช้พร้อมกันไม่ได้
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--ursim",  action="store_true", help="บังคับโหมดข้อมูลสดจาก URSim")
    g.add_argument("--replay", action="store_true", help="บังคับโหมดข้อมูล replay")
    args = ap.parse_args()

    # --ursim / --replay บังคับโหมด · ไม่ใส่ = ดูจาก payload ทีละแถว
    force_fix = True if args.ursim else (False if args.replay else None)
    # สร้างตัวทาย และตัวสรุปช่วงเหตุการณ์
    pred = Predictor(force_fix)
    sess = Session(args.vote, args.min_sec)
    # ตัวแปรที่ callback MQTT ต้องแก้ได้ (เก็บใน dict เพราะฟังก์ชันซ้อนแก้ตัวแปรธรรมดาไม่ได้)
    state = {"last_report": time.time(), "stop": False}
    # ── เตรียมไฟล์ log ── หนึ่งแถวต่อหนึ่งคำทำนาย (5 แถว/วินาที)
    # 2 ชั่วโมง ≈ 36,000 แถว ราว 8 MB เปิดด้วย Excel หรือ pandas ได้เลย
    logf = logw = None
    logn = 0
    if args.log:
        import csv
        # utf-8-sig ให้ Excel เปิดภาษาไทยได้ถูก
        logf = open(args.log, "w", newline="", encoding="utf-8-sig")
        # หัวคอลัมน์: เวลา · run · เฉลย · คำทายดิบ/หลังโหวต · ความน่าจะเป็นทุกคลาส · เซนเซอร์
        cols = (["t_iso", "t_epoch", "run_id", "true_label",
                 "raw_pred", "raw_conf", "smoothed"]
                + [f"p_{c}" for c in CLASSES]
                + ["tcp_force", "robot_current"]
                + [f"temp_j{i+1}" for i in range(6)]
                + [f"err_j{i+1}_urad" for i in range(6)])
        logw = csv.writer(logf)
        logw.writerow(cols)

    def nonlocal_log(p, r, smooth):
        """หนึ่งแถว = คำทำนาย 1 ครั้ง + ค่าเซนเซอร์ ณ ขณะนั้น"""
        # nonlocal = แก้ตัวแปร logn ของ main ได้
        nonlocal logn
        # ช่องไหนไม่มีให้เป็น None 6 ตัว จะได้ไม่ error
        q  = p.get("actual_q")  or [None] * 6
        tq = p.get("target_q")  or [None] * 6
        tp = p.get("joint_temperatures") or [None] * 6
        # คลาดเคลื่อนรายข้อ = |มุมจริง − มุมเป้าหมาย| แปลงเป็น µrad (× 1,000,000)
        err = []
        for i in range(6):
            try:
                err.append(round(abs(float(q[i]) - float(tq[i])) * 1e6, 1))
            except (TypeError, ValueError, IndexError):
                err.append("")
        # เรียงค่าตามลำดับหัวคอลัมน์ข้างบน
        row = ([time.strftime("%Y-%m-%d %H:%M:%S"), round(r["t"], 3),
                r.get("run_id", ""), r.get("true_label") or "",
                r["prediction"], round(r["confidence"], 4), smooth or ""]
               + [round(r["probs"].get(c, 0.0), 4) for c in CLASSES]
               + [p.get("tcp_force_scalar", ""), p.get("actual_robot_current", "")]
               + [tp[i] if i < len(tp) else "" for i in range(6)]
               + err)
        logw.writerow(row)
        logn += 1
        if logn % 500 == 0:      # กัน log หายถ้าโดน Ctrl+C หรือไฟดับ
            logf.flush()

    # สร้าง client MQTT (API v2 ของ paho)
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)

    # ต่อ broker ได้ → subscribe telemetry แล้วพิมพ์ค่าที่ใช้อยู่
    def on_connect(c, u, flags, rc, props=None):
        c.subscribe(TOPIC_IN)
        lim = f"{args.minutes:.0f} นาที" if args.minutes else "ไม่จำกัด"
        print(f"ฟัง '{TOPIC_IN}'  →  '{TOPIC_OUT}' / '{TOPIC_SESS}'")
        print(f"โหวตจาก {args.vote} ครั้ง  ช่วงสั้นกว่า {args.min_sec} วิถือเป็นรบกวน")
        print(f"กำหนดเวลา {lim}  สรุประหว่างทางทุก {args.report:.0f} วินาที\n")

    # ทุก telemetry: ป้อน Predictor → ได้คำทำนาย → โหวต → publish ur/prediction ให้หน้าเว็บ
    def on_message(c, u, msg):
        # สั่งหยุดแล้ว ข้อความที่ค้างในคิวไม่ต้องทำ
        if state["stop"]:
            return
        # แปลง payload เป็น dict — ไม่ใช่ JSON ก็ข้าม
        try:
            p = json.loads(msg.payload)
        except Exception:
            return
        # โหมดเร่งเวลาส่งแถวที่ข้ามมา 125 แถวไม่ใช่ 1 วินาทีจริง ทายไม่ได้ ข้ามไป
        if p.get("ff", 1) > 1:
            return
        # ยังไม่ถึงรอบทาย → จบ
        r = pred.feed(p)
        if not r:
            return

        # โหวต แล้วแนบผลหลังโหวตไปกับผลดิบ ส่งให้หน้าเว็บ
        smooth = sess.add(r["prediction"], r["confidence"])
        r["smoothed"] = smooth
        c.publish(TOPIC_OUT, json.dumps(r))
        # เปิด --log ไว้ → เขียน 1 แถวลง CSV
        if logw:
            nonlocal_log(p, r, smooth)
        # มีเฉลย (true_label จาก replay) → นับความแม่นสะสมพิมพ์ให้ดูสดๆ
        if not args.quiet:
            tag = ""
            if r["true_label"]:
                pred.total += 1
                # ใช้ผลหลังโหวต ถ้ายังโหวตไม่ได้ใช้ผลดิบ
                ok = (smooth or r["prediction"]) == r["true_label"]
                pred.hits += ok
                tag = (f"  เฉลย: {r['true_label']:<20}"
                       f"{'ถูก' if ok else 'ผิด'}   สะสม {pred.hits}/{pred.total}")
            print(f"[{time.strftime('%H:%M:%S')}]  ดิบ {r['prediction']:<20}"
                  f"{r['confidence']:.2f}   โหวต {str(smooth):<20}{tag}", flush=True)

        # ครบรอบรายงาน → ส่งสรุปขึ้น ur/session · ครบเวลาที่กำหนด → ตัดการเชื่อมต่อ (ไปที่ finally)
        now = time.time()
        if args.report and now - state["last_report"] >= args.report:
            state["last_report"] = now
            c.publish(TOPIC_SESS, json.dumps(sess.report()))

        if args.minutes and now - sess.t0 >= args.minutes * 60:
            state["stop"] = True
            c.disconnect()

    # ผูก callback แล้วต่อ broker (keepalive 60 วินาที)
    client.on_connect = on_connect
    client.on_message = on_message
    client.connect(BROKER, PORT, 60)

    # วนรับข้อความไปเรื่อยๆ จนตัดการเชื่อมต่อหรือกด Ctrl+C
    try:
        client.loop_forever()
    except KeyboardInterrupt:
        print("\nหยุดแล้ว")
    # ออกด้วยเหตุใดก็ตาม → ปิดช่วงสุดท้าย พิมพ์สรุป บันทึกไฟล์
    finally:
        sess._close()
        summary = sess.report(final=True)
        # ความแม่นเทียบเฉลยทั้งหมด (มีเฉพาะตอน replay)
        if pred.total:
            print(f"ความแม่นเทียบเฉลย: {pred.hits}/{pred.total} "
                  f"({pred.hits / pred.total * 100:.1f}%)")
        if pred.skipped:
            print(f"ข้ามไป {pred.skipped} แถว (ข้อมูลไม่ครบ)")
        # --save → เขียนสรุปเป็นไฟล์ JSON
        if args.save:
            json.dump(summary, open(args.save, "w", encoding="utf-8"),
                      ensure_ascii=False, indent=1)
            print(f"บันทึกสรุปที่ {args.save}")
        # ปิดไฟล์ CSV ให้ข้อมูลที่ค้างในบัฟเฟอร์เขียนลงดิสก์
        if logf:
            logf.close()
            print(f"บันทึก log ที่ {args.log}  ({logn} แถว)")

# เริ่มที่ main() เมื่อรันไฟล์นี้ตรงๆ
if __name__ == "__main__":
    main()
