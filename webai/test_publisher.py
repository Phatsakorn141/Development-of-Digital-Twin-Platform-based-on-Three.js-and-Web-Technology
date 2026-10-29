# test_publisher.py — ตัวป้อน ur/telemetry ปลอม 125 Hz (ไว้เทสต์ webai โดยไม่ต้องตั้ง DB เพื่อน)
# ใช้ยืนยันว่าท่อทำงาน + หุ่นขยับ + webai ทำนาย + เก็บ metrics ได้
# ค่าทำนายจะไม่แม่น (ข้อมูลปลอม) แต่ใช้วัด latency/FPS/throughput ได้จริง
#   รัน:  pip install paho-mqtt   แล้ว   python webai/test_publisher.py
import json, math, time
import paho.mqtt.client as mqtt

BROKER, PORT, TOPIC, HZ = "localhost", 1883, "ur/telemetry", 125.0
c = mqtt.Client(); c.connect(BROKER, PORT, 60); c.loop_start()
print(f"ส่ง {TOPIC} ที่ {HZ:.0f} Hz ... Ctrl+C เพื่อหยุด")
dt = 1.0 / HZ; t = 0.0
try:
    while True:
        # มุมข้อต่อแกว่งเป็นคลื่น (ให้หุ่น 3D ขยับเห็นได้) + ค่าอื่นพอสมเหตุสมผล
        q = [math.sin(t*0.5 + i)*0.8 for i in range(6)]
        payload = {
            "actual_q": q,
            "actual_current": [math.sin(t + i)*0.5 for i in range(6)],
            "actual_tcp_pose": [0.3, 0.1, 0.4 + 0.05*math.sin(t), 0.0, 3.14, 0.0],
            "actual_tcp_speed": [0.1*math.sin(t), 0.05, 0.0, 0.0, 0.0, 0.0],
            "actual_tcp_force": [math.sin(t*2 + i)*3 for i in range(6)],
            "t_publish": time.time(),
        }
        c.publish(TOPIC, json.dumps(payload))
        t += dt; time.sleep(dt)
except KeyboardInterrupt:
    c.loop_stop(); print("\nหยุดแล้ว")
