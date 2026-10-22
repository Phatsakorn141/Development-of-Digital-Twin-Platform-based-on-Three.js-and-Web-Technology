"""
params.py — อ่านพารามิเตอร์กลางจาก config/params.json ไฟล์เดียวกับที่เว็บใช้

แก้ค่าที่ config/params.json ที่เดียว replay.py กับ predict_mqtt.py เปลี่ยนตามทั้งหมด
ค่าที่คำนวณจากค่าอื่นได้ (WINDOW, STRIDE) ไม่ได้เก็บในไฟล์ คำนวณตรงนี้
"""
# json อ่านไฟล์ค่าตั้ง · os ต่อ path ให้ถูกทั้ง Windows และ Linux
import json, os

# หาโฟลเดอร์โปรเจกต์จากตำแหน่งไฟล์นี้ (ai/params.py → ขึ้นไป 2 ชั้น)
# จึงรัน python จากโฟลเดอร์ไหนก็หา config/params.json เจอ
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # โฟลเดอร์โปรเจกต์
# เปิด config/params.json แบบ UTF-8 (มีภาษาไทยในคำอธิบาย) แล้วแปลงเป็น dict
with open(os.path.join(ROOT, "config", "params.json"), encoding="utf-8") as f:
    PARAMS = json.load(f)

# ── การสุ่มตัวอย่าง — hz เป็นตัวตั้งต้น ──
# _s = หมวด sampling ใน params.json
_s = PARAMS["sampling"]
# ความถี่ข้อมูลหุ่น (แถว/วินาที) — UR3 ส่งผ่าน RTDE 125 Hz
HZ     = _s["hz"]
# ขนาดหน้าต่างที่ป้อนโมเดล = กี่แถว (1 วินาทีของข้อมูล)
WINDOW = round(HZ * _s["window_sec"])                     # 125 × 1.0 = 125 แถว
# ทายทุกกี่แถวใหม่ = hz ÷ จำนวนครั้งที่ทายต่อวินาที (max กันได้ 0)
STRIDE = max(1, round(HZ / _s["predict_per_sec"]))        # 125 ÷ 5   = ทายทุก 25 แถว

# ── MQTT ──
# _m = หมวด mqtt — ที่อยู่ broker และชื่อ topic ทั้งหมดที่ระบบใช้
_m = PARAMS["mqtt"]
# ที่อยู่และ port ของ broker (Mosquitto ใน docker, port 1883 สำหรับ Python)
BROKER, PORT = _m["broker"], _m["port"]
# ur/telemetry — ข้อมูลหุ่น (ur3_publisher.py / replay.py ส่ง · เว็บ / predict_mqtt.py รับ)
TOPIC_TELEMETRY  = _m["topic_telemetry"]
# ur/prediction — ผลทายทีละครั้งจาก predict_mqtt.py ไปหน้าเว็บ
TOPIC_PREDICTION = _m["topic_prediction"]
# ur/session — สรุปช่วงเหตุการณ์สะสมจาก predict_mqtt.py
TOPIC_SESSION    = _m["topic_session"]
# ur/command — คำสั่งจากหน้าเว็บไป replay.py (เช่นเล่นแบบเร่งเวลา)
TOPIC_COMMAND    = _m["topic_command"]
# ur/replay_status — replay.py รายงานความคืบหน้ากลับไปหน้าเว็บ
TOPIC_STATUS     = _m["topic_status"]

# ── ฐานข้อมูลเพื่อน ──
# _d = หมวด db — Postgres ที่เก็บข้อมูลหุ่นจริงของเพื่อน (container friend226)
_d = PARAMS["db"]
# ต่อเป็นสตริงเชื่อมต่อรูปแบบที่ psycopg ต้องการ "host=... port=... dbname=..."
DB_DSN = (f"host={_d['host']} port={_d['port']} dbname={_d['name']} "
          f"user={_d['user']} password={_d['password']}")

# ── AI ── (model_dir นับจากโฟลเดอร์โปรเจกต์ รันจากโฟลเดอร์ไหนก็หาเจอ)
# _a = หมวด ai
_a = PARAMS["ai"]
# โฟลเดอร์โมเดล (เช่น Model_RF_v2) — มี rf.onnx, scaler.npz, classes.json
MODEL           = os.path.join(ROOT, _a["model_dir"])
# โหวตเสียงข้างมากจากคำทายกี่ครั้งติดกัน (ลดการทายผิดแบบสุ่ม)
VOTE            = _a["vote"]
# ช่วงเหตุการณ์ที่สั้นกว่านี้ (วินาที) ถือเป็นสัญญาณรบกวน ไม่นับ
MIN_EPISODE_SEC = _a["min_episode_sec"]
# พิมพ์/ส่งสรุประหว่างทางทุกกี่วินาที
REPORT_SEC      = _a["report_sec"]

# ── โหมดเร่งเวลา ── (คีย์ใน JSON เป็นข้อความ แปลงเป็นตัวเลข)
# ความเร็ว (%) → run ที่เอามาเล่นซ้ำเมื่อข้อมูลเดินต่อเนื่องจริงหมด เช่น {50: "..."}
FF_FILLER = {int(k): v for k, v in PARAMS["timelapse"]["filler"].items()}


# รันไฟล์นี้ตรงๆ เพื่อดูค่าที่อ่านได้ (import จากไฟล์อื่นจะไม่เข้าส่วนนี้)
if __name__ == "__main__":
    # python params.py — ดูค่าที่อ่านได้ และค่าที่คำนวณต่อ
    import sys
    sys.stdout.reconfigure(encoding="utf-8")      # ให้พิมพ์ภาษาไทยได้ทุกหน้าต่าง
    # พิมพ์ค่าที่คำนวณได้ ไว้เช็คว่าแก้ params.json แล้วได้ค่าตามที่ตั้งใจ
    print(f"hz {HZ}  →  window {WINDOW} แถว · stride {STRIDE} แถว")
    print(f"MQTT {BROKER}:{PORT}  ·  model {MODEL}")
    print(f"vote {VOTE} · min_episode {MIN_EPISODE_SEC} s · filler {FF_FILLER}")
