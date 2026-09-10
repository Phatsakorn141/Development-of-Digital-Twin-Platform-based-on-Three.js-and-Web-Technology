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

import argparse
import math
import time
import json
import paho.mqtt.client as mqtt

import rtde_control
import rtde_io

# ---------------------------- Config ----------------------------
ROBOT_IP = "192.168.154.128"            # urSim VM IP
MQTT_BROKER = "localhost"

mqtt_client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
try:
    mqtt_client.connect(MQTT_BROKER, 1883)
    mqtt_client.loop_start()
except Exception as e:
    print(f"[warning] MQTT connection failed: {e}")

# Motion parameters (safe defaults for urSim -- bump up later for real robot)
VEL          = 0.25     # m/s -- linear speed for movel
ACC          = 0.50     # m/s^2 -- linear acceleration for movel
VEL_J        = 1.05     # rad/s -- joint speed for movej (home only)
ACC_J        = 1.40     # rad/s^2 -- joint acceleration
BLEND        = 0.0      # m -- blend radius (0 = stop at each waypoint, clean phase boundaries)

# Phase timing (replaces gripper open/close for now)
GRIPPER_DWELL_S = 0.4   # seconds to "grasp" and "release"

# ------------ Workspace geometry (Cartesian, robot base frame) ------------
# All in meters. TCP orientation: pointing straight down.
TOOL_DOWN_RX = 0.0
TOOL_DOWN_RY = math.pi
TOOL_DOWN_RZ = 0.0

LIFT_HEIGHT  = 0.10        # 100 mm above grasp height -- clearance during transport

# Pick (fixed, operator places object here)
PICK_XY      = (0.300, -0.200)
GRASP_Z      = 0.050       # 50 mm above table

# 3x3 grid centred at (X_CENTER, Y_CENTER)
X_CENTER     = 0.300
Y_CENTER     = 0.100
CELL_PITCH   = 0.060       # 60 mm between cell centres

# Home pose (safe pose, used at startup and end-of-cycle)
HOME_POSE = [0.300, 0.000, 0.300,
             TOOL_DOWN_RX, TOOL_DOWN_RY, TOOL_DOWN_RZ]

# ------------ Phase Integers (Sent to Input Int Register 24) ------------
# [NEW] Replaced the bit numbers (64-67) with simple integer IDs (0-4).
PHASE_IDLE          = 0
PHASE_APPROACH_PICK = 1
PHASE_GRASP         = 2
PHASE_TRANSPORT     = 3
PHASE_RELEASE       = 4
# -------------------------------------------------------------------------


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
    col = (cell - 1) % 3            # 0, 1, 2 (left -> right)
    row = (cell - 1) // 3           # 0, 1, 2 (back -> front)
    x = X_CENTER + (col - 1) * CELL_PITCH
    y = Y_CENTER - (row - 1) * CELL_PITCH
    return [x, y, GRASP_Z, TOOL_DOWN_RX, TOOL_DOWN_RY, TOOL_DOWN_RZ]


def above(pose: list, dz: float = LIFT_HEIGHT) -> list:
    """Return a copy of `pose` with z raised by dz."""
    return [pose[0], pose[1], pose[2] + dz,
            pose[3], pose[4], pose[5]]


def pick_pose() -> list:
    return [PICK_XY[0], PICK_XY[1], GRASP_Z,
            TOOL_DOWN_RX, TOOL_DOWN_RY, TOOL_DOWN_RZ]


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


def one_pick(rtde_c: rtde_control.RTDEControlInterface,
             io: rtde_io.RTDEIOInterface,
             place_cell: int):
    """Run one full pick: approach -> grasp -> transport -> release."""
    pick = pick_pose()
    place = grid_cell_pose(place_cell)

    # -- Phase 1: approach pick (ID 1) ------------------------
    # [NEW] Call set_phase with the integer ID instead of setting individual bits
    set_phase(io, PHASE_APPROACH_PICK)
    rtde_c.moveL(above(pick), VEL, ACC, BLEND)
    rtde_c.moveL(pick,        VEL, ACC, BLEND)

    # -- Phase 2: grasp (ID 2) -- dwell replaces gripper close -
    # [NEW] Call set_phase with the integer ID instead of setting individual bits
    set_phase(io, PHASE_GRASP)
    time.sleep(GRIPPER_DWELL_S)
    rtde_c.moveL(above(pick),  VEL, ACC, BLEND)   # lift with object

    # -- Phase 3: transport (ID 3) ----------------------------
    # [NEW] Call set_phase with the integer ID instead of setting individual bits
    set_phase(io, PHASE_TRANSPORT)
    rtde_c.moveL(above(place), VEL, ACC, BLEND)
    rtde_c.moveL(place,        VEL, ACC, BLEND)

    # -- Phase 4: release (ID 4) -- dwell replaces gripper open -
    # [NEW] Call set_phase with the integer ID instead of setting individual bits
    set_phase(io, PHASE_RELEASE)
    time.sleep(GRIPPER_DWELL_S)
    rtde_c.moveL(above(place), VEL, ACC, BLEND)


def one_cycle(rtde_c, io, cycle_idx: int):
    """Run one full cycle: 9 picks into cells P1..P9."""
    print(f"  cycle {cycle_idx}: ", end="", flush=True)
    for cell in range(1, 10):
        print(f"P{cell} ", end="", flush=True)
        one_pick(rtde_c, io, cell)
    print("done", flush=True)


def main():
    parser = argparse.ArgumentParser(description="UR3 pick-and-place driver")
    parser.add_argument("--cycles", type=int, default=1,
                        help="Number of full 9-pick cycles to run")
    parser.add_argument("--speed", type=float, default=None,
                        help="Override linear velocity (m/s), e.g. 0.10 for slow")
    args = parser.parse_args()

    if args.speed is not None:
        global VEL
        VEL = args.speed
        print(f"[info] linear velocity override -> {VEL} m/s")

    print(f"[init] Connecting to UR3 control at {ROBOT_IP} ...")
    rtde_c = rtde_control.RTDEControlInterface(ROBOT_IP)
    io     = rtde_io.RTDEIOInterface(ROBOT_IP)
    print("[init] Connected.")

    try:
        # [NEW] Reset phase to IDLE (0) instead of clearing individual bits
        set_phase(io, PHASE_IDLE)

        # Go to home pose first
        print("[move] going home ...")
        rtde_c.moveL(HOME_POSE, VEL, ACC)

        # Run cycles
        for i in range(1, args.cycles + 1):
            one_cycle(rtde_c, io, i)
            # Return to home between cycles (gives operator time to reset pick)
            print("  -> returning home")
            rtde_c.moveL(HOME_POSE, VEL, ACC)

        # Final clean-up: Set phase to IDLE (0)
        set_phase(io, PHASE_IDLE)
        print("[done] all cycles complete.")

    except KeyboardInterrupt:
        print("\n[abort] interrupted by user -- stopping robot")
        rtde_c.stopL(2.0)
    finally:
        # Best-effort cleanup
        try:
            set_phase(io, PHASE_IDLE)
        except Exception:
            pass
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


if __name__ == "__main__":
    main()