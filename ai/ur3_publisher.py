"""
ur3_publisher.py
----------------
Reads UR3 telemetry via RTDE and publishes JSON to an MQTT broker.

Targets 125 Hz (= floor(500/125) = 4 ticks/sample on e-Series; native rate on
CB-series). Uses initPeriod()/waitPeriod() for jitter-free pacing, NOT
time.sleep().

Every RTDE getter is wrapped in safe_get(): if the running PolyScope version
does not expose a method, the field is set to None and the message still
ships. This avoids one missing field crashing the whole pipeline.
"""
# ============================================================
# ur3_publisher.py — สะพานจากหุ่น (URSim / UR3 จริง) เข้า MQTT  ← ตัวที่ต่อกับ URSim
#
# ทำงาน: อ่านค่าหุ่นผ่าน RTDE 125 ครั้ง/วินาที → แปลงเป็น JSON → publish ไป ur/telemetry
#        หน้าเว็บ, predict_mqtt.py และ logger ฝั่ง backend รับต่อจาก topic นี้
# แยก 2 thread: thread หลักอ่าน RTDE ให้ตรงจังหวะ · thread mqtt-writer ส่งออก
#               ส่งช้าไม่ทำให้การอ่านช้าตาม (มีคิวพักไว้ระหว่างกลาง)
# รัน: python ur3_publisher.py --run-id normal_001
# ============================================================

# ไลบรารีมาตรฐาน: argparse argument · json · math (sqrt) · queue คิวระหว่าง thread
# signal ดัก Ctrl+C · sys · threading · time · datetime เวลาเริ่ม run
import argparse
import json
import math
import queue
import signal
import sys
import threading
import time
from datetime import datetime, timezone

# paho-mqtt ส่งเข้า broker · psycopg ต่อ PostgreSQL (บันทึกแถว experiment_runs)
import paho.mqtt.client as mqtt
import psycopg
# rtde_receive (จากไลบรารี ur_rtde) — อ่านค่าหุ่นผ่านโปรโตคอล RTDE (port 30004)
import rtde_receive

# ──────────────────────────── Config ────────────────────────────
# IP ของ URSim (VM) — ต้องตรงกับ ur3_pick_place.py · ต่อหุ่นจริงให้เปลี่ยนเป็น IP หุ่น
ROBOT_IP    = "192.168.154.128"   # urSim VM IP (matches ur3_pick_place.py); change to real robot IP when on hardware
# broker Mosquitto ใน docker (port 1883 = TCP สำหรับ Python)
MQTT_BROKER = "localhost"
MQTT_PORT   = 1883
# topic ที่ส่งข้อมูลหุ่นออก
MQTT_TOPIC  = "ur/telemetry"

# DB ใช้แค่ตอนเริ่ม: เพิ่มแถว experiment_runs (บอกว่า run นี้คืออะไร) แล้วปิด
# ตอนจบใช้อีกครั้งเพื่อลงเวลาจบ (ended_at) · ข้อมูลหุ่นทีละแถวไม่ได้เขียนจากไฟล์นี้
# ⚠ ค่านี้ชี้ port 5432 ซึ่งตอนนี้เป็น dt-db ของเรา (db digitaltwin / user twin)
#   DB ของเพื่อน (ur_anomaly) อยู่ที่ port 5433 ตาม config/params.json
#   ถ้าต่อ DB ไม่ได้ โปรแกรมจะหยุดตั้งแต่ขั้นที่ 1 ใน main()
DB_DSN = "host=localhost port=5432 dbname=ur_anomaly user=ur_admin password=password"

FREQUENCY   = 125.0                 # Hz — natural rate (works on CB + e-Series)
DT          = 1.0 / FREQUENCY       # 8 ms

# คิวพักข้อมูลรอส่ง 4,000 แถว (~32 วินาที) — เต็มแล้วทิ้งแถวใหม่ นับเป็น dropped
QUEUE_MAX   = 4000                  # ~32 s of buffer at 125 Hz before drop

# ค่าเริ่มต้นของแถว experiment_runs ถ้าไม่ได้ใส่ใน command line
DEFAULT_ANOMALY_TYPE   = "normal"
DEFAULT_PAYLOAD_GRAMS  = 0.0
DEFAULT_SPEED_OVERRIDE = 0.5
DEFAULT_GRIPPER_FORCE  = None
# ช่วงการทำงานปัจจุบัน (0 พัก · 1 เข้าหาของ · 2 จับ · 3 ขนย้าย · 4 ปล่อย)
# ur3_pick_place.py ส่งมาทาง MQTT topic ur/phase — อัปเดตใน on_message ของ main()
CURRENT_PHASE = 0
# ────────────────────────────────────────────────────────────────


# ของพิเศษที่ใส่ลงคิวเพื่อบอก thread ส่งข้อมูลว่า "หยุดได้แล้ว"
_SENTINEL = object()


# ── safe_get — เรียกฟังก์ชันอ่านค่าของ RTDE แบบไม่พัง ──
def safe_get(rtde_r, method_name, default=None):
    """
    Call rtde_r.<method_name>() but return `default` if the method does not
    exist or raises. Lets us be schema-complete without caring exactly which
    PolyScope version is on the controller.
    """
    # หาเมธอดตามชื่อ — PolyScope บางรุ่นไม่มีบางตัว
    fn = getattr(rtde_r, method_name, None)
    if fn is None:
        return default
    # เรียกแล้ว error ก็คืนค่า default แทน ข้อความยังส่งได้
    try:
        return fn()
    except Exception:
        return default


# ── build_payload — อ่านค่าหุ่น ณ ขณะนี้ทุกช่อง แล้วประกอบเป็น dict (1 แถว = 1/125 วินาที) ──
def build_payload(rtde_r, run_id):
    """Read all 36 fields requested by the schema, then return a dict."""
    # แรง/แรงบิดที่ปลายแขน [fx, fy, fz, tx, ty, tz] (URSim ให้ค่าศูนย์ตลอด)
    actual_tcp_force = safe_get(rtde_r, "getActualTCPForce", [0.0] * 6)

    # แรงรวม = √(ผลรวมกำลังสองทั้ง 6 ค่า) — ดูค่าเดียวก็รู้ว่าแรงผิดปกติไหม
    if actual_tcp_force is not None:
        fx, fy, fz, tx, ty, tz = actual_tcp_force
        tcp_force_scalar = math.sqrt(fx*fx + fy*fy + fz*fz + tx*tx + ty*ty + tz*tz)
    else:
        tcp_force_scalar = None

    # ช่วงการทำงานไม่ได้อ่านจาก register ของหุ่น แต่ใช้ค่าที่รับมาทาง MQTT (ur/phase)
    # เลี่ยงข้อจำกัด Remote Control ของ controller ได้ทั้งหมด
    global CURRENT_PHASE

    return {
        # ── เวลาและรหัส run ──
        "timestamp": time.time(),                         # wall clock (epoch s)
        "rtde_timestamp": safe_get(rtde_r, "getTimestamp"),  # controller uptime (s)
        "run_id": run_id,

        # ── มุมและความเร็วข้อต่อ 6 ข้อ: target = ที่สั่ง · actual = ที่เป็นจริง (rad, rad/s) ──
        # ส่วนต่าง actual − target = ค่าคลาดเคลื่อนที่ DIAGNOSIS บนเว็บใช้
        "target_q":  safe_get(rtde_r, "getTargetQ"),
        "actual_q":  safe_get(rtde_r, "getActualQ"),
        "target_qd": safe_get(rtde_r, "getTargetQd"),
        "actual_qd": safe_get(rtde_r, "getActualQd"),

        # ── กระแสมอเตอร์ (A) · แรงบิดที่สั่ง · สัญญาณควบคุม ──
        "target_current":       safe_get(rtde_r, "getTargetCurrent"),
        "actual_current":       safe_get(rtde_r, "getActualCurrent"),
        "target_moment":        safe_get(rtde_r, "getTargetMoment"),
        "joint_control_output": safe_get(rtde_r, "getJointControlOutput"),

        # ── ปลายแขน (TCP): ตำแหน่ง/ท่า · ความเร็ว · แรง ──
        "actual_tcp_pose":  safe_get(rtde_r, "getActualTCPPose"),
        "actual_tcp_speed": safe_get(rtde_r, "getActualTCPSpeed"),
        "actual_tcp_force": actual_tcp_force,
        "target_tcp_pose":  safe_get(rtde_r, "getTargetTCPPose"),
        "target_tcp_speed": safe_get(rtde_r, "getTargetTCPSpeed"),
        # มีเฉพาะ PolyScope 5.23 ขึ้นไป — รุ่นเก่าได้ None
        "actual_tcp_acceleration": safe_get(rtde_r, "getActualTCPAcceleration"),
        "tcp_force_scalar": tcp_force_scalar,

        # ── ค่าดิบจากเซนเซอร์แรง/แรงบิด ──
        "ft_raw_wrench": safe_get(rtde_r, "getFtRawWrench"),
        # เดิมเคยส่งแรงที่คำนวณจากกระแสข้อต่อด้วย แต่ RTDE ไม่มีให้อ่าน
        # ต้องคำนวณเองจากกระแส + ค่าคงที่มอเตอร์ + จาโคเบียน — เป็นงานวิเคราะห์ ไม่ใช่งานเก็บข้อมูล

        # ── อุณหภูมิ (°C) · ไฟฟ้า · พลังงาน ──
        # joint_temperatures = อุณหภูมิ 6 ข้อ ที่ FORECAST / ALERTS บนเว็บใช้
        "joint_temperatures":    safe_get(rtde_r, "getJointTemperatures"),
        "tool_temperature":      safe_get(rtde_r, "getToolTemperature"),
        "actual_robot_current":  safe_get(rtde_r, "getActualRobotCurrent"),
        "actual_joint_voltage":  safe_get(rtde_r, "getActualJointVoltage"),
        "actual_robot_energy_consumed": safe_get(rtde_r, "getActualRobotEnergyConsumed"),

        # ── ความปลอดภัย · การชน · ความเร็ว ──
        # target_speed_fraction = ความเร็วที่ตั้ง (0.3 / 0.5 / 1.0) — DIAGNOSIS ใช้เลือกค่าปกติของความเร็วนั้น
        "collision_detection_ratio":      safe_get(rtde_r, "getCollisionDetectionRatio"),
        "joint_position_deviation_ratio": safe_get(rtde_r, "getJointPositionDeviationRatio"),
        "speed_scaling":                  safe_get(rtde_r, "getSpeedScaling"),
        "target_speed_fraction":          safe_get(rtde_r, "getTargetSpeedFraction"),

        # ── โหมดหุ่น / สถานะความปลอดภัย / สถานะโปรแกรม ──
        "robot_mode":     safe_get(rtde_r, "getRobotMode"),
        # ใช้ SafetyStatusBits ถ้ามี ไม่มีใช้ SafetyMode แทน
        "safety_status":  safe_get(rtde_r, "getSafetyStatusBits") or safe_get(rtde_r, "getSafetyMode"),
        "runtime_state":  safe_get(rtde_r, "getRuntimeState"),

        # ── register อเนกประสงค์ของ RTDE (ชื่อคีย์ตามระบบเพื่อน อ่านจากลำดับ 12–14) ──
        "output_double_register_24": _safe_register_double(rtde_r, 12),
        "output_double_register_25": _safe_register_double(rtde_r, 13),
        "output_double_register_26": _safe_register_double(rtde_r, 14),

        # ช่วงการทำงานจาก ur/phase: เก็บเป็นตัวเลข และแตกเป็น bit 64–67 (จริงได้ทีละตัว)
        "output_int_register_24":    CURRENT_PHASE,
        "output_bit_register_64":    bool(CURRENT_PHASE == 1),
        "output_bit_register_65":    bool(CURRENT_PHASE == 2),
        "output_bit_register_66":    bool(CURRENT_PHASE == 3),
        "output_bit_register_67":    bool(CURRENT_PHASE == 4),
    }


# ── อ่าน register แบบไม่พัง (หลักการเดียวกับ safe_get แต่ส่งเลข register ได้) ──
def _safe_register_double(rtde_r, idx):
    fn = getattr(rtde_r, "getOutputDoubleRegister", None)
    if fn is None:
        return None
    try:
        return fn(idx)
    except Exception:
        return None


# อ่าน register จำนวนเต็ม — ตอนนี้ไม่มีที่เรียกใช้ (ช่วงการทำงานมาจาก MQTT แทน)
def _safe_register_int(rtde_r, idx):
    fn = getattr(rtde_r, "getOutputIntRegister", None)
    if fn is None:
        return None
    try:
        return fn(idx)
    except Exception:
        return None


# อ่าน register bit — ตอนนี้ไม่มีที่เรียกใช้เหมือนกัน
def _safe_register_bit(rtde_r, idx):
    fn = getattr(rtde_r, "getOutputBitRegister", None)
    if fn is None:
        return None
    try:
        return bool(fn(idx))
    except Exception:
        return None


# ── ensure_run_exists — เพิ่มแถว experiment_runs ของ run นี้ (มีอยู่แล้วก็ข้าม) ──
# ตาราง telemetry ของระบบเพื่อนอ้าง run_id ผ่าน foreign key ต้องมีแถวนี้ก่อน
def ensure_run_exists(dsn, run_id, anomaly_type, payload_grams,
                      speed_override, gripper_force, notes=None):
    """
    Insert (or no-op if it already exists) the experiment_runs row that the
    telemetry table's foreign key points at.

    This is the single place that "remembers" the FK contract. Without this
    step the consumer would fail every batch with a ForeignKeyViolation —
    which is exactly what happened on the first run before this was added.
    """
    # ON CONFLICT DO NOTHING — run_id ซ้ำไม่ error แค่ไม่เพิ่ม
    sql = """
        INSERT INTO experiment_runs
            (run_id, started_at, anomaly_type, payload_grams,
             speed_override, gripper_force, notes)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (run_id) DO NOTHING
    """
    # เวลาเริ่มแบบ UTC
    started_at = datetime.now(timezone.utc)
    # autocommit=True — บันทึกทันทีไม่ต้อง commit เอง
    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (run_id, started_at, anomaly_type,
                              payload_grams, speed_override,
                              gripper_force, notes))
            inserted = cur.rowcount   # 1 = newly inserted, 0 = already existed
    if inserted:
        print(f"[run] created experiment_runs row '{run_id}' "
              f"(anomaly_type={anomaly_type})", flush=True)
    else:
        print(f"[run] experiment_runs row '{run_id}' already existed — reusing.",
              flush=True)
    return started_at


# ── parse_args — argument ตอนรัน (--run-id จำเป็น ที่เหลือมีค่าเริ่มต้น) ──
def parse_args():
    p = argparse.ArgumentParser(description="UR3 RTDE → MQTT publisher")
    p.add_argument("--run-id", required=True,
                   help="Identifier for this acquisition run, e.g. 'normal_001'")
    p.add_argument("--anomaly-type", default=DEFAULT_ANOMALY_TYPE,
                   help="e.g. normal, collision, payload_overload, pick_misalign_10mm")
    p.add_argument("--payload-grams", type=float, default=DEFAULT_PAYLOAD_GRAMS)
    p.add_argument("--speed-override", type=float, default=DEFAULT_SPEED_OVERRIDE,
                   help="1.0 = normal, 1.3 = 130%%, etc.")
    p.add_argument("--gripper-force", type=float, default=DEFAULT_GRIPPER_FORCE)
    p.add_argument("--notes", default=None)
    return p.parse_args()


# ── mqtt_writer — thread ส่งข้อมูล: หยิบจากคิวทีละแถวแล้ว publish ──
def mqtt_writer(client, q, stop_event):
    """Pull payloads off the queue and ship them to the broker."""
    while True:
        # รอจนมีของในคิว
        payload = q.get()
        # เจอตัวบอกหยุด → จบ thread
        if payload is _SENTINEL:
            return
        try:
            info = client.publish(MQTT_TOPIC, json.dumps(payload))
            # rc ไม่ใช่ SUCCESS = ส่งไม่สำเร็จ พิมพ์บอก
            if info.rc != mqtt.MQTT_ERR_SUCCESS:
                print(f"[mqtt] publish rc={info.rc}", flush=True)
        except Exception as e:
            print(f"[mqtt] publish error: {e!r}", flush=True)


# ── main — 1) บันทึก run ใน DB  2) ต่อ RTDE  3) ต่อ MQTT  4) วนอ่าน-ส่ง 125 Hz จน Ctrl+C ──
def main():
    args = parse_args()

    # ── 1. ต้องมีแถว experiment_runs ก่อนส่งข้อมูลใดๆ ──
    print("[init] ensuring experiment_runs row exists ...", flush=True)
    try:
        ensure_run_exists(
            DB_DSN,
            run_id=args.run_id,
            anomaly_type=args.anomaly_type,
            payload_grams=args.payload_grams,
            speed_override=args.speed_override,
            gripper_force=args.gripper_force,
            notes=args.notes,
        )
    # ต่อ DB ไม่ได้ → หยุดโปรแกรม (ดูหมายเหตุ ⚠ ที่ DB_DSN)
    except Exception as e:
        print(f"[init][FATAL] could not insert experiment_runs row: {e!r}",
              flush=True)
        print("[init] Is the database running?  docker-compose ps", flush=True)
        sys.exit(1)

    # ── 2. ต่อหุ่นผ่าน RTDE ขอข้อมูล 125 ครั้ง/วินาที ──
    print(f"[init] Connecting to UR3 at {ROBOT_IP} @ {FREQUENCY} Hz ...", flush=True)
    rtde_r = rtde_receive.RTDEReceiveInterface(ROBOT_IP, frequency=FREQUENCY)
    print(f"[init] RTDE connected. dt={DT*1000:.2f} ms", flush=True)

    # ── 3. ต่อ MQTT ──
    print(f"[init] Connecting to MQTT broker {MQTT_BROKER}:{MQTT_PORT} ...", flush=True)
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)

    # รับช่วงการทำงานจาก ur3_pick_place.py (ur/phase) เก็บไว้ใน CURRENT_PHASE
    def on_message(client, userdata, msg):
        global CURRENT_PHASE
        try:
            data = json.loads(msg.payload)
            CURRENT_PHASE = data.get("phase_id", 0)
        except Exception:
            pass

    client.on_message = on_message

    # ต่อ broker · subscribe ur/phase · loop_start = รับ/ส่งใน thread เบื้องหลัง
    client.connect(MQTT_BROKER, MQTT_PORT)
    client.subscribe("ur/phase")
    client.loop_start()
    print("[init] MQTT connected and subscribed to 'ur/phase'.", flush=True)

    # คิวกลางระหว่างตัวอ่าน (thread หลัก) กับตัวส่ง (mqtt-writer)
    q = queue.Queue(maxsize=QUEUE_MAX)
    # ธงบอกให้หยุด (ตั้งตอนกด Ctrl+C)
    stop_event = threading.Event()

    # เริ่ม thread ส่งข้อมูล (daemon = ปิดโปรแกรมแล้วตายตาม)
    writer = threading.Thread(
        target=mqtt_writer, args=(client, q, stop_event),
        name="mqtt-writer", daemon=True,
    )
    writer.start()

    # Ctrl+C → ตั้งธงหยุด ให้ลูปจบเองอย่างเรียบร้อย (ไม่ตัดกลางคัน)
    def _sigint(_sig, _frame):
        stop_event.set()
    signal.signal(signal.SIGINT, _sigint)

    print(f"[run] Publishing to topic '{MQTT_TOPIC}' (run_id='{args.run_id}')",
          flush=True)
    print( "[run] Press Ctrl+C to stop.", flush=True)

    # ตัวนับไว้พิมพ์อัตราส่งทุก 1 วินาที
    samples = 0
    dropped = 0
    t_report = time.monotonic()

    try:
        # ── ลูปหลัก: 1 รอบ = 8 ms ──
        while not stop_event.is_set():
            # เริ่มนับเวลารอบนี้ (ของ ur_rtde — แม่นกว่า time.sleep)
            t_start = rtde_r.initPeriod()
            # อ่านค่าหุ่นทุกช่อง
            payload = build_payload(rtde_r, args.run_id)

            # ใส่คิวแบบไม่รอ — คิวเต็ม (ส่งไม่ทัน) ทิ้งแถวนี้แล้วนับไว้
            try:
                q.put_nowait(payload)
            except queue.Full:
                dropped += 1

            # ทุก 1 วินาทีพิมพ์: ได้กี่ Hz · คิวค้างเท่าไหร่ · ทิ้งไปกี่แถว
            samples += 1
            now = time.monotonic()
            if now - t_report >= 1.0:
                print(
                    f"[rate] {samples} Hz | queue={q.qsize()} | dropped={dropped}",
                    flush=True,
                )
                samples = 0
                t_report = now

            # รอจนครบ 8 ms ของรอบนี้ แล้วค่อยวนรอบถัดไป
            rtde_r.waitPeriod(t_start)
    # ── ปิดทุกอย่างตามลำดับ ──
    finally:
        print("[shutdown] stopping ...", flush=True)
        # บอก thread ส่งข้อมูลให้หยุด แล้วรอไม่เกิน 5 วินาที
        q.put(_SENTINEL)
        writer.join(timeout=5.0)
        # ตัดการเชื่อมต่อหุ่น
        try:
            rtde_r.disconnect()
        except Exception:
            pass
        # ตัดการเชื่อมต่อ MQTT
        try:
            client.loop_stop()
            client.disconnect()
        except Exception:
            pass

        # ── 4. ลงเวลาจบ (ended_at) ในแถว experiment_runs ──
        try:
            with psycopg.connect(DB_DSN, autocommit=True) as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "UPDATE experiment_runs SET ended_at = NOW() WHERE run_id = %s",
                        (args.run_id,),
                    )
            print(f"[shutdown] stamped ended_at on '{args.run_id}'.", flush=True)
        except Exception as e:
            print(f"[shutdown] could not stamp ended_at: {e!r}", flush=True)

        print("[shutdown] done.", flush=True)


# เริ่มที่ main() เมื่อรันไฟล์นี้ตรงๆ
if __name__ == "__main__":
    main()
