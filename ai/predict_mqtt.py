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
import argparse, json, math, time, sys
from collections import deque, Counter, defaultdict

import numpy as np
import scipy.stats as st
import onnxruntime as ort
import paho.mqtt.client as mqtt

BROKER, PORT = "localhost", 1883
TOPIC_IN   = "ur/telemetry"
TOPIC_OUT  = "ur/prediction"
TOPIC_SESS = "ur/session"

WINDOW = 125      # 1 วินาที @ 125 Hz — ตามที่โมเดลเพื่อนกำหนด
STRIDE = 25       # ทายทุก 25 แถว = 5 ครั้ง/วินาที
MODEL  = "../Model_RF_v2"   # 8 คลาส (payload_normal ถูกยุบเข้า normal) — ตัวเก่า 9 คลาสอยู่ที่ ../Model_RF

CLASSES   = json.load(open(f"{MODEL}/classes.json"))
SC        = np.load(f"{MODEL}/scaler.npz")
MEAN, STD = SC["mean"], SC["std"]
SESS      = ort.InferenceSession(f"{MODEL}/rf.onnx", providers=["CPUExecutionProvider"])
OUT       = [o.name for o in SESS.get_outputs()][-1]


def channels(p, fix_ursim):
    """
    ประกอบ 23 ช่องตามลำดับที่โมเดลเพื่อนต้องการ

    fix_ursim=True  → ข้อมูลสดจาก URSim ต้องปรับ 2 จุดให้ตรง convention ของเพื่อน
    fix_ursim=False → ข้อมูล replay จาก DB เพื่อนอยู่ใน convention นั้นอยู่แล้ว
    """
    q    = list(p["actual_q"])
    pose = list(p["actual_tcp_pose"])
    if fix_ursim:
        q[5] -= 2 * math.pi
        pose[2] -= 0.261

    i = list(p["actual_current"])
    v = list(p["actual_tcp_speed"])
    f = list(p["actual_tcp_force"])

    tcp_spd = math.sqrt(v[0]**2 + v[1]**2 + v[2]**2)
    tcp_frc = math.sqrt(sum(x * x for x in f))
    return q + i + [pose[0], pose[1], pose[2]] + [tcp_spd, tcp_frc] + f


def features(win):
    """(125,23) → (1,161) — สูตรเดียวกับ predict_live.py เป๊ะ ห้ามต่างแม้แต่นิดเดียว"""
    X = ((np.asarray(win, dtype=np.float32) - MEAN) / STD)[None]
    m  = X.mean(1); s = X.std(1); mx = X.max(1); mn = X.min(1)
    rms = np.sqrt((X ** 2).mean(1))
    sk = st.skew(X, axis=1, bias=False, nan_policy="omit")
    ku = st.kurtosis(X, axis=1, bias=False, nan_policy="omit")
    return np.nan_to_num(np.hstack([m, s, mx, mn, rms, sk, ku]).astype(np.float32))


class Session:
    """สะสมคำทำนาย โหวตให้เรียบ แล้วรวบเป็นช่วงเหตุการณ์"""

    def __init__(self, vote, min_sec):
        self.vote    = deque(maxlen=vote)   # คำทำนายดิบล่าสุด ใช้โหวต
        self.min_sec = min_sec              # ช่วงที่สั้นกว่านี้ถือเป็นสัญญาณรบกวน ทิ้ง
        self.t0      = time.time()
        self.raw     = Counter()            # นับคำทำนายดิบ
        self.raw_flips = 0                  # คำทำนายดิบเปลี่ยนกี่ครั้ง
        self.last_raw  = None
        self.episodes  = []                 # ช่วงที่ปิดแล้ว
        self.cur       = None               # ช่วงที่กำลังเปิดอยู่
        self.n         = 0

    def add(self, label, conf):
        """ใส่คำทำนาย 1 ครั้ง คืนป้ายที่ผ่านการโหวตแล้ว (None ถ้ายังโหวตไม่ได้)"""
        self.n += 1
        self.raw[label] += 1
        if self.last_raw is not None and label != self.last_raw:
            self.raw_flips += 1
        self.last_raw = label

        self.vote.append(label)
        if len(self.vote) < self.vote.maxlen:
            return None
        smooth = Counter(self.vote).most_common(1)[0][0]

        now = time.time()
        if self.cur is None:
            self.cur = {"label": smooth, "start": now, "end": now, "n": 1, "conf": [conf]}
        elif smooth == self.cur["label"]:
            self.cur["end"] = now
            self.cur["n"] += 1
            self.cur["conf"].append(conf)
        else:
            self._close()
            self.cur = {"label": smooth, "start": now, "end": now, "n": 1, "conf": [conf]}
        return smooth

    def _close(self):
        e = self.cur
        if e is None:
            return
        e["dur"] = e["end"] - e["start"]
        e["conf"] = float(np.mean(e["conf"])) if e["conf"] else 0.0
        self.episodes.append(e)
        self.cur = None

    def snapshot(self):
        """ช่วงทั้งหมดรวมช่วงที่ยังเปิดอยู่ กรองตัวที่สั้นเกินออก"""
        eps = list(self.episodes)
        if self.cur:
            e = dict(self.cur)
            e["dur"] = e["end"] - e["start"]
            e["conf"] = float(np.mean(e["conf"])) if e["conf"] else 0.0
            eps.append(e)
        return [e for e in eps if e["dur"] >= self.min_sec]

    def report(self, final=False):
        el = time.time() - self.t0
        eps = self.snapshot()
        by = defaultdict(lambda: {"n": 0, "sec": 0.0})
        for e in eps:
            by[e["label"]]["n"] += 1
            by[e["label"]]["sec"] += e["dur"]
        covered = sum(v["sec"] for v in by.values()) or 1e-9

        bar = "=" * 66
        print(f"\n{bar}")
        print(f"สรุป{'ท้ายสุด' if final else 'ระหว่างทาง'}  "
              f"เดินมา {el/60:.1f} นาที  ทำนายไป {self.n} ครั้ง")
        print(bar)

        if not eps:
            print("ยังไม่มีช่วงเหตุการณ์ที่ยาวพอ — ลด --min-sec หรือรอนานกว่านี้")
        else:
            print(f"{'สถานะ':<22}{'ครั้ง':>6}{'รวมเวลา':>12}{'สัดส่วน':>10}")
            print("-" * 66)
            for lab, v in sorted(by.items(), key=lambda kv: -kv[1]["sec"]):
                flag = "  " if lab == "normal" else " ⚠"
                print(f"{lab:<22}{v['n']:>6}{v['sec']/60:>10.1f} น{v['sec']/covered*100:>9.0f}%{flag}")

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
            print(f"ลดสัญญาณรบกวนลง {(1 - len(eps)/self.raw_flips)*100:.1f}%")
        print(f"สัดส่วนคำทำนายดิบ: "
              + "  ".join(f"{k} {v/self.n*100:.0f}%"
                          for k, v in self.raw.most_common(4)))
        print(bar + "\n")

        return {"elapsed_sec": el, "n": self.n, "raw_flips": self.raw_flips,
                "episodes": [{"label": e["label"], "start": e["start"],
                              "dur": e["dur"], "conf": e["conf"]} for e in eps],
                "by_label": {k: v for k, v in by.items()}}


class Predictor:
    def __init__(self, force_fix):
        self.win       = deque(maxlen=WINDOW)
        self.since     = 0
        self.force_fix = force_fix
        self.hits = self.total = self.skipped = 0

    def feed(self, p):
        fix = self.force_fix if self.force_fix is not None else not p.get("replay")
        try:
            self.win.append(channels(p, fix))
        except (KeyError, TypeError, IndexError):
            self.skipped += 1
            return None

        self.since += 1
        if len(self.win) < WINDOW or self.since < STRIDE:
            return None
        self.since = 0

        probs = np.asarray(SESS.run([OUT], {"features": features(list(self.win))})[0])[0]
        k = int(np.argmax(probs))
        return {"prediction": CLASSES[k], "confidence": float(probs[k]),
                "true_label": p.get("true_label"), "run_id": p.get("run_id"),
                "probs": {c: float(v) for c, v in zip(CLASSES, probs)},
                "t": time.time()}


def main():
    ap = argparse.ArgumentParser(description="ทำนาย anomaly จาก MQTT พร้อมสรุปผลสะสม")
    ap.add_argument("--minutes",  type=float, default=0,
                    help="รันกี่นาทีแล้วหยุดสรุปอัตโนมัติ (0 = ไม่จำกัด)")
    ap.add_argument("--report",   type=float, default=300,
                    help="พิมพ์สรุประหว่างทางทุกกี่วินาที")
    ap.add_argument("--vote",     type=int,   default=15,
                    help="โหวตจากคำทำนายกี่ครั้งติดกัน (15 ≈ 3 วินาที)")
    ap.add_argument("--min-sec",  type=float, default=3,
                    help="ช่วงที่สั้นกว่านี้ถือเป็นสัญญาณรบกวน")
    ap.add_argument("--quiet",    action="store_true", help="ไม่พิมพ์ทีละคำทำนาย")
    ap.add_argument("--save",     default="", help="บันทึกสรุปเป็นไฟล์ JSON")
    ap.add_argument("--log",      default="", help="บันทึกทุกคำทำนายเป็นไฟล์ CSV")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--ursim",  action="store_true", help="บังคับโหมดข้อมูลสดจาก URSim")
    g.add_argument("--replay", action="store_true", help="บังคับโหมดข้อมูล replay")
    args = ap.parse_args()

    force_fix = True if args.ursim else (False if args.replay else None)
    pred = Predictor(force_fix)
    sess = Session(args.vote, args.min_sec)
    state = {"last_report": time.time(), "stop": False}
    # ── เตรียมไฟล์ log ── หนึ่งแถวต่อหนึ่งคำทำนาย (5 แถว/วินาที)
    # 2 ชั่วโมง ≈ 36,000 แถว ราว 8 MB เปิดด้วย Excel หรือ pandas ได้เลย
    logf = logw = None
    logn = 0
    if args.log:
        import csv
        logf = open(args.log, "w", newline="", encoding="utf-8-sig")
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
        nonlocal logn
        q  = p.get("actual_q")  or [None] * 6
        tq = p.get("target_q")  or [None] * 6
        tp = p.get("joint_temperatures") or [None] * 6
        err = []
        for i in range(6):
            try:
                err.append(round(abs(float(q[i]) - float(tq[i])) * 1e6, 1))
            except (TypeError, ValueError, IndexError):
                err.append("")
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

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)

    def on_connect(c, u, flags, rc, props=None):
        c.subscribe(TOPIC_IN)
        lim = f"{args.minutes:.0f} นาที" if args.minutes else "ไม่จำกัด"
        print(f"ฟัง '{TOPIC_IN}'  →  '{TOPIC_OUT}' / '{TOPIC_SESS}'")
        print(f"โหวตจาก {args.vote} ครั้ง  ช่วงสั้นกว่า {args.min_sec} วิถือเป็นรบกวน")
        print(f"กำหนดเวลา {lim}  สรุประหว่างทางทุก {args.report:.0f} วินาที\n")

    def on_message(c, u, msg):
        if state["stop"]:
            return
        try:
            p = json.loads(msg.payload)
        except Exception:
            return
        # โหมดเร่งเวลาส่งแถวที่ข้ามมา 125 แถวไม่ใช่ 1 วินาทีจริง ทายไม่ได้ ข้ามไป
        if p.get("ff", 1) > 1:
            return
        r = pred.feed(p)
        if not r:
            return

        smooth = sess.add(r["prediction"], r["confidence"])
        r["smoothed"] = smooth
        c.publish(TOPIC_OUT, json.dumps(r))
        if logw:
            nonlocal_log(p, r, smooth)
        if not args.quiet:
            tag = ""
            if r["true_label"]:
                pred.total += 1
                ok = (smooth or r["prediction"]) == r["true_label"]
                pred.hits += ok
                tag = (f"  เฉลย: {r['true_label']:<20}"
                       f"{'ถูก' if ok else 'ผิด'}   สะสม {pred.hits}/{pred.total}")
            print(f"[{time.strftime('%H:%M:%S')}]  ดิบ {r['prediction']:<20}"
                  f"{r['confidence']:.2f}   โหวต {str(smooth):<20}{tag}", flush=True)

        now = time.time()
        if args.report and now - state["last_report"] >= args.report:
            state["last_report"] = now
            c.publish(TOPIC_SESS, json.dumps(sess.report()))

        if args.minutes and now - sess.t0 >= args.minutes * 60:
            state["stop"] = True
            c.disconnect()

    client.on_connect = on_connect
    client.on_message = on_message
    client.connect(BROKER, PORT, 60)

    try:
        client.loop_forever()
    except KeyboardInterrupt:
        print("\nหยุดแล้ว")
    finally:
        sess._close()
        summary = sess.report(final=True)
        if pred.total:
            print(f"ความแม่นเทียบเฉลย: {pred.hits}/{pred.total} "
                  f"({pred.hits / pred.total * 100:.1f}%)")
        if pred.skipped:
            print(f"ข้ามไป {pred.skipped} แถว (ข้อมูลไม่ครบ)")
        if args.save:
            json.dump(summary, open(args.save, "w", encoding="utf-8"),
                      ensure_ascii=False, indent=1)
            print(f"บันทึกสรุปที่ {args.save}")
        if logf:
            logf.close()
            print(f"บันทึก log ที่ {args.log}  ({logn} แถว)")

if __name__ == "__main__":
    main()