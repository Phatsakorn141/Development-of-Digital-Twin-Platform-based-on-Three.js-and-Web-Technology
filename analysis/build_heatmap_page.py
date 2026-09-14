import json, io, sys
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

d = json.load(open("occlusion_v2.json", encoding="utf-8"))
CH, H, BC = d["channels"], d["heat"], d["base_conf"]

ORD = ["speed_100", "speed_30", "friction", "payload_heavy",
       "payload_forced_drop", "gripper_low", "normal", "payload_heavy_drop"]
TH = {"speed_100": "เดินเร็วผิดปกติ", "speed_30": "เดินช้าผิดปกติ",
      "friction": "แรงเสียดทาน",
      "payload_heavy": "บรรทุกหนัก", "payload_forced_drop": "ของหลุดมือ",
      "gripper_low": "แรงจับต่ำ", "normal": "ปกติ",
      "payload_heavy_drop": "หนักแล้วหล่น"}

GROUPS = [("ตำแหน่งข้อ", range(0, 6), "q0–q5"),
          ("กระแสข้อ", range(6, 12), "i0–i5"),
          ("ตำแหน่ง TCP", range(12, 15), "x y z"),
          ("ความเร็ว TCP", [15], "scalar"),
          ("แรง", [16] + list(range(17, 23)), "scalar + 6 แกน")]

cells, rows = [], []
for cls in ORD:
    v = H[cls]
    mx = max(v) or 1
    tot = sum(x for x in v if x > 0) or 1e-9
    share = {g: sum(max(0, v[i]) for i in idx) / tot * 100 for g, idx, _ in GROUPS}
    top = sorted(range(23), key=lambda i: -v[i])[:3]
    rows.append((cls, v, mx, share, top))

head = "".join(f'<u>{c}</u>' for c in CH)
grid = [f'<b class="corner"></b>{head}']
for cls, v, mx, share, top in rows:
    dim = ' dim' if cls == "payload_heavy_drop" else ''
    grid.append(f'<b class="rl{dim}"><span>{TH[cls]}</span><code>{cls}</code>'
                f'<em>{BC[cls]:.2f}</em></b>')
    for i, x in enumerate(v):
        a = 0.05 + 0.95 * (max(0.0, x) / mx)
        grid.append(f'<i style="--a:{a:.2f}" title="{cls} · {CH[i]} = {x:+.3f}"></i>')
grid = "".join(grid)

bars = []
for cls, v, mx, share, top in rows:
    f = share["แรง"]
    seg = "".join(
        f'<span class="sg s{n}" style="width:{share[g]:.1f}%" title="{g} {share[g]:.0f}%"></span>'
        for n, (g, _, _) in enumerate(GROUPS))
    tops = " · ".join(f'{CH[i]}' for i in top)
    bars.append(f'<tr><th>{TH[cls]}<code>{cls}</code></th>'
                f'<td class="barcell"><div class="bar">{seg}</div></td>'
                f'<td class="num">{f:.0f}%</td><td class="ch">{tops}</td></tr>')
bars = "".join(bars)

legend = "".join(f'<span class="lg"><i class="s{n}"></i>{g} <em>{sub}</em></span>'
                 for n, (g, _, sub) in enumerate(GROUPS))

PAGE = f"""<title>UR3 Anomaly Signal Map</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+Thai:wght@400;500;600&display=swap">
<style>
:root {{
  --ground:#f6f7f6; --panel:#fff; --ink:#151d1b; --ink-2:#4d5a56; --ink-3:#7d8a86;
  --line:#dfe4e2; --line-2:#c6cecb; --sig:29,111,139; --warn:#b0512a; --warn-bg:#f8ece6;
}}
@media (prefers-color-scheme: dark) {{
  :root:not([data-theme="light"]) {{
    --ground:#0f1413; --panel:#161c1b; --ink:#e6ecea; --ink-2:#9daba6;
    --ink-3:#71807b; --line:#252e2c; --line-2:#39443f; --sig:109,190,214;
    --warn:#e08a5f; --warn-bg:#2a1c14;
  }}
}}
:root[data-theme="dark"] {{
  --ground:#0f1413; --panel:#161c1b; --ink:#e6ecea; --ink-2:#9daba6;
  --ink-3:#71807b; --line:#252e2c; --line-2:#39443f; --sig:109,190,214;
  --warn:#e08a5f; --warn-bg:#2a1c14;
}}
* {{ box-sizing:border-box }}
body {{ background:var(--ground); color:var(--ink);
  font-family:"IBM Plex Sans Thai",system-ui,sans-serif; line-height:1.7; }}
.wrap {{ max-width:1040px; margin:0 auto; padding:56px 28px 80px; }}
code,.mono,em,.num,u,th code {{ font-family:"IBM Plex Mono",ui-monospace,monospace }}
.eyebrow {{ font-size:12px; letter-spacing:.16em; text-transform:uppercase;
  color:var(--ink-3); font-family:"IBM Plex Mono",monospace; margin:0 0 10px }}
h1 {{ font-size:34px; font-weight:600; line-height:1.25; margin:0 0 14px;
  text-wrap:balance; letter-spacing:-.01em }}
.lede {{ font-size:17px; color:var(--ink-2); max-width:62ch; margin:0 0 26px }}
.meta {{ display:flex; flex-wrap:wrap; gap:10px 26px; padding:16px 0;
  border-top:1px solid var(--line); border-bottom:1px solid var(--line); margin-bottom:44px }}
.meta div {{ font-size:13px; color:var(--ink-3) }}
.meta strong {{ display:block; font-size:19px; color:var(--ink); font-weight:500;
  font-family:"IBM Plex Mono",monospace; font-variant-numeric:tabular-nums }}
h2 {{ font-size:20px; font-weight:600; margin:52px 0 6px; letter-spacing:-.005em }}
.sub {{ font-size:14px; color:var(--ink-3); margin:0 0 22px; max-width:64ch }}
.scroll {{ overflow-x:auto; padding-bottom:6px }}
.hm {{ display:grid; grid-template-columns:186px repeat(23,minmax(26px,1fr));
  gap:2px; min-width:820px; align-items:center }}
.hm u {{ writing-mode:vertical-rl; text-decoration:none; font-size:11px;
  color:var(--ink-3); height:76px; display:flex; align-items:flex-end;
  justify-content:center; padding-bottom:4px }}
.corner {{ height:76px }}
.rl {{ display:flex; align-items:baseline; gap:7px; justify-content:flex-end;
  padding-right:11px; height:30px; overflow:hidden }}
.rl span {{ font-size:13px; font-weight:500; white-space:nowrap }}
.rl code {{ font-size:10px; color:var(--ink-3); white-space:nowrap }}
.rl em {{ font-size:11px; font-style:normal; color:var(--ink-3);
  font-variant-numeric:tabular-nums; min-width:26px; text-align:right }}
.rl.dim span, .rl.dim code {{ color:var(--warn) }}
.hm i {{ height:30px; border-radius:2px; background:rgba(var(--sig),var(--a)) }}
table {{ width:100%; border-collapse:collapse; font-size:13px }}
th {{ text-align:right; font-weight:500; padding:7px 14px 7px 0; white-space:nowrap;
  vertical-align:middle; width:1%; }}
th code {{ display:block; font-size:10px; color:var(--ink-3); font-weight:400 }}
td {{ padding:7px 0 }}
.barcell {{ width:100% }}
.bar {{ display:flex; height:16px; border-radius:2px; overflow:hidden; gap:1px }}
.sg {{ display:block; min-width:1px }}
.s0 {{ background:rgba(var(--sig),.22) }} .s1 {{ background:rgba(var(--sig),.42) }}
.s2 {{ background:rgba(var(--sig),.58) }} .s3 {{ background:rgba(var(--sig),.76) }}
.s4 {{ background:rgba(var(--sig),1) }}
.num {{ padding-left:14px; text-align:right; font-variant-numeric:tabular-nums;
  font-size:13px; width:1%; white-space:nowrap }}
.ch {{ padding-left:18px; font-size:11px; color:var(--ink-3);
  font-family:"IBM Plex Mono",monospace; white-space:nowrap; width:1% }}
.legend {{ display:flex; flex-wrap:wrap; gap:8px 20px; margin:0 0 18px }}
.lg {{ display:flex; align-items:center; gap:7px; font-size:12px; color:var(--ink-2) }}
.lg i {{ width:11px; height:11px; border-radius:2px; display:block }}
.lg em {{ font-style:normal; color:var(--ink-3); font-size:10px }}
.find {{ border-left:3px solid rgba(var(--sig),1); padding:2px 0 2px 20px;
  margin:30px 0; max-width:66ch }}
.find p {{ margin:0; font-size:16px; color:var(--ink-2) }}
.find b {{ color:var(--ink); font-weight:500 }}
.cards {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(290px,1fr));
  gap:16px; margin-top:22px }}
.card {{ background:var(--panel); border:1px solid var(--line); border-radius:12px;
  padding:20px 22px }}
.card.bad {{ border-color:var(--warn); background:var(--warn-bg) }}
.card h3 {{ margin:0 0 3px; font-size:15px; font-weight:600 }}
.card .tag {{ font-family:"IBM Plex Mono",monospace; font-size:11px;
  color:var(--warn); letter-spacing:.04em }}
.card p {{ margin:11px 0 0; font-size:14px; color:var(--ink-2) }}
.note {{ margin-top:56px; padding-top:22px; border-top:1px solid var(--line);
  font-size:13px; color:var(--ink-3); max-width:70ch }}
.note b {{ color:var(--ink-2); font-weight:500 }}
</style>
<div class="wrap">
<p class="eyebrow">occlusion analysis · random forest · 161 features</p>
<h1>โมเดลใช้สัญญาณไหนตัดสินความผิดปกติแต่ละแบบ</h1>
<p class="lede">ปิดบังทีละช่องสัญญาณจาก 23 ช่อง แล้ววัดว่าความมั่นใจของโมเดลตกลงเท่าไหร่
ยิ่งตกมาก แปลว่าโมเดลพึ่งช่องนั้นมากในการตัดสิน</p>

<div class="meta">
  <div><strong>2,448,566</strong>แถวข้อมูลหุ่นจริง</div>
  <div><strong>213</strong>รอบการทดลอง</div>
  <div><strong>8</strong>คลาสที่โมเดลรู้จัก</div>
  <div><strong>84.0%</strong>ความแม่นบนข้อมูลจริง</div>
  <div><strong>125 Hz</strong>หน้าต่างละ 1 วินาที</div>
  <div><strong>72</strong>หน้าต่างที่วัด</div>
</div>

<h2>ฮีทแมพ ความผิดปกติ × ช่องสัญญาณ</h2>
<p class="sub">เข้มที่สุดในแต่ละแถว = ช่องที่คลาสนั้นพึ่งมากที่สุด ปรับสเกลแยกรายแถว
ตัวเลขหลังชื่อคลาสคือความมั่นใจเฉลี่ยตอนไม่ปิดบังอะไรเลย</p>
<div class="scroll"><div class="hm">{grid}</div></div>

<div class="find"><p><b>แรงคือกระดูกสันหลังของโมเดลนี้</b> — กินสัดส่วน 31% ถึง 67%
ของการตัดสินในทุกคลาส ซึ่งอธิบายได้ทันทีว่าทำไมโมเดลนี้ใช้กับ URSim ไม่ได้
เพราะ URSim คืนค่า <code>actual_TCP_force</code> เป็นศูนย์ตลอด</p></div>

<h2>สัดส่วนตามกลุ่มสัญญาณ</h2>
<p class="sub">รวม 23 ช่องเป็น 5 กลุ่ม คอลัมน์ขวาคือสัดส่วนของกลุ่ม “แรง”
และช่องเดี่ยวที่เด่นที่สุดสามอันดับแรก</p>
<div class="legend">{legend}</div>
<table><tbody>{bars}</tbody></table>

<h2>จุดบอดสองจุด</h2>
<p class="sub">สองคลาสนี้วัดความแม่นได้ต่ำผิดปกติตอนทดสอบกับข้อมูลจริง
ฮีทแมพอธิบายว่าเพราะอะไร</p>
<div class="cards">
  <div class="card bad">
    <span class="tag">1 / 24 ถูก</span>
    <h3>หนักแล้วหล่น</h3>
    <p>ความมั่นใจเฉลี่ยแค่ <code>0.12</code> ซึ่งเท่ากับการเดาสุ่มใน 8 คลาสพอดี
    และพึ่งกลุ่มแรงถึง 67% แบบกระจุกตัวแต่อ่อนมาก
    โมเดลไม่ได้เรียนรู้คลาสนี้ตั้งแต่แรก ไม่ใช่แค่ทายพลาด
    ทายเป็น <code>payload_heavy</code> 12 ครั้ง <code>normal</code> 11 ครั้ง</p>
  </div>
  <div class="card bad">
    <span class="tag">1 / 30 ถูก</span>
    <h3>แรงเสียดทานแบบ push</h3>
    <p>ป้าย <code>friction</code> รวมสามแบบไว้ด้วยกัน — <code>band</code>
    <code>weight</code> และ <code>push</code> อย่างละ 10 รอบ
    โมเดลจับสองแบบแรกได้ แต่แบบ push ให้ลายเซ็นต่างจนถูกมองเป็นปกติ</p>
  </div>
</div>

<p class="note"><b>วิธีวัด</b> — ฟีเจอร์ 161 ตัวเรียงเป็น 7 สถิติ
(mean, std, max, min, rms, skew, kurtosis) คูณ 23 ช่อง การปิดบังช่องหนึ่งคือ
ตั้งฟีเจอร์ทั้ง 7 ตัวของช่องนั้นเป็นศูนย์ ซึ่งเทียบเท่ากับให้ช่องนั้นนิ่งที่ค่าเฉลี่ยของ scaler พอดี
ค่าที่รายงานคือความน่าจะเป็นของคลาสที่ถูกต้องที่หายไป เฉลี่ยจาก 9 หน้าต่างต่อคลาส
(3 รอบการทดลอง × 3 ตำแหน่งในรอบ) วัดบนโมเดล <code>rf.onnx</code> รุ่น 8 คลาส
(108.2 MB) ซึ่งยุบ <code>payload_normal</code> เข้า <code>normal</code> แล้ว
รุ่นก่อนหน้า 9 คลาสให้ความแม่นรวม 80.7% เทียบกับรุ่นนี้ 84.0%
<b>ตัวเลขเหล่านี้ใช้เทียบกันเองเท่านั้น</b>
ผลรวมของ occlusion ไม่เท่ากับความน่าจะเป็นทั้งหมด จึงอ่านว่าช่องไหนสำคัญกว่าช่องไหนได้
แต่อ่านเป็นเปอร์เซ็นต์ของคำตอบตรงตัวไม่ได้</p>
</div>
"""

open("signal_map.html", "w", encoding="utf-8").write(PAGE)
print(len(PAGE), "chars ->", "signal_map.html")
