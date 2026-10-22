"""ตัวอย่างค่าตั้งของ bridge.py — คัดลอกไฟล์นี้เป็น config.py แล้วแก้ค่าตามเครื่องที่ใช้

config.py อยู่ใน .gitignore ห้ามเอาขึ้น git เพราะอาจมีรหัสผ่านของ broker
"""

# ── ฝั่ง TCP: รอให้โปรแกรม project.urp ใน URSim ต่อเข้ามา ──
# 0.0.0.0 = รับจากทุกเครือข่าย · URSim (VirtualBox แบบ NAT) ต่อมาที่ 10.0.2.2:9000
TCP_HOST = "0.0.0.0"
TCP_PORT = 9000

# ── ฝั่ง MQTT: Mosquitto ในเครื่อง (docker compose up -d) ──
# port 1883 ไม่มี TLS · ถ้าใช้ broker บน Cloud ให้เปลี่ยนเป็น 8883 แล้วกรอก user/password
MQTT_BROKER = "localhost"
MQTT_PORT = 1883
MQTT_USER = ""
MQTT_PASSWORD = ""
MQTT_TOPIC = "ur3/joint_states"
