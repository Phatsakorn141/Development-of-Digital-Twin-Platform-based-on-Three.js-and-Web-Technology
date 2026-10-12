"""
params.py — อ่านพารามิเตอร์กลางจาก config/params.json ไฟล์เดียวกับที่เว็บใช้

แก้ค่าที่ config/params.json ที่เดียว replay.py กับ predict_mqtt.py เปลี่ยนตามทั้งหมด
ค่าที่คำนวณจากค่าอื่นได้ (WINDOW, STRIDE) ไม่ได้เก็บในไฟล์ คำนวณตรงนี้
"""
import json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # โฟลเดอร์โปรเจกต์
with open(os.path.join(ROOT, "config", "params.json"), encoding="utf-8") as f:
    PARAMS = json.load(f)

# ── การสุ่มตัวอย่าง — hz เป็นตัวตั้งต้น ──
_s = PARAMS["sampling"]
HZ     = _s["hz"]
WINDOW = round(HZ * _s["window_sec"])                     # 125 × 1.0 = 125 แถว
STRIDE = max(1, round(HZ / _s["predict_per_sec"]))        # 125 ÷ 5   = ทายทุก 25 แถว

# ── MQTT ──
_m = PARAMS["mqtt"]
BROKER, PORT = _m["broker"], _m["port"]
TOPIC_TELEMETRY  = _m["topic_telemetry"]
TOPIC_PREDICTION = _m["topic_prediction"]
TOPIC_SESSION    = _m["topic_session"]
TOPIC_COMMAND    = _m["topic_command"]
TOPIC_STATUS     = _m["topic_status"]

# ── ฐานข้อมูลเพื่อน ──
_d = PARAMS["db"]
DB_DSN = (f"host={_d['host']} port={_d['port']} dbname={_d['name']} "
          f"user={_d['user']} password={_d['password']}")

# ── AI ── (model_dir นับจากโฟลเดอร์โปรเจกต์ รันจากโฟลเดอร์ไหนก็หาเจอ)
_a = PARAMS["ai"]
MODEL           = os.path.join(ROOT, _a["model_dir"])
VOTE            = _a["vote"]
MIN_EPISODE_SEC = _a["min_episode_sec"]
REPORT_SEC      = _a["report_sec"]

# ── โหมดเร่งเวลา ── (คีย์ใน JSON เป็นข้อความ แปลงเป็นตัวเลข)
FF_FILLER = {int(k): v for k, v in PARAMS["timelapse"]["filler"].items()}


if __name__ == "__main__":
    # python params.py — ดูค่าที่อ่านได้ และค่าที่คำนวณต่อ
    import sys
    sys.stdout.reconfigure(encoding="utf-8")      # ให้พิมพ์ภาษาไทยได้ทุกหน้าต่าง
    print(f"hz {HZ}  →  window {WINDOW} แถว · stride {STRIDE} แถว")
    print(f"MQTT {BROKER}:{PORT}  ·  model {MODEL}")
    print(f"vote {VOTE} · min_episode {MIN_EPISODE_SEC} s · filler {FF_FILLER}")
