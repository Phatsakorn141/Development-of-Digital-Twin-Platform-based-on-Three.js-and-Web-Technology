"""
ur3_pick_place.py
-----------------
[UPDATED] Drives the UR3 (urSim or real) through one or more pick-and-place cycles.
[UPDATED] Uses an "Integer Bridge" for phase tagging. Python writes an integer 
[UPDATED] phase ID to Input Int Register 24. A background URScript running on the 
[UPDATED] UR controller must read this integer and set Output Bits 64..67 accordingly.

Each cycle = 9 picks: object placed at fixed PICK position by the operator,
then moved by the robot into 3x3 grid cells P1..P9 in order.

Phase IDs sent to Register 24:
    0 = Idle
    1 = Approach Pick (translates to output bit 64)
    2 = Grasp         (translates to output bit 65)
    3 = Transport     (translates to output bit 66)
    4 = Release       (translates to output bit 67)

NO gripper logic yet -- grasp/release are replaced by a short dwell
(GRIPPER_DWELL_S). Plug the real gripper in by replacing dwell with
gripper open/close calls later.

Run:
    python ur3_pick_place.py --cycles 1
    python ur3_pick_place.py --cycles 5 --speed 0.5

Note:
    Make sure urSim/UR3 is in REMOTE CONTROL mode and Program is running on
    the controller -- otherwise RTDEControlInterface.connect() will fail.
"""
# ============================================================
# ur3_pick_place.py — สั่งหุ่น (URSim / UR3 จริง) ให้หยิบ-วางเป็นรอบ  ← ต่อกับ URSim
#
# 1 รอบ = หยิบ 9 ครั้ง: หยิบของที่จุด PICK แล้ววางลงช่องตาราง 3×3 (P1 → P9)
# แต่ละครั้งแบ่ง 4 ช่วง: เข้าหาของ → จับ → ขนย้าย → ปล่อย
# ทุกครั้งที่เปลี่ยนช่วง ส่งเลขช่วงไป MQTT topic ur/phase
#   → ur3_publisher.py รับแล้วแนบไปกับข้อมูลหุ่นทุกแถว (ไว้รู้ว่าข้อมูลแต่ละแถวอยู่ช่วงไหน)
# หมายเหตุ: docstring ข้างบนเขียนตอนยังส่งผ่าน Register 24 ของหุ่น
#           ปัจจุบันส่งทาง MQTT แทนแล้ว (ดู set_phase)
# ยังไม่มีมือจับจริง — ช่วงจับ/ปล่อยใช้การหยุดรอ 0.4 วินาทีแทน
# ============================================================

# argparse · math (π) · time (sleep) · json
import argparse
import math
import time
import json
# paho-mqtt ส่งเลขช่วงการทำงาน
import paho.mqtt.client as mqtt

# ur_rtde: rtde_control สั่งหุ่นเคลื่อนที่ · rtde_io สั่ง I/O ของหุ่น
import rtde_control
import rtde_io

# ---------------------------- Config ----------------------------
# IP ของ URSim — ต้องตรงกับ ur3_publisher.py
ROBOT_IP = "172.20.10.2"            # urSim VM IP
MQTT_BROKER = "localhost"

# ต่อ MQTT ตั้งแต่โหลดไฟล์ — ต่อไม่ได้แค่เตือน หุ่นยังเดินได้ (แต่ข้อมูลจะไม่มีเลขช่วง)
mqtt_client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
try:
    mqtt_client.connect(MQTT_BROKER, 1883)
    mqtt_client.loop_start()
except Exception as e:
    print(f"[warning] MQTT connection failed: {e}")

# ค่าการเคลื่อนที่ (ตั้งไว้ปลอดภัยสำหรับ URSim — หุ่นจริงค่อยเพิ่ม)
VEL          = 0.25     # m/s -- linear speed for movel
ACC          = 0.50     # m/s^2 -- linear acceleration for movel
VEL_J        = 1.05     # rad/s -- joint speed for movej (home only)
ACC_J        = 1.40     # rad/s^2 -- joint acceleration
# blend 0 = หยุดสนิททุกจุด แบ่งช่วงการทำงานได้ชัด
BLEND        = 0.0      # m -- blend radius (0 = stop at each waypoint, clean phase boundaries)

# เวลาหยุดรอแทนการจับ/ปล่อยของ (ยังไม่มีมือจับ)
GRIPPER_DWELL_S = 0.4   # seconds to "grasp" and "release"

# ------------ ตำแหน่งในพื้นที่ทำงาน (เมตร, เทียบกับฐานหุ่น) ------------
# ท่าปลายแขนชี้ลงตรงๆ: หมุนรอบแกน Y 180° (π rad)
TOOL_DOWN_RX = 0.0
TOOL_DOWN_RY = math.pi
TOOL_DOWN_RZ = 0.0

# ยกสูงกว่าจุดจับ 10 ซม. ตอนขนย้าย กันชนของ
LIFT_HEIGHT  = 0.10        # 100 mm above grasp height -- clearance during transport

# จุดหยิบของ (คนวางของไว้ตรงนี้ทุกครั้ง)
PICK_XY      = (0.300, -0.200)
# ความสูงตอนจับ: 5 ซม. เหนือโต๊ะ
GRASP_Z      = 0.050       # 50 mm above table

# ตาราง 3×3 จุดกึ่งกลางที่ (0.30, 0.10) ช่องห่างกัน 6 ซม.
X_CENTER     = 0.300
Y_CENTER     = 0.100
CELL_PITCH   = 0.060       # 60 mm between cell centres

# ท่าพัก (ตอนเริ่มและจบรอบ): สูง 30 ซม. ชี้ลง
HOME_POSE = [0.300, 0.000, 0.300,
             TOOL_DOWN_RX, TOOL_DOWN_RY, TOOL_DOWN_RZ]

# ------------ เลขช่วงการทำงาน (ส่งไป ur/phase) ------------
PHASE_IDLE          = 0
PHASE_APPROACH_PICK = 1
PHASE_GRASP         = 2
PHASE_TRANSPORT     = 3
PHASE_RELEASE       = 4
# -------------------------------------------------------------------------


# ── grid_cell_pose — ช่อง 1–9 → ตำแหน่ง [x, y, z, rx, ry, rz] ──
def grid_cell_pose(cell: int) -> list:
    """
    Return [x, y, z, rx, ry, rz] for grid cell 1..9.
    Layout:
        1 2 3      (back row,  larger Y)
        4 5 6
        7 8 9      (front row, smaller Y)
    """
    if not 1 <= cell <= 9:
        raise ValueError(f"cell must be 1..9, got {cell}")
    # แปลงเลขช่องเป็นคอลัมน์/แถว 0–2
    col = (cell - 1) % 3            # 0, 1, 2 (left -> right)
    row = (cell - 1) // 3           # 0, 1, 2 (back -> front)
    # (col − 1) = −1, 0, +1 → เลื่อนจากจุดกึ่งกลางทีละ 6 ซม.
    x = X_CENTER + (col - 1) * CELL_PITCH
    y = Y_CENTER - (row - 1) * CELL_PITCH
    return [x, y, GRASP_Z, TOOL_DOWN_RX, TOOL_DOWN_RY, TOOL_DOWN_RZ]


# ── above — ตำแหน่งเดิมแต่ยกสูงขึ้น dz (ค่าเริ่มต้น 10 ซม.) ──
def above(pose: list, dz: float = LIFT_HEIGHT) -> list:
    """Return a copy of `pose` with z raised by dz."""
    return [pose[0], pose[1], pose[2] + dz,
            pose[3], pose[4], pose[5]]


# ── pick_pose — ตำแหน่งจับของที่จุดหยิบ ──
def pick_pose() -> list:
    return [PICK_XY[0], PICK_XY[1], GRASP_Z,
            TOOL_DOWN_RX, TOOL_DOWN_RY, TOOL_DOWN_RZ]


# ── set_phase — ส่งเลขช่วงการทำงานไป MQTT (ur/phase) ──
# รับ io มาด้วยแต่ไม่ได้ใช้แล้ว (เหลือจากตอนส่งผ่าน register ของหุ่น)
def set_phase(io: rtde_io.RTDEIOInterface, phase_id: int):
    """
    [UPDATED] Sends the phase ID directly to the publisher via MQTT.
    Bypasses the UR controller entirely to avoid Remote Control restrictions.
    """
    try:
        payload = json.dumps({"phase_id": phase_id})
        mqtt_client.publish("ur/phase", payload)
    except Exception as e:
        print(f"[warning] failed to publish phase: {e}")


# ── one_pick — หยิบ 1 ครั้ง: จากจุดหยิบ ไปวางที่ช่อง place_cell ──
def one_pick(rtde_c: rtde_control.RTDEControlInterface,
             io: rtde_io.RTDEIOInterface,
             place_cell: int):
    """Run one full pick: approach -> grasp -> transport -> release."""
    pick = pick_pose()
    place = grid_cell_pose(place_cell)

    # ── ช่วง 1: เข้าหาของ — ไปเหนือจุดหยิบ แล้วลงไปที่ความสูงจับ ──
    # moveL = เคลื่อนปลายแขนเป็นเส้นตรง
    set_phase(io, PHASE_APPROACH_PICK)
    rtde_c.moveL(above(pick), VEL, ACC, BLEND)
    rtde_c.moveL(pick,        VEL, ACC, BLEND)

    # ── ช่วง 2: จับ — หยุดรอแทนการปิดมือจับ แล้วยกขึ้น ──
    set_phase(io, PHASE_GRASP)
    time.sleep(GRIPPER_DWELL_S)
    rtde_c.moveL(above(pick),  VEL, ACC, BLEND)   # lift with object

    # ── ช่วง 3: ขนย้าย — ไปเหนือช่องปลายทาง แล้วลงไป ──
    set_phase(io, PHASE_TRANSPORT)
    rtde_c.moveL(above(place), VEL, ACC, BLEND)
    rtde_c.moveL(place,        VEL, ACC, BLEND)

    # ── ช่วง 4: ปล่อย — หยุดรอแทนการเปิดมือจับ แล้วยกขึ้น ──
    set_phase(io, PHASE_RELEASE)
    time.sleep(GRIPPER_DWELL_S)
    rtde_c.moveL(above(place), VEL, ACC, BLEND)


# ── one_cycle — 1 รอบ = หยิบ 9 ครั้ง วางช่อง P1 ถึง P9 ──
def one_cycle(rtde_c, io, cycle_idx: int):
    """Run one full cycle: 9 picks into cells P1..P9."""
    print(f"  cycle {cycle_idx}: ", end="", flush=True)
    for cell in range(1, 10):
        print(f"P{cell} ", end="", flush=True)
        one_pick(rtde_c, io, cell)
    print("done", flush=True)


# ── main — ต่อหุ่น → ไปท่าพัก → เดินตามจำนวนรอบ → กลับท่าพัก → ตัดการเชื่อมต่อ ──
def main():
    # --cycles กี่รอบ · --speed ความเร็วเส้นตรง (m/s) แทนค่า VEL
    parser = argparse.ArgumentParser(description="UR3 pick-and-place driver")
    parser.add_argument("--cycles", type=int, default=1,
                        help="Number of full 9-pick cycles to run")
    parser.add_argument("--speed", type=float, default=None,
                        help="Override linear velocity (m/s), e.g. 0.10 for slow")
    args = parser.parse_args()

    # ใส่ --speed มา → แก้ค่า VEL ระดับไฟล์ (global) ให้ทุกฟังก์ชันใช้ค่าใหม่
    if args.speed is not None:
        global VEL
        VEL = args.speed
        print(f"[info] linear velocity override -> {VEL} m/s")

    # ต่อหุ่น (URSim ต้องเปิดโหมด Remote Control และกด Play ไว้)
    print(f"[init] Connecting to UR3 control at {ROBOT_IP} ...")
    rtde_c = rtde_control.RTDEControlInterface(ROBOT_IP)
    io     = rtde_io.RTDEIOInterface(ROBOT_IP)
    print("[init] Connected.")

    try:
        # เริ่มที่ช่วงพัก
        set_phase(io, PHASE_IDLE)

        # ไปท่าพักก่อน
        print("[move] going home ...")
        rtde_c.moveL(HOME_POSE, VEL, ACC)

        # เดินตามจำนวนรอบ
        for i in range(1, args.cycles + 1):
            one_cycle(rtde_c, io, i)
            # จบรอบกลับท่าพัก (ให้คนวางของใหม่ที่จุดหยิบ)
            print("  -> returning home")
            rtde_c.moveL(HOME_POSE, VEL, ACC)

        # จบทุกรอบ กลับช่วงพัก
        set_phase(io, PHASE_IDLE)
        print("[done] all cycles complete.")

    # Ctrl+C → สั่งหุ่นหยุด (หน่วงความเร็วลง 2.0 m/s²)
    except KeyboardInterrupt:
        print("\n[abort] interrupted by user -- stopping robot")
        rtde_c.stopL(2.0)
    # เก็บกวาดทุกอย่าง — แต่ละขั้น error ก็ข้ามไปขั้นต่อไป
    finally:
        try:
            set_phase(io, PHASE_IDLE)
        except Exception:
            pass
        # หยุดสคริปต์ควบคุมที่ ur_rtde ส่งไปรันบนหุ่น
        try:
            rtde_c.stopScript()
        except Exception:
            pass
        try:
            rtde_c.disconnect()
        except Exception:
            pass
        try:
            io.disconnect()
        except Exception:
            pass
        print("[shutdown] disconnected.")


# เริ่มที่ main() เมื่อรันไฟล์นี้ตรงๆ
if __name__ == "__main__":
    main()
