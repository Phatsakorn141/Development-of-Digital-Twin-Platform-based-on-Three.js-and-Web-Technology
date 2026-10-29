# ผลการทดลองรวม: การรัน AI ตรวจจับความผิดปกติ UR3 บนเว็บ Digital Twin (STE2027)

> In-browser inference ด้วย ONNX Runtime Web (WASM) บนแพลตฟอร์ม Digital Twin (three.js)
> โมเดล: Random Forest 8 คลาส (Model_RF_v2) · ชุดทดสอบจริง 4,374 หน้าต่าง (125 สเต็ป × 23 ช่อง)
> ทดสอบข้าม 3 เบราว์เซอร์ (2 engine): **Chrome / Edge (Blink)** และ **Firefox (Gecko)**
> เครื่องมือวัด: โมดูล `webai.mjs` (Correctness / Auto-bench / Stress sweep)
> อัปเดต: 29 ตุลาคม 2569

---

## สรุปสั้น (Key findings)
1. **ความถูกต้องตรงกับ Python 100% ทุกเบราว์เซอร์** — agreement 100%, L∞ = 0, accuracy 95.27%, macro-F1 0.912 เท่าเดิมเป๊ะ ไม่ขึ้นกับ engine
2. **เร็วมากและไม่กระทบภาพ 3D** — inference ~0.37 ms/หน้าต่าง, Total Blocking Time = 0, Long Tasks = 0 ทุกเบราว์เซอร์
3. **ไม่จำเป็นต้องใช้ Web Worker** — main thread เพียงพอ; Worker กลับเพิ่ม latency (p95 0.5 → 3.1 ms) โดยไม่ได้ช่วยเรื่องการเรนเดอร์
4. **รองรับโหลดสูง** — ป้อนข้อมูลได้ถึงเพดาน scheduler (~186/s) โดย FPS ไม่ตก (ของจริง UR3 = ~2/s)
5. **Cross-platform สม่ำเสมอ** — ความแตกต่างที่พบทั้งหมด (อัตราเฟรม, ความละเอียดเวลา, การอ่าน memory) เป็นนโยบายของเบราว์เซอร์ ไม่ใช่ภาระจาก inference
6. **คอขวดเดียว: เวลาโหลดโมเดลครั้งแรก (TTFI ≈ 19–24 วินาที)** จากขนาดโมเดล RF ~108 MB → แก้ด้วย rf_small เป็นงานต่อไป

---

## 1. Correctness — Exp 1-G (เทียบ browser vs Python reference)
ชุดทดสอบจริง 4,374 หน้าต่าง (ข้อมูลจริงล้วน, payload_normal รวมเข้า normal เป็น 8 คลาส)
Reference สร้างด้วย feature pipeline เดียวกับเบราว์เซอร์ (guarded skew/kurt บนช่องเกือบคงที่)

| ตัวชี้วัด | Chrome | Edge | Firefox |
|---|---|---|---|
| จำนวนหน้าต่าง (n) | 4,374 | 4,374 | 4,374 |
| **Top-1 agreement** | **100.00 %** | 100.00 % | 100.00 % |
| **L∞ ของ probability** | **0.000** | 0.000 | 0.000 |
| **Accuracy** | **0.9527** | 0.9527 | 0.9527 |
| **Macro-F1** | **0.912** | 0.912 | 0.912 |

**Per-class F1** (เหมือนกันทั้ง 3 เบราว์เซอร์)

| คลาส | F1 |
|---|---|
| speed_100 | 1.000 |
| speed_30 | 0.9993 |
| friction | 0.9946 |
| gripper_low | 0.9778 |
| payload_forced_drop | 0.9662 |
| normal | 0.9362 |
| payload_heavy | 0.8502 |
| payload_heavy_drop (คลาสหายาก) | 0.5714 |

**ความสับสนเด่น (Top confusions):** normal→payload_heavy (134), payload_forced_drop→normal (16), payload_heavy→normal (14), normal→gripper_low (10)

> **สรุป 1-G:** การ deploy บนเบราว์เซอร์ให้ผลลัพธ์เทียบเท่าระบบ Python ทุกประการ (100% เหมือนกัน, L∞ = 0) และ **reproduce ได้เหมือนกันข้าม engine** → ยืนยันว่า ONNX Runtime Web + feature pipeline ฝั่ง JS ให้ความถูกต้องเท่ากับต้นฉบับ

---

## 2. Latency / Throughput / Real-Time Factor — Exp A, F
Auto-bench 60 วินาที อัตราป้อนข้อมูลจริง (UR3 @125 Hz, stride 62 → ~2 หน้าต่าง/วินาที)

**เทียบ main vs worker (บน Chrome)**

| ตัวชี้วัด | Main thread | Web Worker |
|---|---|---|
| mean latency (ms) | **0.368** | 0.811 |
| p50 / p95 / p99 (ms) | 0.4 / **0.5** / **0.6** | 0.5 / 3.1 / 3.8 |
| Real-Time Factor (RTF) | **543.7×** | 246.5× |
| latency drift (ms/s) | −0.0006 | 0.0014 |

**เทียบข้ามเบราว์เซอร์ (main thread)**

| ตัวชี้วัด | Chrome | Edge | Firefox |
|---|---|---|---|
| mean latency (ms) | 0.368 | 0.366 | 0.415 |
| p50 / p95 / p99 (ms) | 0.4 / 0.5 / 0.6 | 0.4 / 0.5 / 0.6 | 0* / 1* / 2* |
| RTF | 543.7× | 546.7× | 481.6× |
| latency drift (ms/s) | −0.0006 | −0.0004 | −0.0007 |

\* Firefox ปัดเวลาเป็นหน่วย ~1 ms (ลดความละเอียด `performance.now()` กันช่องโหว่ Spectre) จึงเห็นเป็นเลขจำนวนเต็ม — ค่าจริงใกล้เคียง Chrome/Edge

> **สรุป A/F:** inference เร็วกว่าเวลาจริงที่ต้องการ ~480–550 เท่า (RTF ≫ 1 = เรียลไทม์สบาย) · latency drift ≈ 0 = เสถียร · Worker ทำ p95 แย่กว่าเพราะต้นทุน postMessage · Chrome กับ Edge เท่ากันแทบเป๊ะ (engine เดียวกัน)

---

## 3. ผลกระทบต่อการเรนเดอร์ 3D (จุดขายของงาน) — Exp B
วัด FPS, frame time, Long Tasks, Total Blocking Time ระหว่าง inference ทำงานบนหน้า Digital Twin

| ตัวชี้วัด | Chrome | Edge | Firefox |
|---|---|---|---|
| mean FPS | ~180 (อิสระ) | 150.0 | ~60 (ล็อก vsync)† |
| 1%-low FPS | 96.2 | 107.5 | 58.8 |
| frame time p95 (ms) | 8.6 | 8.1 | 16 |
| frame time p99 (ms) | 10.4 | 9.3 | 17 |
| **Long Tasks** | **0** | 0 | 0 |
| **Total Blocking Time (ms)** | **0** | 0 | 0 |

† Firefox ล็อกเฟรมตามอัตรารีเฟรชจอ (vsync) ขณะที่ Chrome/Edge ปล่อยเฟรมอิสระ — ทั้งหมด**ภาพลื่น ไม่มี Long Task และ TBT = 0**

> **สรุป B:** การรัน inference ไม่ทำให้ภาพ 3D กระตุกเลยทุกเบราว์เซอร์ (TBT = 0, Long Tasks = 0) → **ยืนยันว่า in-browser inference ไม่รบกวนการเรนเดอร์ Digital Twin** และ **ไม่จำเป็นต้องย้ายไป Web Worker** · ความต่างของ FPS ดิบมาจากนโยบายจำกัดเฟรมของเบราว์เซอร์ ไม่ใช่โหลดจาก AI

---

## 4. Stress sweep — ทดสอบที่อัตราป้อนข้อมูลสูง (Exp A ต่อเนื่อง, บน Chrome)
ไล่อัตราป้อน 5 → 1000 หน้าต่าง/วินาที (12 วินาที/ระดับ)

| โหมด | เป้าหมาย (/s) | ทำได้จริง (/s) | inf p50 | inf p95 | mean FPS | 1%-low FPS | TBT |
|---|---|---|---|---|---|---|---|
| main | 5 | 5.1 | 0.4 | 0.5 | 180.8 | 96.2 | 0 |
| main | 50 | 49.1 | 0.3 | 0.5 | 176.1 | 101 | 0 |
| main | 200 | 186.6 | 0.3 | 0.5 | 177.5 | 99 | 0 |
| main | 500 | 185.6 | 0.3 | 0.5 | 177.3 | 97.1 | 0 |
| main | 1000 | 184.3 | 0.3 | 0.5 | 178.4 | 99 | 0 |
| worker | 200 | 178.6 | 0.5 | 1.5 | 202.3 | 80.6 | 0 |
| worker | 500 | 395.5 | 0.4 | 1.4 | 205.5 | 80 | 0 |
| worker | 1000 | 680.9 | 0.8 | 2.6 | 0* | 0* | 0 |

\* worker @1000/s: FPS อ่านได้ 0 เพราะเธรดหลักวัดเฟรมไม่ทัน (artifact การวัด ไม่ใช่เฟรมค้างจริง)

> **สรุป stress:** main thread ชนเพดาน event-loop ที่ ~186/s โดย FPS และ latency ไม่เสื่อม (TBT = 0 ตลอด) · Worker ดัน throughput ได้สูงกว่า (ถึง ~680/s) แต่แลกกับ latency ที่สูงขึ้น · **ที่อัตราจริงของ UR3 (~2/s) เหลือ headroom มหาศาล**

---

## 5. Memory (เสถียรภาพระยะสั้น) — Exp C
วัดด้วย `performance.memory` (Chromium เท่านั้น) ระหว่าง Auto-bench 60 วินาที

| ตัวชี้วัด | Chrome | Edge (run A / B) | Firefox |
|---|---|---|---|
| samples | 30 | 30 | 0 |
| leak rate (MB/s) | 0.092 | +0.187 / −0.286 | ไม่มีข้อมูล |

> ค่า leak แกว่งทั้งบวกและลบระหว่างรอบ (Edge รอบหนึ่ง start 95→end 48 MB) = เป็นจังหวะ **garbage collection** ไม่ใช่ leak จริง · Firefox ไม่รองรับ `performance.memory` (ค่า 0 เป็นปกติ) · **ต้องทำ soak test ยาว (30–60 นาที) บน Chrome/Edge เพื่อยืนยัน slope ระยะยาว** (งานต่อไป)

---

## 6. Time-to-First-Inference (TTFI) — Exp C
| | Chrome | Edge | Firefox |
|---|---|---|---|
| **TTFI** | **≈ 19,464 ms** | ≈ 23,826 ms | ≈ 23,466 ms |

คอขวดหลัก = การ initialize session ของโมเดล RF ขนาด ~108.2 MB (ไม่ใช่การโหลด ORT runtime) เหมือนกันทุกเบราว์เซอร์
→ **แนวทางแก้ (future work): rf_small** — ลดจำนวน/ความลึกของต้นไม้ หรือ quantize เพื่อลดขนาดโมเดลและเวลาโหลด

---

## 7. สรุป Main vs Worker

| ด้าน | ผู้ชนะ | เหตุผล |
|---|---|---|
| ความถูกต้อง | เสมอ | 100% เท่ากัน |
| latency (p95/p99) | **Main** | Worker เพิ่มต้นทุน postMessage |
| ผลกระทบต่อ FPS | เสมอ | TBT = 0 ทั้งคู่ |
| throughput สูงสุด | Worker | แต่ไม่จำเป็นที่อัตราจริง |
| ความเรียบง่าย | **Main** | ไม่ต้องจัดการเธรด |

> **ข้อสรุปเชิงออกแบบ:** สำหรับงานนี้ (RF เบา + อัตราข้อมูลต่ำ) **main-thread inference คือทางเลือกที่เหมาะสมที่สุด** — ถูกต้อง เร็ว ไม่กระตุกภาพ และโค้ดเรียบง่าย ส่วน Web Worker เหมาะเฉพาะกรณีโมเดลหนักหรือ throughput สูงมากเท่านั้น

---

## 8. สรุป Cross-Browser (Exp D) — Chrome vs Edge vs Firefox

| ตัวชี้วัด | Chrome (Blink) | Edge (Blink) | Firefox (Gecko) |
|---|---|---|---|
| Correctness agreement | 100 % | 100 % | 100 % |
| Accuracy / Macro-F1 | 0.9527 / 0.912 | 0.9527 / 0.912 | 0.9527 / 0.912 |
| latency p95 (ms) | 0.5 | 0.5 | 1* |
| RTF | 543× | 547× | 482× |
| mean FPS | ~180 | 150 | ~60 (vsync) |
| Long Tasks / TBT | 0 / 0 | 0 / 0 | 0 / 0 |
| TTFI (s) | 19.5 | 23.8 | 23.5 |
| memory profiling | ✅ | ✅ | ✗ (ไม่มี API) |

> **บทสรุป cross-browser:** โมเดลให้ **ความถูกต้องเหมือนกันทุกเบราว์เซอร์ (100%)** และ **ไม่กระทบการเรนเดอร์ (TBT = 0) ทั้ง 2 engine** ความแตกต่างที่พบทั้งหมดเป็นคุณสมบัติของเบราว์เซอร์เอง ไม่ใช่ภาระจาก inference → ยืนยันความพร้อมใช้งานจริงแบบ cross-platform

---

## 9. สถานะตัวชี้วัดสำหรับ paper
| Exp | ตัวชี้วัด | สถานะ |
|---|---|---|
| 1-G | Correctness (full test set) | ✅ เสร็จ — 100%, acc 0.9527, macro-F1 0.912 (ทุกเบราว์เซอร์) |
| A | Throughput / RTF / stress | ✅ เสร็จ |
| B | FPS / Long Tasks / TBT | ✅ เสร็จ |
| C | TTFI / memory (ช่วงสั้น) | ✅ เสร็จ (memory ควรยืนยันด้วย soak) |
| F | Latency p50/95/99 + สถิติ | ✅ เสร็จ |
| **D** | **Cross-browser (Blink + Gecko)** | ✅ **เสร็จ — Chrome / Edge / Firefox** |
| ค | Soak test ระยะยาว | ⏳ ยังไม่ทำ (รอเพิ่มปุ่ม soak) |
| 1-H | Ablation (no-aug vs SMOTE) + McNemar | ⏳ ต้องเทรน baseline ก่อน |
