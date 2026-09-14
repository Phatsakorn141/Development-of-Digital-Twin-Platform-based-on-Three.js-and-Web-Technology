# analysis — สคริปต์วิเคราะห์และผลลัพธ์

ทุกตัวเลขที่อ้างในรายงานผลิตจากสคริปต์ในโฟลเดอร์นี้ รันซ้ำได้ทั้งหมด

## ต้องมีอะไรก่อนรัน

| | ใช้ทำอะไร |
|---|---|
| Docker container `friend226` | ฐานข้อมูลหุ่นจริง 2.45 ล้านแถว (พอร์ต 5433) |
| `Model_RF_v2/rf.onnx` | โมเดล 8 คลาส — **ไม่อยู่ใน git** ขอจากเพื่อน |
| Python: `psycopg2-binary numpy scipy onnxruntime` | ทุกสคริปต์ `.py` |
| Node + โปรเจกต์ `web_digitaltwin` ของเพื่อน | เฉพาะ `parity_benchmark.mjs` |

```bash
docker start friend226
pip install psycopg2-binary numpy scipy onnxruntime paho-mqtt
```

ถ้ายังไม่มี container ให้กู้จาก dump ก่อน — ดู `restore_friend_db.sh`

---

## สคริปต์

รันจาก**รากโปรเจกต์** ทุกตัว

### `eval_model.py` — ความแม่นบนข้อมูลจริง

```bash
python analysis\eval_model.py
```

วัด 612 หน้าต่างจาก 213 runs แยกผลตามชื่อ run ไม่ใช่แค่ตาม `anomaly_type`
เพราะป้ายเดียวมีหลายแบบทางกายภาพซ่อนอยู่ (`friction` = `band` / `weight` / `push`)

ผลล่าสุด **514/612 = 84.0%** · จุดบอด `friction_push` 3% และ `payload_heavy_drop` 4%

> ฐานข้อมูลยังใช้ taxonomy เก่า 11 `anomaly_type` สคริปต์แมป `payload_normal → normal`
> และข้าม `friction_push_30hz/60hz` ที่โมเดลไม่รู้จัก

### `occlusion.py` — โมเดลพึ่งช่องสัญญาณไหน

```bash
python analysis\occlusion.py
```

ปิดบังทีละช่องจาก 23 ช่อง วัดว่าความมั่นใจตกเท่าไหร่ → `results/occlusion_v2.json`
ผลหลัก: **กลุ่มแรงกินสัดส่วน 31-67%** ของการตัดสินในทุกคลาส

ค่าที่ได้ถูกฝังเป็นตาราง `MODEL_RELIANCE` ใน `app.js` ให้หน้าเว็บบอกได้ว่าโมเดลดูจากอะไร

### `thermal_forecast.py` — โจทย์ "เดิน 2 ชั่วโมงจะเกิดอะไรขึ้น"

```bash
python analysis\thermal_forecast.py
```

ฟิต `T(t) = T∞ − (T∞−T₀)·e^(−t/τ)` กับ `long_run` (44 นาทีต่อเนื่อง 327,866 แถว)

ได้ τ = 33-47 นาที · เพดาน J6 = 43.6°C · RMSE 0.008-0.013°C
**ตรวจสอบแล้ว**: ข้อมูลจริง 8 วันทำงาน (7-9 ชม./วัน) J6 สูงสุด 45.75°C — ทำนายต่ำไป 1-2°C

### `classifier_drift.py` — คำทำนายเลื่อนตามความร้อนไหม

```bash
python analysis\classifier_drift.py
```

ไล่ทำนายตลอด `long_run` ทุก 2 นาที เทียบกับอุณหภูมิที่ไต่ขึ้น
ผล: **ไม่เลื่อน** — `p(normal)` ครึ่งแรก 0.563 ครึ่งหลัง 0.555

### `parity_benchmark.mjs` — เบราว์เซอร์ให้ผลตรงกับ Python ไหม

```bash
node analysis\parity_benchmark.mjs
```

```bash
set "MODEL=rf_small.onnx" && set "REF=reference_small.json" && node analysis\parity_benchmark.mjs
```

ดัดแปลงจาก `verify_web_parity.mjs` ของเพื่อน 2 จุด — แก้ `wasmPaths` ให้เป็น `file://` URL
(ต้นฉบับรันบน Windows ไม่ได้) และเขียนผลเป็น JSON

ต้องชี้ไปที่โปรเจกต์เพื่อน ค่าเริ่มต้นคือ `C:/Users/palm/Downloads/web_digitaltwin/web_digitaltwin`
เปลี่ยนได้ด้วย `set "WEB=<path>"`

### `build_heatmap_page.py` — สร้างหน้าฮีทแมพ

```bash
cd analysis\results && python ..\build_heatmap_page.py
```

อ่าน `occlusion_v2.json` → `signal_map.html`

---

## ผลลัพธ์ใน `results/`

| ไฟล์ | คืออะไร |
|---|---|
| `occlusion_v2.json` | ความสำคัญของ 23 ช่อง × 8 คลาส |
| `parity_rf.json` | benchmark โมเดลเต็ม 108.2 MB |
| `parity_rf_small.json` | benchmark โมเดลย่อ 9.3 MB |
| `signal_map.html` | หน้าฮีทแมพ เปิดในเบราว์เซอร์ได้เลย |

---

## ⚠️ ข้อควรรู้

**โมเดลมี 2 เวอร์ชัน** — `Model_RF_v2` (8 คลาส) เป็นตัวที่ใช้อยู่ ส่วน `Model_RF` (9 คลาส) เก็บไว้เทียบ
ตัวเลขเก่าที่วัดด้วย 9 คลาสคือ 80.7% เทียบกับ 84.0% ของเวอร์ชันปัจจุบัน
เวลาอ้างตัวเลขต้องระบุเวอร์ชันเสมอ

**ข้อมูลจาก DB เพื่อนไม่ต้องปรับ `q[5] -= 2π` หรือ `z -= 0.261`** — สองบรรทัดนั้นใน `ai/predict_live.py`
เป็นการแปลง URSim → convention ของเพื่อน ข้อมูลจาก DB อยู่ใน convention นั้นอยู่แล้ว
ปรับซ้ำจะเพี้ยนโดยไม่มี error (ยืนยันจาก `scaler.npz` ที่ `MEAN[5] = -7.89`)

**13 จาก 46 คอลัมน์ในฐานข้อมูลว่างเปล่าทั้งหมด** — gripper ทั้ง 8 ช่อง กับ `actual_tcp_acceleration`
`tool_temperature` `actual_robot_energy_consumed` `collision_detection_ratio`
`joint_position_deviation_ratio` ใช้ได้จริง 33 คอลัมน์
