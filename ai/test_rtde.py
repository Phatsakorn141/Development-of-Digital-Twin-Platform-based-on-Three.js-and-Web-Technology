"""เช็คว่า URSim ให้กระแส/แรง/อุณหภูมิ ผ่าน RTDE ไหม"""
import rtde.rtde as rtde
import rtde.rtde_config as rtde_config

HOST = "172.20.10.3"
PORT = 30004

conf = rtde_config.ConfigFile("record_config.xml")
names, types = conf.get_recipe("out")

con = rtde.RTDE(HOST, PORT)
con.connect()
print("controller version:", con.get_controller_version())

con.send_output_setup(names, types, frequency=125)
con.send_start()

print("\nreading 20 samples (URSim must be running / Play pressed)\n")
rows = []
for _ in range(20):
    s = con.receive()
    if s is None:
        break
    rows.append(s)

con.send_pause()
con.disconnect()

if not rows:
    print("no data received - is the program running in URSim?")
else:
    first, last = rows[0], rows[-1]
    for f in ["actual_q", "actual_qd", "actual_current",
              "actual_TCP_pose", "actual_TCP_speed",
              "actual_TCP_force", "joint_temperatures"]:
        a, b = getattr(first, f), getattr(last, f)
        changed = any(abs(x - y) > 1e-9 for x, y in zip(a, b))
        print(f"{f:20} {'CHANGED' if changed else 'STATIC '}")
        print(f"   {[round(v, 4) for v in b]}\n")