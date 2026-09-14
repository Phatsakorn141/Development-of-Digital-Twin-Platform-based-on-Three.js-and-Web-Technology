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
import argparse, json, time, sys
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


def play(client, cols, rows, speed, dry_run, label=None):
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
    return sent


def main():
    p = argparse.ArgumentParser(description="เล่นข้อมูลหุ่นจริงจาก DB เพื่อนซ้ำเข้า MQTT")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--run-id",  help="เจาะจง run")
    g.add_argument("--anomaly", default="normal", help="เลือก run แรกของชนิดนี้")
    p.add_argument("--list",    action="store_true", help="แสดง run ทั้งหมดแล้วออก")
    p.add_argument("--speed",   type=float, default=1.0, help="ตัวคูณความเร็ว (2 = เร็วสองเท่า)")
    p.add_argument("--loop",    action="store_true", help="วนซ้ำจนกด Ctrl+C")
    p.add_argument("--dry-run", action="store_true", help="พิมพ์ payload แถวแรกแล้วออก")
    args = p.parse_args()

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