"""
replay.py — เล่นข้อมูลหุ่นจริงจาก DB ของเพื่อนซ้ำ แล้วยิงเข้า MQTT

ปลายทางเหมือน ur3_publisher.py ทุกอย่าง (topic เดิม คีย์เดิม 125 Hz)
ต่างแค่ต้นทางเป็น database แทน RTDE — เว็บกับโมเดลจึงไม่ต้องแก้อะไรเลย

ติดตั้ง:  pip install "psycopg[binary]" paho-mqtt
รัน:
    python replay.py --list                       ดูว่ามี run อะไรบ้าง
    python replay.py --anomaly friction           เล่น run แรกของชนิดนั้น
    python replay.py --run-id <id> --speed 2      เร่ง 2 เท่า
    python replay.py --anomaly normal --loop      วนซ้ำไม่รู้จบ (เดโม)
    python replay.py --anomaly friction --dry-run ดู payload เฉยๆ ไม่ยิงจริง
"""
import argparse, bisect, json, time, sys, threading
import psycopg
import paho.mqtt.client as mqtt

# ── ต้นทาง: container friend226 ──
DB_DSN = "host=localhost port=5433 dbname=ur_anomaly user=ur_admin password=password"

# ── ปลายทาง: broker เดียวกับ ur3_publisher.py ──
MQTT_BROKER = "localhost"
MQTT_PORT   = 1883
MQTT_TOPIC  = "ur/telemetry"

GAP_CAP = 0.5   # ถ้าข้อมูลขาดช่วงเกินเท่านี้ ให้ข้ามไปเลย ไม่ต้องนั่งรอจริง


def list_runs(conn):
    """แสดง run ทั้งหมดพร้อมจำนวนแถว — ไม่ยิง MQTT"""
    rows = conn.execute("""
        SELECT e.run_id, e.anomaly_type, count(t.*) AS n,
               max(t.time) - min(t.time) AS dur
        FROM experiment_runs e
        JOIN telemetry t USING (run_id)
        GROUP BY e.run_id, e.anomaly_type
        ORDER BY e.anomaly_type, e.run_id
    """).fetchall()
    print(f"{'run_id':<40}{'anomaly_type':<22}{'rows':>9}  ระยะเวลา")
    print("-" * 90)
    for run_id, atype, n, dur in rows:
        print(f"{run_id:<40}{atype:<22}{n:>9}  {dur}")
    print(f"\nรวม {len(rows)} runs")


def pick_run(conn, run_id, anomaly):
    """เลือก run ตามที่สั่ง — คืน (run_id, anomaly_type)"""
    if run_id:
        r = conn.execute(
            "SELECT run_id, anomaly_type FROM experiment_runs WHERE run_id = %s",
            (run_id,)).fetchone()
        if not r:
            sys.exit(f"ไม่พบ run_id '{run_id}' — ลอง --list ดูก่อน")
        return r
    r = conn.execute("""
        SELECT e.run_id, e.anomaly_type
        FROM experiment_runs e
        WHERE e.anomaly_type = %s
          AND EXISTS (SELECT 1 FROM telemetry t WHERE t.run_id = e.run_id)
        ORDER BY e.started_at
        LIMIT 1
    """, (anomaly,)).fetchone()
    if not r:
        sys.exit(f"ไม่พบ run ชนิด '{anomaly}' ที่มีข้อมูล — ลอง --list ดูก่อน")
    return r


def load_rows(conn, run_id):
    """ดึงทุกคอลัมน์ของ run นี้ คืน (ชื่อคอลัมน์, แถวทั้งหมด)"""
    cur = conn.execute(
        "SELECT * FROM telemetry WHERE run_id = %s ORDER BY time", (run_id,))
    cols = [d.name for d in cur.description]
    return cols, cur.fetchall()


def to_payload(cols, row, seq, label=None):
    """
    แปลงแถวใน DB เป็น payload หน้าตาเดียวกับที่ ur3_publisher.py ส่ง
    คีย์ตรงกันอยู่แล้วเพราะ schema ทำตามระบบเพื่อน — แค่ต้องแปลงเวลาเป็น epoch
    """
    d = dict(zip(cols, row))
    ts = d.pop("time")
    d["timestamp"] = ts.timestamp()     # เวลาที่บันทึกไว้จริงตอนเก็บข้อมูล
    d["t_publish"] = time.time()        # เวลาที่ยิงออก — app.js ใช้วัด latency
    d["pub_seq"]   = seq                # ตัวนับ — app.js ใช้นับข้อความหาย
    d["true_label"] = label             # เฉลย — ใส่ไว้ให้หน้าจอเทียบเฉยๆ โมเดลไม่ได้อ่านช่องนี้
    return d


def play(client, cols, rows, speed, dry_run, label=None, on_progress=None):
    """ยิงทีละแถว โดยถ่างเวลาตาม timestamp จริงในข้อมูล"""
    i_time = cols.index("time")
    t0_data = rows[0][i_time].timestamp()
    t0_wall = time.monotonic()
    sent = 0

    for seq, row in enumerate(rows):
        # เวลาที่แถวนี้ "ควร" ถูกส่ง นับจากเริ่มเล่น
        due = (row[i_time].timestamp() - t0_data) / speed
        lag = due - (time.monotonic() - t0_wall)
        if lag > GAP_CAP:
            t0_wall -= lag - GAP_CAP    # ข้อมูลขาดช่วง — ข้ามไป ไม่นั่งรอ
        elif lag > 0:
            time.sleep(lag)

        payload = to_payload(cols, row, seq, label)
        if dry_run:
            print(json.dumps(payload, indent=2, default=str))
            return sent
        client.publish(MQTT_TOPIC, json.dumps(payload, default=str))
        sent += 1

        if sent % 250 == 0:
            el = time.monotonic() - t0_wall
            print(f"  {sent:>6}/{len(rows)}  {el:6.1f}s  {sent/el:5.1f} Hz", flush=True)
            if on_progress:
                on_progress(sent, len(rows))
    if on_progress:
        on_progress(len(rows), len(rows))
    return sent

# ── โหมดรอรับคำสั่งจากหน้าเว็บ ──
# เว็บ publish ไป ur/command แล้วเราเล่น run ที่ตรงความเร็วที่ขอ
# พร้อมรายงานความคืบหน้ากลับไปที่ ur/replay_status ให้เว็บทำแถบโหลดได้
TOPIC_CMD    = "ur/command"
TOPIC_STATUS = "ur/replay_status"

# ความเร็วที่ user ตั้ง → run prefix ที่วัดไว้จริง
# มีข้อมูลแค่ 3 จุด ค่าอื่นเลือกตัวใกล้สุดแล้วติดป้ายว่าประมาณ
SPEED_RUNS = [
    (30,  "speed_30_%"),
    (50,  "baseline_30hz_%"),
    (100, "speed_100_%"),
]


def pick_by_speed(conn, pct):
    """คืน (run_id, anomaly_type, ความเร็วที่วัดไว้จริง, ตรงจุดไหม)"""
    nearest = min(SPEED_RUNS, key=lambda s: abs(s[0] - pct))
    exact = nearest[0] == pct
    r = conn.execute("""
        SELECT e.run_id, e.anomaly_type FROM experiment_runs e
        WHERE e.run_id LIKE %s
          AND EXISTS (SELECT 1 FROM telemetry t WHERE t.run_id = e.run_id)
        ORDER BY e.run_id LIMIT 1
    """, (nearest[1],)).fetchone()
    if not r:
        return None
    return r[0], r[1], nearest[0], exact

# ── โหมดเร่งเวลา (timelapse) ──
# เหมือนกด fast-forward คลิป YouTube: บอกแค่ว่าอยากดูเวลาจริงกี่นาที ระบบคูณเอง
#   ตัวคูณ = เวลาจริงที่ขอ ÷ เวลาที่ใช้ดู (ปกติ 120 วิ)
# ส่งออก 125 เฟรม/วิเท่าเดิม แต่ละเฟรมกระโดดไปข้างหน้าตามตัวคูณ (ข้ามแถวแบบ YouTube)
# ถ้าส่งทุกแถวที่ 60× ต้องส่ง 7,500 ข้อความ/วิ MQTT กับเบราว์เซอร์รับไม่ไหว
#
# ลำดับข้อมูลที่ใช้
#   1. ช่วงที่หุ่นเดินต่อเนื่องจริง   ff_real=True   อุณหภูมิในข้อมูลขึ้นจริง
#   2. ถ้ายังไม่ครบเวลา เล่นรอบปกติซ้ำ  ff_real=False  ท่าจริง แต่อุณหภูมิวนซ้ำ
#      เว็บแทนอุณหภูมิช่วงนี้ด้วยสมการความร้อน ต่อจากค่าจริงล่าสุด
FF_FPS = 125
# run ที่เอามาเล่นซ้ำต้องเก็บ 125 Hz — baseline_30hz เก็บแค่ 30 Hz ใช้ไม่ได้
FF_FILLER = {30: "speed_30_001", 50: "cold_start_d3_001", 100: "speed_100_001"}


def ff_block_ids(conn, pct):
    """ช่วงที่เดินต่อเนื่องจริงยาวสุดของแต่ละความเร็ว
       50%   long_run              43.8 นาที (31 รอบในการอัดครั้งเดียว)
       30%   speed_30 ทั้ง 20 run   46.3 นาที (19 พ.ค. ต่อกัน ห่างกันรอบละ ~20 วิ)
       100%  speed_100 ทั้ง 20 run  15.9 นาที (18 พ.ค. ต่อกัน)"""
    if pct == 50:
        return ["long_run"]
    return [r[0] for r in conn.execute(
        "SELECT run_id FROM experiment_runs WHERE anomaly_type = %s ORDER BY started_at",
        (f"speed_{pct}",))]


def load_rows_every(conn, run_id, step, max_sec):
    """เหมือน load_rows แต่เก็บแค่ทุกแถวที่ step และไม่เกิน max_sec วินาทีแรก
       long_run มี 327,866 แถว ที่ 60× ใช้จริงแค่ 5,465 แถว"""
    cur = conn.execute("""
        SELECT * FROM (
            SELECT t.*, row_number() OVER (ORDER BY time) AS _rn
            FROM telemetry t
            WHERE run_id = %s
              AND time <= (SELECT min(time) FROM telemetry WHERE run_id = %s)
                          + make_interval(secs => %s)
        ) x WHERE (_rn - 1) %% %s = 0 ORDER BY time
    """, (run_id, run_id, max_sec, step))
    cols = [d.name for d in cur.description][:-1]          # ตัด _rn ทิ้ง
    return cols, [r[:-1] for r in cur.fetchall()]


def ff_segment(conn, run_ids, step, max_sec=1e9):
    """ต่อหลาย run เป็นเส้นเวลาเดียว นับวินาทีจากต้น ตัดช่องว่างระหว่าง run ทิ้ง"""
    cols, rows, times, t_end = None, [], [], 0.0
    for rid in run_ids:
        left = max_sec - t_end
        if left <= 0:
            break
        c, rs = load_rows_every(conn, rid, step, left)
        if not rs:
            continue
        cols = c
        it = c.index("time")
        t0 = rs[0][it].timestamp()
        for r in rs:
            times.append(t_end + r[it].timestamp() - t0)
            rows.append(r)
        # run ถัดไปต่อท้ายทันที ห่างเท่าระยะเฉลี่ยระหว่างแถวของ run นี้
        t_end = times[-1] + (times[-1] - times[-len(rs)]) / max(1, len(rs) - 1)
    return cols, rows, times, t_end


def play_ff(client, status, cmd):
    """เล่นแบบเร่งเวลา — cmd มาจากปุ่มบนเว็บ {speed_pct, duration_min, watch_sec}"""
    pct = min((30, 50, 100), key=lambda s: abs(s - float(cmd.get("speed_pct", 50))))
    T = float(cmd.get("duration_min", 120)) * 60          # วินาทีของเวลาจริงที่ขอ
    watch = min(float(cmd.get("watch_sec", 120)), T)       # ขอสั้นกว่าเวลาดู ก็เล่นตามจริง
    mult = T / watch
    step = max(1, int(mult))

    with psycopg.connect(DB_DSN) as conn:
        block = ff_block_ids(conn, pct)
        cols, A, tA, durA = ff_segment(conn, block, step, T)
        _,    B, tB, durB = ff_segment(conn, [FF_FILLER[pct]], 1)
    if not A or not B:
        status(state="error", message=f"ไม่พบข้อมูลของความเร็ว {pct}%")
        return

    real_sec = min(durA, T)
    info = dict(mode="ff", speed_pct=pct, mult=round(mult, 2),
                duration_sec=round(T), watch_sec=round(watch), real_sec=round(real_sec),
                block=block[0] + (f" +{len(block) - 1} run" if len(block) > 1 else ""),
                filler=FF_FILLER[pct])
    status(state="start", **info)
    print(f"[ff] {pct}%  {T/60:.0f} นาที → ดู {watch:.0f} วิ  ×{mult:.1f}  "
          f"ข้อมูลจริง {real_sec/60:.1f} นาที ({info['block']})  "
          f"เล่นซ้ำ {FF_FILLER[pct]}", flush=True)

    frames = int(watch * FF_FPS)
    t0 = time.monotonic()
    for f in range(frames + 1):
        sim = min(T, f / FF_FPS * mult)                      # วินาทีของเวลาจริงที่เฟรมนี้แทน
        if sim < durA:
            row, real = A[max(0, bisect.bisect_right(tA, sim) - 1)], True
        else:
            k = (sim - durA) % durB
            row, real = B[max(0, bisect.bisect_right(tB, k) - 1)], False

        lag = f / FF_FPS - (time.monotonic() - t0)
        if lag > 0:
            time.sleep(lag)

        p = to_payload(cols, row, f)
        p.update(ff=round(mult, 2), ff_sim_sec=round(sim, 2), ff_real=real)
        client.publish(MQTT_TOPIC, json.dumps(p, default=str))

        if f % 25 == 0:
            status(state="playing", mode="ff", progress=round(sim / T, 3),
                   sim_sec=round(sim), real=real)

    status(state="done", **info)
    print(f"[ff] เสร็จ  ใช้เวลา {time.monotonic() - t0:.1f} วิ", flush=True)

def serve():
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    state = {"busy": False}

    def status(**kw):
        client.publish(TOPIC_STATUS, json.dumps(kw, default=str))

    def handle(cmd):
        pct = float(cmd.get("speed_pct", 50))
        cycles = int(cmd.get("cycles", 1))
        mult = float(cmd.get("speed_mult", 1.0))

        with psycopg.connect(DB_DSN) as conn:
            pick = pick_by_speed(conn, pct)
            if not pick:
                status(state="error", message=f"ไม่พบ run สำหรับความเร็ว {pct}%")
                return
            run_id, atype, real_pct, exact = pick
            cols, rows = load_rows(conn, run_id)

        if not rows:
            status(state="error", message=f"run '{run_id}' ไม่มีข้อมูล")
            return

        dur = (rows[-1][cols.index("time")] - rows[0][cols.index("time")]).total_seconds()
        status(state="start", run_id=run_id, anomaly_type=atype,
               speed_pct=real_pct, exact=exact, cycles=cycles,
               run_seconds=round(dur, 1), rows=len(rows))
        print(f"[cmd] speed {pct}% → {run_id} ({atype}) {len(rows)} แถว "
              f"{dur:.1f} วิ × {cycles} รอบ", flush=True)

        def on_progress(i, n):
            status(state="playing", run_id=run_id, progress=round(i / n, 3))

        for c in range(cycles):
            play(client, cols, rows, mult, False, atype, on_progress)

        status(state="done", run_id=run_id, anomaly_type=atype,
               speed_pct=real_pct, exact=exact, cycles=cycles,
               run_seconds=round(dur, 1))
        print(f"[cmd] เสร็จ {run_id}", flush=True)

    def on_connect(c, u, flags, rc, props=None):
        c.subscribe(TOPIC_CMD)
        print(f"รอคำสั่งที่ '{TOPIC_CMD}'  →  ส่งข้อมูลไป '{MQTT_TOPIC}'")
        print(f"รายงานสถานะที่ '{TOPIC_STATUS}'   (Ctrl+C เพื่อหยุด)\n")
        status(state="ready")

    def on_message(c, u, msg):
        try:
            cmd = json.loads(msg.payload)
        except Exception:
            return
        if cmd.get("cmd") not in ("run", "ff"):
            return
        if state["busy"]:
            status(state="busy", message="กำลังเล่นอยู่ รอให้จบก่อน")
            return
        state["busy"] = True

        # ต้องเล่นใน thread แยก ไม่งั้น network loop ของ paho ถูกบล็อก
        # แล้ว publish ทั้งหมดจะค้างในคิว ระบายออกทีเดียวตอนจบ (แขนกระตุกรวดเดียว)
        def worker():
            try:
                if cmd["cmd"] == "ff":
                    play_ff(client, status, cmd)
                else:
                    handle(cmd)
            except Exception as e:
                status(state="error", message=repr(e))
                print(f"[error] {e!r}", flush=True)
            finally:
                state["busy"] = False

        threading.Thread(target=worker, daemon=True).start()

    client.on_connect = on_connect
    client.on_message = on_message
    client.connect(MQTT_BROKER, MQTT_PORT, 60)
    try:
        client.loop_forever()
    except KeyboardInterrupt:
        print("\nหยุดแล้ว")
    finally:
        client.disconnect()



def main():
    p = argparse.ArgumentParser(description="เล่นข้อมูลหุ่นจริงจาก DB เพื่อนซ้ำเข้า MQTT")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--run-id",  help="เจาะจง run")
    g.add_argument("--anomaly", default="normal", help="เลือก run แรกของชนิดนี้")
    p.add_argument("--list",    action="store_true", help="แสดง run ทั้งหมดแล้วออก")
    p.add_argument("--speed",   type=float, default=1.0, help="ตัวคูณความเร็ว (2 = เร็วสองเท่า)")
    p.add_argument("--loop",    action="store_true", help="วนซ้ำจนกด Ctrl+C")
    p.add_argument("--dry-run", action="store_true", help="พิมพ์ payload แถวแรกแล้วออก")
    p.add_argument("--serve",   action="store_true",
                   help="ค้างรอคำสั่งจาก MQTT แทนการเล่นทันที (ใช้กับหน้าเว็บ)")
    args = p.parse_args()

    if args.serve:
        serve()
        return

    with psycopg.connect(DB_DSN) as conn:
        if args.list:
            list_runs(conn)
            return

        run_id, atype = pick_run(conn, args.run_id, args.anomaly)
        cols, rows = load_rows(conn, run_id)
        if not rows:
            sys.exit(f"run '{run_id}' ไม่มีข้อมูลใน telemetry")

        dur = rows[-1][cols.index("time")] - rows[0][cols.index("time")]
        print(f"run_id       = {run_id}")
        print(f"anomaly_type = {atype}      <<< นี่คือเฉลย")
        print(f"{len(rows)} แถว  ยาว {dur}  เล่นที่ speed x{args.speed}\n")

        client = None
        if not args.dry_run:
            client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
            client.connect(MQTT_BROKER, MQTT_PORT, 60)
            client.loop_start()
            print(f"ยิงเข้า {MQTT_BROKER}:{MQTT_PORT} topic '{MQTT_TOPIC}'  (Ctrl+C เพื่อหยุด)\n")

        try:
            while True:
                n = play(client, cols, rows, args.speed, args.dry_run, atype)
                print(f"\nจบรอบ — ส่งไป {n} ข้อความ")
                if not args.loop or args.dry_run:
                    break
                print("เริ่มรอบใหม่...\n")
        except KeyboardInterrupt:
            print("\nหยุดแล้ว")
        finally:
            if client:
                client.loop_stop()
                client.disconnect()


if __name__ == "__main__":
    main()