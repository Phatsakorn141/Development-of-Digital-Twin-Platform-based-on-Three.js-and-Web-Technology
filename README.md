# Digital Twin 3D Model Web App

แพลตฟอร์มดิจิทัลทวินสำหรับแขนกล UR3 — แสดงการเคลื่อนไหวแบบ 3D พร้อมตรวจจับความผิดปกติด้วย AI

## Features

- Load 3D models (.glb, .gltf)
- Interactive node tree viewer
- Create custom joints (rotation, translation) with multi-node support and custom pivot points
- Sensor simulation for joints
- State management: Save, load, and delete presets
- Keyframe animation: Record animation sequences and play back with interpolation
- Export and import project configurations (.dtwp)
- **รับข้อมูลสดผ่าน MQTT** — ผูก joint กับ topic/path ได้เองในหน้าเว็บ
- **ตรวจจับความผิดปกติด้วย Random Forest** พร้อมบอกว่าผิดที่ข้อไหนและเพราะอะไร

---

## ติดตั้ง

### 1. สิ่งที่ต้องมี

| | เวอร์ชันที่ใช้ | ใช้ทำอะไร |
|---|---|---|
| Node.js | v22 | เสิร์ฟหน้าเว็บ + benchmark |
| Python | 3.13 | ท่อข้อมูลและวิเคราะห์ |
| Docker Desktop | — | Postgres / TimescaleDB / Mosquitto |

### 2. Python packages

```bash
pip install psycopg2-binary "psycopg[binary]" numpy scipy scikit-learn onnxruntime paho-mqtt
```

เพิ่มเติมถ้าจะต่อ URSim จริง

```bash
pip install ur-rtde skl2onnx
```

### 3. บริการพื้นหลัง

```bash
docker compose up -d
```

ได้ 3 ตัว

| พอร์ต | บริการ |
|---|---|
| 3001 | `dt-api` — Node API |
| 5432 | `dt-db` — Postgres |
| 1883 / 9001 | `dt-mqtt` — Mosquitto (TCP / WebSocket) |

> **9001 สำคัญ** เบราว์เซอร์ต่อ MQTT ผ่าน WebSocket ไม่ใช่ TCP

### 4. โมเดล AI — ต้องขอแยก

**โมเดลไม่ได้อยู่ใน repo นี้** เพราะเป็นงานของผู้พัฒนาโมเดล ต้องติดต่อขอโดยตรง

วางไฟล์ให้ครบแบบนี้

```
Model_RF_v2/          ← ตัวที่ใช้อยู่ 8 คลาส
  rf.onnx             108.2 MB
  scaler.npz
  classes.json
  thresholds.json
  manifest.json
```

ตรวจว่าได้ไฟล์ถูกตัวด้วย sha256 ที่ระบุใน `manifest.json`

```bash
sha256sum Model_RF_v2/rf.onnx
```

ต้องได้ `74ec4e4f636d14cc...` สำหรับ `rf.onnx` เวอร์ชัน 8 คลาส

> เวอร์ชันเก่า 9 คลาส (`Model_RF/`) ให้ความแม่น 80.7% เทียบกับ 84.0% ของเวอร์ชันปัจจุบัน
> เก็บไว้เทียบได้ แต่ไม่จำเป็นต่อการใช้งาน

### 5. ฐานข้อมูลหุ่นจริง (ถ้าจะรัน replay หรือวิเคราะห์)

```bash
docker run -d --name friend226 -p 5433:5432 -e POSTGRES_PASSWORD=password -e POSTGRES_USER=ur_admin -e POSTGRES_DB=ur_anomaly -v "D:/projectwin:/dump:ro" timescale/timescaledb-ha:pg18-ts2.26
```

แล้วกู้ข้อมูลด้วย `analysis/restore_friend_db.sh`

> ⚠️ ต้องใช้ image **`pg18-ts2.26`** ให้ตรงเวอร์ชัน TimescaleDB ที่ dump สร้างมา
> และ **รัน `pg_restore` ครั้งเดียวเท่านั้น** รันซ้ำบนฐานเดิมข้อมูลจะทวีคูณเงียบๆ

---

## รันหน้าเว็บ

```bash
npx serve .
```

เปิด `http://localhost:3000` แล้ว

1. โหลดโมเดล **`ur3.glb`** (UR3 + gripper RG2 — อยู่ที่รากโปรเจกต์)
2. Open project → **`ur3_default.dtwp`** ได้ mapping ครบ 6 ข้อทันที
3. กด Connect — WebSocket พอร์ต **9001** ไม่ใช่ 1883

`ur3_default.dtwp` ผูก joint ทั้ง 6 ไว้กับ topic `ur/telemetry` path `actual_q[0]` ถึง `actual_q[5]` แล้ว
ถ้าจะตั้งเองก็ใช้ค่าเดียวกันนี้

> ⚠️ **ข้อ 6 (Wrist 3) ต้องตั้งเป็น `continuous`** หรือขยาย min เป็น −9.5
> ข้อมูลจริงส่ง `actual_q[5] ≈ −8.19 rad` (ข้อมือหมุนเกินหนึ่งรอบตาม convention ของหุ่นจริง)
> ถ้าปล่อยเป็น `revolute` ที่ ±6.29 ค่าจะโดน clamp แล้วข้อมือผิดท่าไป 1.9 rad โดยไม่มี error เตือน

---

## เดโมด้วยข้อมูลหุ่นจริง

เปิด 3 หน้าต่าง

```bash
npx serve .
```

```bash
cd ai && python predict_mqtt.py
```

```bash
cd ai && python replay.py --run-id friction_band_001 --loop
```

run ที่แนะนำ — `friction_band_001` `speed_30_001` `speed_100_001` (โมเดลแม่น 100%)
**เลี่ยง** `friction_push_*` และ `payload_heavy_drop_*` ซึ่งเป็นจุดบอดของโมเดล

### เก็บ log

```bash
cd ai && python predict_mqtt.py --minutes 120 --quiet --log session.csv --save summary.json
```

ได้ CSV 30 คอลัมน์ (คำทำนายดิบ + หลังโหวต + ความน่าจะเป็น 8 คลาส + แรง + กระแส +
อุณหภูมิ 6 ข้อ + คลาดเคลื่อน 6 ข้อ) และสรุปเป็นช่วงเหตุการณ์

---

## โครงสร้าง

```
app.js  index.html  styles.css     หน้าเว็บ Three.js
ur3.glb                             โมเดล UR3 + RG2 (36 nodes)
ur3_default.dtwp                    mapping 6 joint พร้อมใช้
backend/                            Node API + logger
ai/
  replay.py                         เล่นข้อมูลหุ่นจริงจาก DB เข้า MQTT
  predict_mqtt.py                   ฟัง MQTT → ทำนาย → สรุปเป็นช่วงเหตุการณ์
  predict_live.py                   ทำนายจาก RTDE ตรงๆ (ต่อ URSim)
  ur3_publisher.py                  RTDE → MQTT
  train_rf.py                       เทรนโมเดลของเราเอง
analysis/                           สคริปต์วิเคราะห์ + ผลลัพธ์ (ดู README ข้างใน)
Model_RF_v2/                        โมเดล 8 คลาส
```

## เอกสารเพิ่มเติม

- `analysis/README.md` — ตัวเลขทุกตัวในรายงานมาจากคำสั่งไหน
- `ai/FRIEND_SYSTEM.md` — สเปกระบบต้นทางของข้อมูล
