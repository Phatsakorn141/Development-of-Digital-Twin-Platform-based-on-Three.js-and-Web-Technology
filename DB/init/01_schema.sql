-- ============================================================
-- Digital Twin Platform — schema
-- ออกแบบให้รับเครื่องจักรอะไรก็ได้ ไม่ผูกกับ UR3
-- ============================================================

-- ── ทะเบียนเครื่องจักร ──
-- เพิ่มเครื่องรุ่นใหม่ = เพิ่ม 1 แถว ไม่ต้อง migrate ตาราง
-- profile เก็บ srcTopic/srcPath/scale/invert/offset/unit ของทุก signal
CREATE TABLE IF NOT EXISTS devices (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    vendor     TEXT,
    profile    JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── ไฟล์โมเดล 3D ──
-- ตัวไฟล์จริงอยู่ใน volume ของ backend ตารางนี้เก็บแค่ข้อมูลกำกับ   
-- sha256 unique → อัปไฟล์เดิมซ้ำกี่ครั้งก็เก็บจริงก้อนเดียว
CREATE TABLE IF NOT EXISTS models (
    id          TEXT PRIMARY KEY,
    filename    TEXT NOT NULL,
    size_bytes  BIGINT NOT NULL,
    sha256      TEXT NOT NULL UNIQUE,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── project (.dtwp) ──
-- model_id คือตัวที่แก้ปัญหา "จำไม่ได้ว่า .dtwp ไหนคู่กับ .glb ไหน"
-- ON DELETE SET NULL — ลบโมเดลแล้ว project ยังอยู่ แค่ไม่มีโมเดลผูก
CREATE TABLE IF NOT EXISTS projects (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    model_id   TEXT REFERENCES models(id) ON DELETE SET NULL,
    data       JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── payload ดิบ ──
-- เก็บทั้งก้อนไว้เสมอ ห้ามทิ้ง
-- ถ้าวันหน้าพบว่า profile ตั้งผิด ยังคำนวณ signals ใหม่จากตารางนี้ได้
CREATE TABLE IF NOT EXISTS raw_messages (
    id      BIGSERIAL PRIMARY KEY,
    ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    topic   TEXT NOT NULL,
    run_id  TEXT,
    payload JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS raw_messages_ts_idx  ON raw_messages (ts DESC);
CREATE INDEX IF NOT EXISTS raw_messages_run_idx ON raw_messages (run_id, ts DESC);

-- ── ค่าที่แตกออกมาตาม profile แล้ว ──
-- device_id เป็น TEXT เฉยๆ ไม่ผูก foreign key กับ devices
-- เพราะถ้าผูกแล้วยังไม่ได้ลงทะเบียนเครื่อง การเก็บ log จะล้มเหลวทั้งหมด
-- ข้อมูลที่เก็บไม่ได้เสียหายกว่าข้อมูลที่ไม่มีเครื่องกำกับ
CREATE TABLE IF NOT EXISTS signals (
    id         BIGSERIAL PRIMARY KEY,
    ts         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    device_id  TEXT NOT NULL,
    run_id     TEXT,
    signal_key TEXT NOT NULL,
    value      DOUBLE PRECISION NOT NULL,
    unit       TEXT
);
CREATE INDEX IF NOT EXISTS signals_lookup_idx ON signals (device_id, signal_key, ts DESC);