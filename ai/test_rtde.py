"""เช็คว่า URSim ให้กระแส/แรง/อุณหภูมิ ผ่าน RTDE ไหม"""
# ใช้ไลบรารี RTDE ทางการของ Universal Robots (ไม่ใช่ ur_rtde แบบใน ur3_publisher.py)
import rtde.rtde as rtde
import rtde.rtde_config as rtde_config

# ⚠ IP นี้ต่างจาก ur3_publisher.py / ur3_pick_place.py (192.168.154.128) — ใช้ตอน URSim อยู่อีกเครือข่าย
HOST = "172.20.10.3"
# port 30004 = port มาตรฐานของ RTDE
PORT = 30004

# record_config.xml บอกว่าจะขอช่องข้อมูลอะไรบ้าง (recipe ชื่อ "out")
conf = rtde_config.ConfigFile("record_config.xml")
names, types = conf.get_recipe("out")

# ต่อหุ่น แล้วพิมพ์รุ่น controller
con = rtde.RTDE(HOST, PORT)
con.connect()
print("controller version:", con.get_controller_version())

# ขอข้อมูลตามรายการ 125 ครั้ง/วินาที แล้วเริ่มส่ง
con.send_output_setup(names, types, frequency=125)
con.send_start()

# อ่าน 20 แถว (~0.16 วินาที) — หุ่นต้องกด Play อยู่ ไม่งั้นได้ None
print("\nreading 20 samples (URSim must be running / Play pressed)\n")
rows = []
for _ in range(20):
    s = con.receive()
    if s is None:
        break
    rows.append(s)

# หยุดส่งและตัดการเชื่อมต่อ
con.send_pause()
con.disconnect()

if not rows:
    print("no data received - is the program running in URSim?")
else:
    # เทียบแถวแรกกับแถวสุดท้าย: ค่าเปลี่ยน = URSim จำลองค่านั้นจริง · ค่านิ่ง = เป็นค่าคงที่
    # (ผลที่ได้: กระแสเปลี่ยน แต่แรงกับอุณหภูมินิ่ง — URSim ไม่จำลองพลศาสตร์)
    first, last = rows[0], rows[-1]
    for f in ["actual_q", "actual_qd", "actual_current",
              "actual_TCP_pose", "actual_TCP_speed",
              "actual_TCP_force", "joint_temperatures"]:
        a, b = getattr(first, f), getattr(last, f)
        # มีค่าไหนต่างเกิน 1e-9 = เปลี่ยน
        changed = any(abs(x - y) > 1e-9 for x, y in zip(a, b))
        print(f"{f:20} {'CHANGED' if changed else 'STATIC '}")
        print(f"   {[round(v, 4) for v in b]}\n")
