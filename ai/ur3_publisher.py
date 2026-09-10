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

import argparse
import json
import math
import queue
import signal
import sys
import threading
import time
from datetime import datetime, timezone

import paho.mqtt.client as mqtt
import psycopg
import rtde_receive

# ──────────────────────────── Config ────────────────────────────
ROBOT_IP    = "192.168.154.128"   # urSim VM IP (matches ur3_pick_place.py); change to real robot IP when on hardware
MQTT_BROKER = "localhost"
MQTT_PORT   = 1883
MQTT_TOPIC  = "ur/telemetry"

# DB connection used ONLY to insert the experiment_runs row at startup.
# (The bulk telemetry write path is db_consumer.py — this connection is
# used once and closed.)
DB_DSN = "host=localhost port=5432 dbname=ur_anomaly user=ur_admin password=password"

FREQUENCY   = 125.0                 # Hz — natural rate (works on CB + e-Series)
DT          = 1.0 / FREQUENCY       # 8 ms

QUEUE_MAX   = 4000                  # ~32 s of buffer at 125 Hz before drop

# Defaults for the experiment_runs row when not given on the command line.
DEFAULT_ANOMALY_TYPE   = "normal"
DEFAULT_PAYLOAD_GRAMS  = 0.0
DEFAULT_SPEED_OVERRIDE = 0.5
DEFAULT_GRIPPER_FORCE  = None
CURRENT_PHASE = 0
# ────────────────────────────────────────────────────────────────


# Sentinel signal to writer thread do stop
_SENTINEL = object()


def safe_get(rtde_r, method_name, default=None):
    """
    Call rtde_r.<method_name>() but return `default` if the method does not
    exist or raises. Lets us be schema-complete without caring exactly which
    PolyScope version is on the controller.
    """
    fn = getattr(rtde_r, method_name, None)
    if fn is None:
        return default
    try:
        return fn()
    except Exception:
        return default


def build_payload(rtde_r, run_id):
    """Read all 36 fields requested by the schema, then return a dict."""
    actual_tcp_force = safe_get(rtde_r, "getActualTCPForce", [0.0] * 6)

    # Compute the scalar L2-norm of the wrench (same as MQTTUR10V2.py logic).
    # Useful as a quick anomaly indicator without unpacking the array.
    if actual_tcp_force is not None:
        fx, fy, fz, tx, ty, tz = actual_tcp_force
        tcp_force_scalar = math.sqrt(fx*fx + fy*fy + fz*fz + tx*tx + ty*ty + tz*tz)
    else:
        tcp_force_scalar = None

    # This bypasses the UR controller's Remote Control restrictions entirely.
    global CURRENT_PHASE

    return {
        # ── time & run id ─────────────────────────────────────
        "timestamp": time.time(),                         # wall clock (epoch s)
        "rtde_timestamp": safe_get(rtde_r, "getTimestamp"),  # controller uptime (s)
        "run_id": run_id,

        # ── joint positions / velocities ──────────────────────
        "target_q":  safe_get(rtde_r, "getTargetQ"),
        "actual_q":  safe_get(rtde_r, "getActualQ"),
        "target_qd": safe_get(rtde_r, "getTargetQd"),
        "actual_qd": safe_get(rtde_r, "getActualQd"),

        # ── currents / torques / control output ───────────────
        "target_current":       safe_get(rtde_r, "getTargetCurrent"),
        "actual_current":       safe_get(rtde_r, "getActualCurrent"),
        "target_moment":        safe_get(rtde_r, "getTargetMoment"),
        "joint_control_output": safe_get(rtde_r, "getJointControlOutput"),

        # ── TCP pose / speed / force ──────────────────────────
        "actual_tcp_pose":  safe_get(rtde_r, "getActualTCPPose"),
        "actual_tcp_speed": safe_get(rtde_r, "getActualTCPSpeed"),
        "actual_tcp_force": actual_tcp_force,
        "target_tcp_pose":  safe_get(rtde_r, "getTargetTCPPose"),
        "target_tcp_speed": safe_get(rtde_r, "getTargetTCPSpeed"),
        # PolyScope 5.23+ only — None on older controllers.
        "actual_tcp_acceleration": safe_get(rtde_r, "getActualTCPAcceleration"),
        "tcp_force_scalar": tcp_force_scalar,

        # ── F/T sensor data ───────────────────────────────────
        "ft_raw_wrench": safe_get(rtde_r, "getFtRawWrench"),
        # Note: a "wrench computed from joint currents" used to be sent here.
        # That value is not exposed by RTDE — it would have to be derived from
        # actual_current + motor torque constants + jacobian transpose. That's
        # feature engineering work for the analysis notebook, not ingestion.

        # ── temperatures / electrical / energy ────────────────
        "joint_temperatures":    safe_get(rtde_r, "getJointTemperatures"),
        "tool_temperature":      safe_get(rtde_r, "getToolTemperature"),
        "actual_robot_current":  safe_get(rtde_r, "getActualRobotCurrent"),
        "actual_joint_voltage":  safe_get(rtde_r, "getActualJointVoltage"),
        "actual_robot_energy_consumed": safe_get(rtde_r, "getActualRobotEnergyConsumed"),

        # ── safety / collision / scaling ──────────────────────
        "collision_detection_ratio":      safe_get(rtde_r, "getCollisionDetectionRatio"),
        "joint_position_deviation_ratio": safe_get(rtde_r, "getJointPositionDeviationRatio"),
        "speed_scaling":                  safe_get(rtde_r, "getSpeedScaling"),
        "target_speed_fraction":          safe_get(rtde_r, "getTargetSpeedFraction"),

        # ── modes / status ────────────────────────────────────
        "robot_mode":     safe_get(rtde_r, "getRobotMode"),
        "safety_status":  safe_get(rtde_r, "getSafetyStatusBits") or safe_get(rtde_r, "getSafetyMode"),
        "runtime_state":  safe_get(rtde_r, "getRuntimeState"),

        # ── general-purpose RTDE registers ────────────────────
        "output_double_register_24": _safe_register_double(rtde_r, 12),
        "output_double_register_25": _safe_register_double(rtde_r, 13),
        "output_double_register_26": _safe_register_double(rtde_r, 14),
        
        # Uses CURRENT_PHASE updated via MQTT sidechannel
        "output_int_register_24":    CURRENT_PHASE,
        "output_bit_register_64":    bool(CURRENT_PHASE == 1),
        "output_bit_register_65":    bool(CURRENT_PHASE == 2),
        "output_bit_register_66":    bool(CURRENT_PHASE == 3),
        "output_bit_register_67":    bool(CURRENT_PHASE == 4),
    }


def _safe_register_double(rtde_r, idx):
    fn = getattr(rtde_r, "getOutputDoubleRegister", None)
    if fn is None:
        return None
    try:
        return fn(idx)
    except Exception:
        return None


def _safe_register_int(rtde_r, idx):
    fn = getattr(rtde_r, "getOutputIntRegister", None)
    if fn is None:
        return None
    try:
        return fn(idx)
    except Exception:
        return None


def _safe_register_bit(rtde_r, idx):
    fn = getattr(rtde_r, "getOutputBitRegister", None)
    if fn is None:
        return None
    try:
        return bool(fn(idx))
    except Exception:
        return None


def ensure_run_exists(dsn, run_id, anomaly_type, payload_grams,
                      speed_override, gripper_force, notes=None):
    """
    Insert (or no-op if it already exists) the experiment_runs row that the
    telemetry table's foreign key points at.

    This is the single place that "remembers" the FK contract. Without this
    step the consumer would fail every batch with a ForeignKeyViolation —
    which is exactly what happened on the first run before this was added.
    """
    sql = """
        INSERT INTO experiment_runs
            (run_id, started_at, anomaly_type, payload_grams,
             speed_override, gripper_force, notes)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (run_id) DO NOTHING
    """
    started_at = datetime.now(timezone.utc)
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


def mqtt_writer(client, q, stop_event):
    """Pull payloads off the queue and ship them to the broker."""
    while True:
        payload = q.get()
        if payload is _SENTINEL:
            return
        try:
            info = client.publish(MQTT_TOPIC, json.dumps(payload))
            if info.rc != mqtt.MQTT_ERR_SUCCESS:
                print(f"[mqtt] publish rc={info.rc}", flush=True)
        except Exception as e:
            print(f"[mqtt] publish error: {e!r}", flush=True)


def main():
    args = parse_args()

    # ── 1. Make sure the FK target exists BEFORE any telemetry leaves ─
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
    except Exception as e:
        print(f"[init][FATAL] could not insert experiment_runs row: {e!r}",
              flush=True)
        print("[init] Is the database running?  docker-compose ps", flush=True)
        sys.exit(1)

    # ── 2. RTDE ────────────────────────────────────────────────────────
    print(f"[init] Connecting to UR3 at {ROBOT_IP} @ {FREQUENCY} Hz ...", flush=True)
    rtde_r = rtde_receive.RTDEReceiveInterface(ROBOT_IP, frequency=FREQUENCY)
    print(f"[init] RTDE connected. dt={DT*1000:.2f} ms", flush=True)

    # ── 3. MQTT ────────────────────────────────────────────────────────
    print(f"[init] Connecting to MQTT broker {MQTT_BROKER}:{MQTT_PORT} ...", flush=True)
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)

    def on_message(client, userdata, msg):
        global CURRENT_PHASE
        try:
            data = json.loads(msg.payload)
            CURRENT_PHASE = data.get("phase_id", 0)
        except Exception:
            pass

    client.on_message = on_message
    
    client.connect(MQTT_BROKER, MQTT_PORT)
    client.subscribe("ur/phase")
    client.loop_start()
    print("[init] MQTT connected and subscribed to 'ur/phase'.", flush=True)

    q = queue.Queue(maxsize=QUEUE_MAX)
    stop_event = threading.Event()

    writer = threading.Thread(
        target=mqtt_writer, args=(client, q, stop_event),
        name="mqtt-writer", daemon=True,
    )
    writer.start()

    # graceful Ctrl+C
    def _sigint(_sig, _frame):
        stop_event.set()
    signal.signal(signal.SIGINT, _sigint)

    print(f"[run] Publishing to topic '{MQTT_TOPIC}' (run_id='{args.run_id}')",
          flush=True)
    print( "[run] Press Ctrl+C to stop.", flush=True)

    samples = 0
    dropped = 0
    t_report = time.monotonic()

    try:
        while not stop_event.is_set():
            t_start = rtde_r.initPeriod()
            payload = build_payload(rtde_r, args.run_id)

            try:
                q.put_nowait(payload)
            except queue.Full:
                dropped += 1

            samples += 1
            now = time.monotonic()
            if now - t_report >= 1.0:
                print(
                    f"[rate] {samples} Hz | queue={q.qsize()} | dropped={dropped}",
                    flush=True,
                )
                samples = 0
                t_report = now

            rtde_r.waitPeriod(t_start)
    finally:
        print("[shutdown] stopping ...", flush=True)
        q.put(_SENTINEL)
        writer.join(timeout=5.0)
        try:
            rtde_r.disconnect()
        except Exception:
            pass
        try:
            client.loop_stop()
            client.disconnect()
        except Exception:
            pass

        # ── 4. Stamp ended_at on the run row ─────────────────────────
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


if __name__ == "__main__":
    main()