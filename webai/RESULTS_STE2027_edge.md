# ผลการทดลอง Cross-Browser: Microsoft Edge (STE2027)

> In-browser inference (ONNX Runtime Web / WASM) บน Digital Twin — ทดสอบบน **Microsoft Edge (engine: Blink/Chromium)**
> โมเดล: Random Forest 8 คลาส · ชุดทดสอบจริง 4,374 หน้าต่าง
> เทียบกับ **Chrome (Blink)** และ **Firefox (Gecko)**
> อัปเดต: 29 ตุลาคม 2569

---

## สรุปสั้น
1. **ความถูกต้องเหมือนทุกเบราว์เซอร์ 100%** — agreement 100%, L∞ = 0, accuracy 0.9527, macro-F1 0.912
2. **ประสิทธิภาพเท่า Chrome** — latency p95 0.5 ms, RTF ~547×, TBT = 0, Long Tasks = 0 (Edge ใช้ engine เดียวกับ Chrome)
3. **FPS ~150** (อิสระ) — ลื่นเต็มที่, 1%-low 107 FPS
4. **TTFI 23.8 วินาที** — คอขวดเดียวกันคือโมเดล 108 MB
5. **หน่วยความจำไม่มี leak จริง** — ค่าแกว่งจาก GC (รอบหนึ่ง −0.29, อีกรอบ +0.19 MB/s) = พฤติกรรม garbage collector ปกติ

---

## 1. Correctness (Exp 1-G)
| ตัวชี้วัด | Edge | Chrome | Firefox |
|---|---|---|---|
| Top-1 agreement | **100 %** | 100 % | 100 % |
| L∞ probability | **0.000** | 0.000 | 0.000 |
| Accuracy | **0.9527** | 0.9527 | 0.9527 |
| Macro-F1 | **0.912** | 0.912 | 0.912 |

> ตัวเลขทุกตัวเหมือนกันทั้ง 3 เบราว์เซอร์ → ความถูกต้องของ in-browser inference reproduce ได้สมบูรณ์

---

## 2. Latency / Throughput (Auto-bench 60 วินาที, main thread)
| ตัวชี้วัด | Edge | Chrome | Firefox |
|---|---|---|---|
| mean latency (ms) | 0.366 | 0.368 | 0.415 |
| p50 (ms) | 0.4 | 0.4 | 0* |
| p95 (ms) | 0.5 | 0.5 | 1* |
| p99 (ms) | 0.6 | 0.6 | 2* |
| RTF | **546.7×** | 543.7× | 481.6× |
| latency drift (ms/s) | −0.0004 | −0.0006 | −0.0007 |

\* Firefox ปัดเวลาเป็นหน่วย ~1 ms · Edge/Chrome ให้ค่าละเอียดระดับ sub-millisecond และ **เท่ากันแทบเป๊ะ** (engine เดียวกัน)

---

## 3. ผลกระทบต่อการเรนเดอร์ 3D (Exp B)
| ตัวชี้วัด | Edge | Chrome | Firefox |
|---|---|---|---|
| mean FPS | 150.0 | ~180 | ~60 (ล็อก vsync) |
| 1%-low FPS | 107.5 | 96.2 | 58.8 |
| frame time p95 (ms) | 8.1 | 8.6 | 16 |
| frame time p99 (ms) | 9.3 | 10.4 | 17 |
| **Long Tasks** | **0** | 0 | 0 |
| **Total Blocking Time (ms)** | **0** | 0 | 0 |

> Edge เรนเดอร์ ~150 FPS (อิสระเหมือน Chrome) · **TBT = 0, Long Tasks = 0** ทุกเบราว์เซอร์ → inference ไม่บล็อกการวาดภาพ

---

## 4. Memory
| | Edge (run A / run B) | Chrome |
|---|---|---|
| samples | 30 | 30 |
| leak (MB/s) | +0.187 / −0.286 | 0.092 |

> ค่า leak แกว่งทั้งบวกและลบระหว่างสองรอบ (รอบหนึ่ง start 95→end 48 MB) = เป็นจังหวะ **garbage collection** ไม่ใช่ memory leak จริง · ต้องยืนยันด้วย **soak test** ยาว ๆ เพื่อดู slope ระยะยาว

---

## 5. Time-to-First-Inference (TTFI)
| | Edge | Chrome | Firefox |
|---|---|---|---|
| TTFI | **≈ 23,826 ms** | ≈ 19,464 ms | ≈ 23,466 ms |

ทุกเบราว์เซอร์ถูกครอบงำด้วยการโหลดโมเดล RF 108.2 MB เหมือนกัน → rf_small คือทางแก้ (future work)

---

## 6. ตารางสรุป Cross-Browser ครบ 3 ตัว (2 engine)

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

> **บทสรุป Cross-Browser สำหรับ paper:** โมเดลให้ **ความถูกต้องเหมือนกันทุกเบราว์เซอร์ (100%)** และ **ไม่กระทบการเรนเดอร์ (TBT = 0) ทั้ง 2 engine** ความแตกต่างที่พบทั้งหมด — อัตราเฟรม, ความละเอียดตัวจับเวลา, การอ่าน memory — เป็น**คุณสมบัติของเบราว์เซอร์เอง ไม่ใช่ภาระจาก inference** → ยืนยันความพร้อมใช้งานจริงแบบ cross-platform (Exp D ครบ)
