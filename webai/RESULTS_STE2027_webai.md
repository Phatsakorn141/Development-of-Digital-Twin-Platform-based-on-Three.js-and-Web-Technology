# ผลการทดลอง: การรัน AI ตรวจจับความผิดปกติ UR3 บนเว็บ Digital Twin (STE2027)

> In-browser inference ด้วย ONNX Runtime Web (WASM) บนแพลตฟอร์ม Digital Twin (three.js)
> โมเดล: Random Forest 8 คลาส (Model_RF_v2) · ชุดทดสอบจริง 4,374 หน้าต่าง (125 สเต็ป × 23 ช่อง)
> เครื่องมือวัด: โมดูล `webai.mjs` (Correctness / Auto-bench / Stress sweep)
> อัปเดต: 29 ตุลาคม 2569

---

## สรุปสั้น (Key findings)
1. **ความถูกต้องตรงกับ Python 100%** — เบราว์เซอร์ทำนายเหมือนระบบ Python ที่ deploy อยู่ทุกหน้าต่าง (agreement 100%, L∞ = 0) accuracy 95.27%, macro-F1 0.912 เท่าเดิมเป๊ะ
2. **เร็วมากและไม่กระทบภาพ 3D** — inference ~0.37 ms/หน้าต่าง, FPS คงที่ ~180, Total Blocking Time = 0, Long Tasks = 0
3. **ไม่จำเป็นต้องใช้ Web Worker** — รันบน main thread เพียงพอ ไม่ทำให้เฟรมกระตุก; Worker กลับเพิ่ม latency (p95 0.5 → 3.1 ms) โดยไม่ได้ช่วยเรื่องการเรนเดอร์
4. **รองรับโหลดสูง** — ป้อนข้อมูลได้ถึงเพดาน scheduler (~186/s) โดย FPS ไม่ตก (ของจริง UR3 = 2/s ที่ stride 62)
5. **คอขวดเดียว: เวลาโหลดโมเดลครั้งแรก (TTFI ≈ 19.5 วินาที)** จากขนาดโมเดล RF ~108 MB → แก้ด้วย rf_small เป็นงานต่อไป

---

## 1. Correctness — Exp 1-G (เทียบ browser vs Python reference)
ชุดทดสอบจริง 4,374 หน้าต่าง (ข้อมูลจริงล้วน, payload_normal รวมเข้า normal เป็น 8 คลาส)
Reference สร้างด้วย feature pipeline เดียวกับเบราว์เซอร์ (guarded skew/kurt บนช่องเกือบคงที่)

| ตัวชี้วัด | ค่า |
|---|---|
| จำนวนหน้าต่าง (n) | 4,374 |
| **Top-1 agreement (web vs Python)** | **100.00 %** |
| **L∞ ของ probability** | **0.000** |
| **Accuracy** | **0.9527** |
| **Macro-F1** | **0.912** |

**Per-class F1**

| คลาส | F1 |
|---|---|
| speed_100 | 1.000 |
| friction | 0.9946 |
| speed_30 | 0.9993 |
| gripper_low | 0.9778 |
| payload_forced_drop | 0.9662 |
| normal | 0.9362 |
| payload_heavy | 0.8502 |
| payload_heavy_drop (คลาสหายาก) | 0.5714 |

**ความสับสนเด่น (Top confusions):** normal→payload_heavy (134), payload_forced_drop→normal (16), payload_heavy→normal (14), normal→gripper_low (10)

> **สรุป 1-G:** การ deploy บนเบราว์เซอร์ให้ผลลัพธ์เทียบเท่าระบบ Python ทุกประการ (100% เหมือนกัน, L∞ = 0) ยืนยันว่า ONNX Runtime Web + feature pipeline ฝั่ง JS ให้ความถูกต้องเท่ากับต้นฉบับ

---

## 2. Latency / Throughput / Real-Time Factor — Exp A, F
Auto-bench 60 วินาที อัตราป้อนข้อมูลจริง (UR3 @125 Hz, stride 62 → ~2 หน้าต่าง/วินาที)

| ตัวชี้วัด | Main thread | Web Worker |
|---|---|---|
| จำนวน inference | 249 | 249 |
| mean latency (ms) | **0.368** | 0.811 |
| p50 (ms) | 0.4 | 0.5 |
| p95 (ms) | **0.5** | 3.1 |
| p99 (ms) | **0.6** | 3.8 |
| Real-Time Factor (RTF) | **543.7×** | 246.5× |
| latency drift (ms/s) | −0.0006 | 0.0014 |

> **สรุป A/F:** inference เร็วกว่าเวลาจริงที่ต้องการ ~540 เท่า (RTF ≫ 1 = เรียลไทม์สบาย ๆ) · latency drift ≈ 0 = เสถียร ไม่ช้าลงเมื่อเวลาผ่านไป · Worker ทำ p95 แย่กว่าเพราะต้นทุน postMessage

---

## 3. ผลกระทบต่อการเรนเดอร์ 3D (จุดขายของงาน) — Exp B
วัด FPS, frame time, Long Tasks, Total Blocking Time ระหว่าง inference ทำงานบนหน้า Digital Twin

| ตัวชี้วัด | Main thread | Web Worker |
|---|---|---|
| mean FPS | **180.0** | 178.5 |
| 1%-low FPS | 96.2 | 97.1 |
| frame time p95 (ms) | 8.6 | 8.3 |
| frame time p99 (ms) | 10.4 | 10.3 |
| **Long Tasks** | **0** | 0 |
| **Total Blocking Time (ms)** | **0** | 0 |

> **สรุป B:** การรัน inference ไม่ทำให้ภาพ 3D กระตุกเลย — FPS ยังอยู่ ~180, ไม่มี Long Task, TBT = 0 ทั้งสองโหมด → **ยืนยันว่า in-browser inference ไม่รบกวนการเรนเดอร์ Digital Twin** และ **ไม่จำเป็นต้องย้ายไป Web Worker**

---

## 4. Stress sweep — ทดสอบที่อัตราป้อนข้อมูลสูง (Exp A ต่อเนื่อง)
ไล่อัตราป้อน 5 → 1000 หน้าต่าง/วินาที (12 วินาที/ระดับ)

| โหมด | เป้าหมาย (/s) | ทำได้จริง (/s) | inf p50 | inf p95 | mean FPS | 1%-low FPS | TBT |
|---|---|---|---|---|---|---|---|
| main | 5 | 5.1 | 0.4 | 0.5 | 180.8 | 96.2 | 0 |
| main | 50 | 49.1 | 0.3 | 0.5 | 176.1 | 101 | 0 |
| main | 200 | 186.6 | 0.3 | 0.5 | 177.5 | 99 | 0 |
| main | 500 | 185.6 | 0.3 | 0.5 | 177.3 | 97.1 | 0 |
| main | 1000 | 184.3 | 0.3 | 0.5 | 178.4 | 99 | 0 |
| worker | 5 | 5.1 | 0.5 | 1.5 | 194.4 | 84 | 0 |
| worker | 50 | 48.5 | 0.5 | 2.5 | 202.5 | 80 | 0 |
| worker | 200 | 178.6 | 0.5 | 1.5 | 202.3 | 80.6 | 0 |
| worker | 500 | 395.5 | 0.4 | 1.4 | 205.5 | 80 | 0 |
| worker | 1000 | 680.9 | 0.8 | 2.6 | 0* | 0* | 0 |

\* worker @1000/s: FPS อ่านได้ 0 เพราะเธรดหลักวัดเฟรมไม่ทัน (artifact การวัด ไม่ใช่เฟรมค้างจริง)

> **สรุป stress:** main thread ชนเพดาน event-loop ที่ ~186/s โดย FPS และ latency ไม่เสื่อม (TBT = 0 ตลอด) · Worker ดัน throughput ได้สูงกว่า (ถึง ~680/s) แต่แลกกับ latency ที่สูงขึ้น · **ที่อัตราจริงของ UR3 (~2/s) ทั้งสองโหมดเหลือ headroom มหาศาล**

---

## 5. Memory (เสถียรภาพระยะสั้น) — Exp C
วัดด้วย `performance.memory` (Chromium) ระหว่าง Auto-bench 60 วินาที

| ตัวชี้วัด | Main thread | Web Worker |
|---|---|---|
| start (MB) | 39.5 | 43.9 |
| end (MB) | 46.4 | 53.4 |
| leak rate (MB/s) | 0.092 | 0.119 |

> หมายเหตุ: ตัวเลขนี้เป็นช่วง 60 วินาที อาจรวม GC ที่ยังไม่เกิด — ต้องทำ **soak test** ยาวขึ้น (เช่น 30–60 นาที) เพื่อยืนยันว่าไม่มี memory leak จริง (งานต่อไป)

---

## 6. Time-to-First-Inference (TTFI) — Exp C
| ตัวชี้วัด | ค่า |
|---|---|
| **TTFI** | **≈ 19,464  ms (~19.5 วินาที)** |

คอขวดหลัก = การ initialize session ของโมเดล RF ขนาด ~108 MB (ไม่ใช่การโหลด ORT runtime)
→ **แนวทางแก้ (future work): rf_small** — ลดจำนวน/ความลึกของต้นไม้ หรือ quantize เพื่อลดขนาดโมเดลและเวลาโหลด

---

## 7. สรุปภาพรวมเทียบ Main vs Worker

| ด้าน | ผู้ชนะ | เหตุผล |
|---|---|---|
| ความถูกต้อง | เสมอ | 100% เท่ากัน |
| latency (p95/p99) | **Main** | Worker เพิ่มต้นทุน postMessage |
| ผลกระทบต่อ FPS | เสมอ | TBT = 0 ทั้งคู่ |
| throughput สูงสุด | Worker | แต่ไม่จำเป็นที่อัตราจริง |
| ความเรียบง่าย | **Main** | ไม่ต้องจัดการเธรด |

> **ข้อสรุปเชิงออกแบบ:** สำหรับงานนี้ (RF เบา + อัตราข้อมูลต่ำ) **main-thread inference คือทางเลือกที่เหมาะสมที่สุด** — ถูกต้อง เร็ว ไม่กระตุกภาพ และโค้ดเรียบง่าย ส่วน Web Worker เหมาะเฉพาะกรณีโมเดลหนักหรือ throughput สูงมากเท่านั้น

---

## 8. สถานะตัวชี้วัดสำหรับ paper
| Exp | ตัวชี้วัด | สถานะ |
|---|---|---|
| 1-G | Correctness (full test set) | ✅ เสร็จ — 100%, acc 0.9527, macro-F1 0.912 |
| A | Throughput / RTF / stress | ✅ เสร็จ |
| B | FPS / Long Tasks / TBT | ✅ เสร็จ |
| C | TTFI / memory (ช่วงสั้น) | ✅ เสร็จ (memory ควรยืนยันด้วย soak) |
| F | Latency p50/95/99 + สถิติ | ✅ เสร็จ |
| ค | Soak test ระยะยาว | ⏳ ยังไม่ทำ |
| 1-H | Ablation (no-aug vs SMOTE) + McNemar | ⏳ ต้องเทรน baseline ก่อน |
| D | Cross-browser | ⏳ ยังไม่ทำ |
