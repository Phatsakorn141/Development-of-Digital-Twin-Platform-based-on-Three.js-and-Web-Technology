# ผลการทดลอง Cross-Browser: Firefox (STE2027)

> In-browser inference (ONNX Runtime Web / WASM) บน Digital Twin — ทดสอบบน **Mozilla Firefox (engine: Gecko)**
> โมเดล: Random Forest 8 คลาส · ชุดทดสอบจริง 4,374 หน้าต่าง
> เทียบกับผลเดิมบน **Google Chrome (engine: Blink/Chromium)**
> อัปเดต: 29 ตุลาคม 2569

---

## สรุปสั้น
1. **ความถูกต้องเหมือน Chrome 100%** — agreement 100%, L∞ = 0, accuracy 0.9527, macro-F1 0.912 (เท่ากันทุกตัวเลข) → ยืนยันว่า ONNX Runtime Web ให้ผลเหมือนกันข้าม engine
2. **ไม่กระทบการเรนเดอร์** — Long Tasks = 0, Total Blocking Time = 0 เหมือน Chrome
3. **Firefox ล็อก ~60 FPS (vsync)** ต่างจาก Chrome ที่ปล่อยอิสระ ~180 FPS — ทั้งคู่ภาพลื่นไม่กระตุก
4. **ความละเอียดตัวจับเวลาหยาบกว่า** — Firefox ปัดเป็นหน่วย ~1 ms (กันช่องโหว่ Spectre) ทำให้ latency รายงานเป็นเลขจำนวนเต็ม แต่ยังอยู่ระดับต่ำกว่า 2 ms
5. **TTFI ใกล้เคียง** — 23.5 วินาที (Chrome 19.5 วินาที) คอขวดเดียวกันคือขนาดโมเดล 108 MB

---

## 1. Correctness (Exp 1-G) — เทียบ browser vs Python
| ตัวชี้วัด | Firefox | Chrome | ตรงกัน? |
|---|---|---|---|
| n | 4,374 | 4,374 | ✅ |
| Top-1 agreement | **100.00 %** | 100.00 % | ✅ |
| L∞ probability | **0.000** | 0.000 | ✅ |
| Accuracy | **0.9527** | 0.9527 | ✅ |
| Macro-F1 | **0.912** | 0.912 | ✅ |

Per-class F1 เหมือนกันทุกคลาส: speed_100 1.000 · friction 0.9946 · speed_30 0.9993 · gripper_low 0.9778 · payload_forced_drop 0.9662 · normal 0.9362 · payload_heavy 0.8502 · payload_heavy_drop 0.5714

> **สรุป:** ผลการทำนายเหมือนกันทุกประการข้าม engine → in-browser inference ให้ความถูกต้องที่ reproduce ได้ ไม่ขึ้นกับเบราว์เซอร์

---

## 2. Latency / Throughput (Auto-bench 60 วินาที, main thread)
| ตัวชี้วัด | Firefox | Chrome |
|---|---|---|
| mean latency (ms) | 0.415 | 0.368 |
| p50 (ms) | 0* | 0.4 |
| p95 (ms) | 1* | 0.5 |
| p99 (ms) | 2* | 0.6 |
| RTF | 481.6× | 543.7× |
| latency drift (ms/s) | −0.0007 | −0.0006 |

\* Firefox ปัดเวลาเป็นหน่วย ~1 ms (ลดความละเอียด `performance.now()` เพื่อความปลอดภัย) จึงเห็นเป็นเลขจำนวนเต็ม — ค่าจริงใกล้เคียง Chrome (sub-millisecond)

> **สรุป:** inference เร็วระดับเดียวกัน (RTF ~480× = เรียลไทม์สบาย) · ตัวเลข p50/p95 ที่ดูต่างเกิดจากความละเอียดตัวจับเวลา ไม่ใช่โมเดลช้าลง

---

## 3. ผลกระทบต่อการเรนเดอร์ 3D (Exp B)
| ตัวชี้วัด | Firefox | Chrome |
|---|---|---|
| mean FPS | ~60 (ล็อก vsync)† | ~180 (อิสระ) |
| 1%-low FPS | 58.8 | 96.2 |
| frame time p95 (ms) | 16 | 8.6 |
| frame time p99 (ms) | 17 | 10.4 |
| **Long Tasks** | **0** | 0 |
| **Total Blocking Time (ms)** | **0** | 0 |

† Firefox ไม่รายงาน mean_fps (null) แต่ frame time p95 = 16 ms ≈ 60 FPS คงที่ (Firefox ล็อกที่อัตรารีเฟรชจอตามค่าเริ่มต้น ขณะที่ Chrome ปล่อยเฟรมอิสระ) — **ทั้งคู่ภาพลื่น ไม่มี Long Task และ TBT = 0**

> **สรุป:** ความต่างของ FPS มาจาก "นโยบายการจำกัดเฟรมของเบราว์เซอร์" ไม่ใช่โหลดจาก inference · 1%-low 58.8 FPS บน Firefox = ยังลื่นไหลเต็มที่ · สิ่งสำคัญคือ TBT = 0 → inference ไม่บล็อกการวาดภาพทั้งสอง engine

---

## 4. Memory
| | Firefox | Chrome |
|---|---|---|
| samples | 0 | 30 |
| leak (MB/s) | ไม่มีข้อมูล | 0.092 |

> Firefox ไม่รองรับ `performance.memory` (เป็น API เฉพาะ Chromium) จึงอ่านหน่วยความจำไม่ได้ — ค่า 0 เป็นเรื่องปกติ ไม่ใช่บั๊ก การวัด memory leak ต้องทำบน Chrome/Edge เท่านั้น

---

## 5. Time-to-First-Inference (TTFI)
| | Firefox | Chrome |
|---|---|---|
| TTFI | **≈ 23,466 ms** | ≈ 19,464 ms |

ทั้งสองถูกครอบงำด้วยการโหลดโมเดล RF ~108.2 MB เหมือนกัน · Firefox ช้ากว่าเล็กน้อย → แก้ได้ด้วย rf_small (future work)

---

## 6. ข้อสรุป Cross-Browser (Chrome vs Firefox = Blink vs Gecko)
| ด้าน | ผลสรุป |
|---|---|
| ความถูกต้องของการทำนาย | **เหมือนกันทุกประการ** (engine-independent) |
| latency | ระดับเดียวกัน (ต่างแค่ความละเอียดตัวจับเวลา) |
| ผลกระทบต่อเฟรม | TBT = 0, Long Tasks = 0 ทั้งคู่ — ไม่กระตุก |
| FPS ดิบ | Chrome สูงกว่า (อิสระ) · Firefox ล็อก ~60 แต่ยังลื่น |
| memory profiling | ได้เฉพาะ Chromium |

> **บทสรุปสำหรับ paper:** การ deploy โมเดลบนเบราว์เซอร์ให้ **ความถูกต้องและประสิทธิภาพเรียลไทม์ที่สม่ำเสมอข้าม engine** (Blink และ Gecko) ความแตกต่างที่พบทั้งหมด (อัตราเฟรม, ความละเอียดเวลา, การอ่าน memory) มาจาก **นโยบายของเบราว์เซอร์เอง ไม่ใช่ภาระจาก inference** — ยืนยันความพร้อมใช้งานจริงแบบ cross-platform
