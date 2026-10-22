import socket
import re
import sys
import paho.mqtt.client as mqtt
import json
import ssl
import queue
import threading
import time
import signal

try:
    from config import (
        TCP_HOST,
        TCP_PORT,
        MQTT_BROKER,
        MQTT_PORT,
        MQTT_USER,
        MQTT_PASSWORD,
        MQTT_TOPIC,
    )
except ImportError:
    print("Missing config.py. Copy config.example.py to config.py and fill in MQTT values.")
    sys.exit(1)

PUBLISH_HZ = 10
# รหัสรอบการทำงาน — เปลี่ยนใหม่ทุกครั้งที่รัน bridge
# ใช้แบ่งข้อมูลเป็นรอบๆ เพื่อเทียบรอบต่อรอบและให้ AI เรียนรู้แยกรอบได้
# ── ป้ายกำกับคลาสสำหรับเก็บข้อมูลฝึก AI ──
#   python bridge.py speed_30
#   python bridge.py normal
# ไม่ใส่ = normal
LABEL  = sys.argv[1] if len(sys.argv) > 1 else "normal"
# ใส่ label ไว้ในชื่อ run ด้วย จะได้รู้ว่ารอบไหนเป็นคลาสอะไรตั้งแต่ดูชื่อ
RUN_ID = f"{LABEL}_{int(time.time())}"
PUBLISH_DT = 1.0 / PUBLISH_HZ
_SENTINEL  = object()

def mqtt_writer(client, q, stop_event):
    while not stop_event.is_set():
        try:
            payload = q.get(timeout=1.0)
            if payload is _SENTINEL:
                return
            client.publish(MQTT_TOPIC, json.dumps(payload), qos=0)
        except queue.Empty:
            continue
        except Exception as e:
            print(f"[MQTT ERROR] {e}")

def main():
    q = queue.Queue(maxsize=50)
    stop_event = threading.Event()

    def signal_handler(sig, frame):
        print("\nCtrl+C — shutting down...")
        stop_event.set()
    signal.signal(signal.SIGINT, signal_handler)

    mq = mqtt.Client(client_id="PythonUR3Bridge", callback_api_version=mqtt.CallbackAPIVersion.VERSION2)
    mq.username_pw_set(MQTT_USER, MQTT_PASSWORD)
    # ใช้ TLS เฉพาะ port 8883 (มาตรฐานของ MQTT over TLS)
    # Mosquitto ในเครื่องใช้ 1883 ไม่มี TLS — ถ้าเปิด TLS ไปจะต่อไม่ติด
    # และจะขึ้นแค่ "Connection failed" โดยไม่บอกว่าสาเหตุคือ TLS
    if MQTT_PORT == 8883:
        mq.tls_set(cert_reqs=ssl.CERT_NONE)
    try:
        mq.connect(MQTT_BROKER, MQTT_PORT, keepalive=60)
        mq.loop_start()
        print(f"[MQTT] Connected to {MQTT_BROKER}:{MQTT_PORT}")
    except Exception as e:
        print(f"[MQTT] Connection failed: {e}")
        sys.exit(1)

    writer_thread = threading.Thread(target=mqtt_writer, args=(mq, q, stop_event))
    writer_thread.start()

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((TCP_HOST, TCP_PORT))
    server.listen(1)
    print(f"[TCP] Waiting for URSim on {TCP_HOST}:{TCP_PORT}...")
    conn, addr = server.accept()
    conn.settimeout(1.0)
    print(f"[URSim] Connected from {addr}")
    print(f"[Bridge] Streaming at {PUBLISH_HZ} Hz | label={LABEL} | run={RUN_ID}")

    t_report    = time.monotonic()
    t_next_send = time.monotonic()
    samples     = 0
    dropped     = 0
    buffer      = ""
    # ตัวนับฝั่ง publish — เพิ่มทีละ 1 ทุกข้อความที่ส่งออกจริง
    # ต้องใช้ตัวนี้วัดข้อความหาย ไม่ใช่ n ของ URScript
    # เพราะ n เดินที่ 20 Hz แต่เรา publish แค่ 10 Hz ตัวเลขจึงกระโดดโดยตั้งใจ
    pub_seq     = 0

    try:
        while not stop_event.is_set():
            try:
                # พยายามรับข้อมูลจาก URSim
                chunk = conn.recv(1024).decode("utf-8")
                if not chunk:
                    print("[URSim] Connection closed by peer.")
                    break

                # ------ แก้ literal "\n" (backslash + n สองตัวอักษร) ที่ Unity ส่งมา ------
                # ให้กลายเป็น newline จริง (0x0A) ก่อนเข้า buffer ไม่งั้น "\n" not in buffer
                # จะเป็นจริงตลอดและ loop จะไม่ไปถึงขั้นตอน parse/publish เลย
                chunk = chunk.replace("\\n", "\n")

                # ------ เพิ่มตัวแฉข้อมูลตรงนี้ ------
                print(f"[DEBUG - RAW DATA IN] : {repr(chunk)}")
                # ---------------------------------
                
                buffer += chunk

                if "\n" not in buffer:
                    continue

                *complete, buffer = buffer.split("\n")
                line = complete[-1].strip()
                if not line:
                    continue

                # ── แปลงข้อความจาก URScript ให้เป็น JSON ──
                # 1) เติม quote ให้ key ที่ URScript ส่งมาโดยไม่มี quote
                fixed = re.sub(r'(\{|,)\s*([a-zA-Z0-9_]+)\s*:', r'\1"\2":', line)
                # 2) ตัด p ที่นำหน้า pose ออก
                #    to_str() ของชนิด pose คายออกมาเป็น "p[...]" ซึ่งไม่ใช่ JSON
                #    ถ้าไม่ตัดจะ parse ไม่ผ่านทุกข้อความที่มี tcp หรือ frc
                fixed = fixed.replace("p[", "[")
                raw = json.loads(fixed)

                def arr(key):
                    return [float(x) for x in raw.get(key, [])]

                aq = arr("aq")
                # project.urp รุ่นเก่าส่งมุมแยกเป็น j0..j5 แทน aq
                if not aq and "j0" in raw:
                    aq = [float(raw[f"j{i}"]) for i in range(6)]
                tq = arr("tq") or aq

            except socket.timeout:
                # ------ ให้มันพิมพ์บอกว่ายังรออยู่แทนที่จะเงียบ ------
                now_t = time.monotonic()
                if now_t - t_report >= 1.0:
                    print("[DEBUG] Python is listening... but NO DATA arriving from URSim.")
                    t_report = now_t
                continue
                # ---------------------------------------------
            except Exception as e:
                print(f"[Read/Parse Error] {e} | Data causing error: {line}")
                continue

            # Rate Limiter
            now = time.monotonic()
            if now >= t_next_send:
                pub_seq += 1
                payload = {
                    "robot":       "ur3",
                    "run_id":      RUN_ID,
                    "label":       LABEL,     # คลาสสำหรับฝึก AI
                    "src_seq":     int(raw.get("n", 0)),   # ตัวนับฝั่ง URScript (20 Hz)
                    "pub_seq":     pub_seq,                # ตัวนับฝั่ง publish (10 Hz) — ใช้วัดข้อความหาย
                    "t_publish":   time.time(),            # เวลาที่ host ส่งออก — ใช้วัด delay
                    "actual_q":    aq,                     # มุมจริง (rad)
                    "target_q":    tq,                     # มุมที่สั่ง (rad)
                    "joint_speed": arr("qd"),              # ความเร็วเชิงมุม (rad/s)
                    "joint_temp":  arr("tmp"),             # อุณหภูมิข้อต่อ (°C)
                    "tcp_pose":    arr("tcp"),             # ตำแหน่งปลายแขน (m, rad)
                    "tcp_force":   arr("frc"),             # แรงที่ปลายแขน (N, Nm)
                    # ── tracking error = สั่งไปเท่าไหร่ ไปถึงจริงเท่าไหร่ ──
                    # ค่านี้คำนวณที่นี่เลยเพราะเป็นตัวชี้สุขภาพเครื่องที่ตรงที่สุด
                    # ปกติควรใกล้ 0 — ถ้าโตขึ้นเรื่อยๆ แปลว่าข้อต่อฝืดหรือรับโหลดเกิน
                    "track_err":   [round(t - a, 6) for t, a in zip(tq, aq)],
                }

                try:
                    q.put_nowait(payload)
                    samples += 1
                except queue.Full:
                    dropped += 1

                t_next_send += PUBLISH_DT
                if t_next_send < now:
                    t_next_send = now + PUBLISH_DT

            # Status Report
            now2 = time.monotonic()
            if now2 - t_report >= 1.0:
                err_max = max((abs(e) for e in payload["track_err"]), default=0.0)
                print(f"[Stream] {samples} msg/s | dropped={dropped} | "
                      f"pub={payload['pub_seq']} | track_err_max={err_max:.5f} rad")
                samples  = 0
                dropped  = 0
                t_report = now2

    finally:
        stop_event.set()
        q.put(_SENTINEL)
        writer_thread.join(timeout=3.0)
        try:
            conn.close()
            server.close()
        except:
            pass
        mq.loop_stop()
        mq.disconnect()
        print("[Bridge] Shutdown complete.")
        sys.exit(0)

if __name__ == "__main__":
    main()
