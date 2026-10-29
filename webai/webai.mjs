// ============================================================
// webai.mjs — รัน AI (Random Forest 8 คลาส) "ในเบราว์เซอร์" บน Digital Twin
// ------------------------------------------------------------
// โมดูลนี้เป็นส่วน "เสริม" (additive) สำหรับงานวิจัย STE2027:
//   - แตะ stream ur/telemetry เอง (ไม่แก้ connectMQTT ของเพื่อน)
//   - สกัดฟีเจอร์ 161 มิติ + รัน rf.onnx ด้วย onnxruntime-web (WASM) ในเบราว์เซอร์
//   - วัดตัวชี้วัด: latency / throughput / RTF / FPS / Long Tasks / memory / soak
//   - เลือกได้ว่ารันบน main thread หรือ Web Worker
// โค้ดเดิมของเพื่อน (รับ MQTT ฝั่ง Python มาแสดง) ยังทำงานปกติทุกอย่าง
// เปิดใช้งานด้วยการเพิ่มบรรทัดเดียวใน index.html:
//   <script type="module" src="webai/webai.mjs"></script>
// ============================================================
import { computeFeatures, WINDOW_LEN, N_CHANNELS, N_FEATURES } from "./features.mjs";

// self-hosted onnxruntime-web 1.20.1 (ไฟล์ในโฟลเดอร์ webai/ort/) — ไม่พึ่ง CDN, TTFI ต่ำและทำซ้ำได้
const ORT_URL  = new URL("./ort/ort.wasm.min.mjs", import.meta.url).href;
const ORT_PATH = new URL("./ort/", import.meta.url).href;
const CFG = {
  modelDir: "../Model_RF_v2/",     // rf.onnx.gz + scaler.json + classes.json + thresholds.json
  mqttWS:   `ws://${location.hostname || "localhost"}:9001`,
  topic:    "ur/telemetry",
  WINDOW:   WINDOW_LEN,             // 125
  STRIDE:   25,                     // ทายทุก 25 แถว (5 ครั้ง/วินาที)  — ตรงกับ predict_mqtt.py
  HZ:       125,
  WARMUP:   20,                     // ทิ้ง N inference แรก (WASM JIT) ก่อนเก็บสถิติ
  fixUrsim: false,                  // replay DB / test = false (ตรง convention แล้ว); live URSim สด = true
};

const S = {
  ort: null, session: null, worker: null, useWorker: false,
  mean: null, std: null, classes: null, thr: null,
  ring: [], since: 0, enabled: false,
  // metrics
  measuring: false, lat: [], infCount: 0, infStart: 0,
  fps: [], frameTimes: [], lastFrame: 0, longTasks: 0, tbt: 0,
  mem: [], errors: 0, lastPred: "—", lastConf: 0,
  ttfi: null,
};

// ── channels() — แปลง payload 1 แถวเป็น 23 ช่อง (พอร์ตจาก ai/predict_mqtt.py เป๊ะ) ──
function channels(p, fix) {
  const q = Array.from(p.actual_q);
  const pose = Array.from(p.actual_tcp_pose);
  if (fix) { q[5] -= 2 * Math.PI; pose[2] -= 0.261; }   // URSim convention fix
  const i = Array.from(p.actual_current);
  const v = Array.from(p.actual_tcp_speed);
  const f = Array.from(p.actual_tcp_force);
  const tcpSpd = Math.sqrt(v[0]**2 + v[1]**2 + v[2]**2);
  const tcpFrc = Math.sqrt(f.reduce((a,x)=>a+x*x,0));
  // 6 q + 6 current + pose xyz + [speed, force] + 6 force/torque = 23
  return [...q, ...i, pose[0],pose[1],pose[2], tcpSpd, tcpFrc, ...f];
}

// ── โหลดโมเดล + scaler + classes (วัด TTFI = download + init + first inference) ──
async function loadModel() {
  S.ort = await import(ORT_URL);
  S.ort.env.wasm.numThreads = 1;
  S.ort.env.wasm.wasmPaths = ORT_PATH;
  S.ort.env.logLevel = "error";
  const t0 = performance.now();
  [S.mean, S.std, S.classes, S.thr] = await Promise.all([
    fetch(CFG.modelDir+"scaler.json").then(r=>r.json()).then(j=>Float64Array.from(j.mean)),
    fetch(CFG.modelDir+"scaler.json").then(r=>r.json()).then(j=>Float64Array.from(j.std)),
    fetch(CFG.modelDir+"classes.json").then(r=>r.json()),
    fetch(CFG.modelDir+"thresholds.json").then(r=>r.json()).catch(()=>null),
  ]);
  // rf.onnx.gz -> แตก gzip ในเบราว์เซอร์ด้วย DecompressionStream
  const gz = await fetch(CFG.modelDir+"rf.onnx.gz");
  const buf = await new Response(gz.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  S.session = await S.ort.InferenceSession.create(buf, { executionProviders:["wasm"] });
  // first inference (warm the graph) + จับ TTFI
  const dummy = new Float32Array(N_FEATURES);
  await S.session.run({ features: new S.ort.Tensor("float32", dummy, [1, N_FEATURES]) });
  S.ttfi = performance.now() - t0;
  log(`โมเดลพร้อม · ${(buf.byteLength/1048576).toFixed(1)} MB · TTFI ${S.ttfi.toFixed(0)} ms · ${S.classes.length} คลาส`);
}

// ── อนุมานบน main thread ──
async function predictMain(winFlat) {
  const feats = computeFeatures(winFlat, S.mean, S.std);
  const res = await S.session.run({ features: new S.ort.Tensor("float32", feats, [1, N_FEATURES]) });
  const probs = res.probabilities.data;            // Float32Array length 8
  let am = 0; for (let k=1;k<probs.length;k++) if (probs[k]>probs[am]) am=k;
  return { label: S.classes[am], conf: probs[am] };
}

// ── อนุมานบน Web Worker (ย้ายงานหนักออกจาก main thread) ──
function predictWorker(winFlat) {
  return new Promise((resolve) => {
    const id = Math.random();
    const h = (e)=>{ if (e.data.id!==id) return; S.worker.removeEventListener("message",h); resolve(e.data); };
    S.worker.addEventListener("message", h);
    const copy = winFlat.slice();                  // transfer สำเนา (ไม่ทำลาย ring)
    S.worker.postMessage({ id, win: copy }, [copy.buffer]);
  });
}

// ── รับ telemetry → เติม ring buffer → อนุมานทุก STRIDE แถว ──
async function onTelemetry(p) {
  if (!S.enabled) return;
  let row;
  try { row = channels(p, CFG.fixUrsim); } catch { return; }   // payload ไม่ครบ ข้าม
  S.ring.push(Float32Array.from(row));
  if (S.ring.length > CFG.WINDOW) S.ring.shift();
  S.since++;
  if (S.ring.length < CFG.WINDOW || S.since < CFG.STRIDE) return;
  S.since = 0;
  // แบนเป็น Float32Array(125*23) แบบ row-major (t*23 + c)
  const flat = new Float32Array(CFG.WINDOW * N_CHANNELS);
  for (let t=0;t<CFG.WINDOW;t++) flat.set(S.ring[t], t*N_CHANNELS);
  const t0 = performance.now();
  let out;
  try { out = S.useWorker ? await predictWorker(flat) : await predictMain(flat); }
  catch (e) { S.errors++; return; }
  const dt = performance.now() - t0;
  S.infCount++;
  S.lastPred = out.label; S.lastConf = out.conf;
  if (S.measuring && S.infCount > CFG.WARMUP) {
    S.lat.push({ t: performance.now(), ms: dt });
  }
  updatePanel();
}

// ── MQTT tap (ไคลเอนต์ของเราเอง ไม่ยุ่งกับของเพื่อน) ──
function connectTap() {
  if (!window.mqtt) { log("⚠ ไม่พบไลบรารี mqtt (ต้องโหลดก่อน webai)"); return; }
  const c = window.mqtt.connect(CFG.mqttWS);
  c.on("connect", ()=>{ c.subscribe(CFG.topic); log("ต่อ MQTT (tap) แล้ว"); });
  c.on("message", (topic, payload)=>{
    if (topic !== CFG.topic) return;
    let p; try { p = JSON.parse(payload.toString()); } catch { return; }
    onTelemetry(p);
  });
  c.on("error", ()=>{ S.errors++; });
}

// ── Metrics: FPS loop (rAF ของเราเอง, วัดโดยไม่แตะ animate ของเพื่อน) ──
function fpsLoop() {
  const now = performance.now();
  if (S.lastFrame) {
    const ft = now - S.lastFrame;
    if (S.measuring) { S.frameTimes.push(ft); }
  }
  S.lastFrame = now;
  requestAnimationFrame(fpsLoop);
}
// Long Tasks + Total Blocking Time
function startObservers() {
  try {
    new PerformanceObserver((list)=>{
      for (const e of list.getEntries()) { if (S.measuring){ S.longTasks++; S.tbt += Math.max(0, e.duration-50); } }
    }).observe({ entryTypes:["longtask"] });
  } catch {}
  // memory sampler ทุก 2 วินาที (Chromium เท่านั้น)
  setInterval(()=>{ if (S.measuring && performance.memory) S.mem.push({ t:performance.now(), mb: performance.memory.usedJSHeapSize/1048576 }); }, 2000);
}

// ── สรุปสถิติ ──
function pct(a,p){ if(!a.length) return 0; const s=[...a].sort((x,y)=>x-y); return s[Math.min(s.length-1, Math.floor(p/100*s.length))]; }
function mean(a){ return a.length? a.reduce((x,y)=>x+y,0)/a.length : 0; }
function slope(pts){ // regression slope ของ y ตาม t (วินาที) — สำหรับ drift/leak
  if (pts.length<2) return 0; const n=pts.length;
  const t=pts.map(p=>p.t/1000); const y=pts.map(p=>p.ms??p.mb);
  const mt=mean(t), my=mean(y); let num=0,den=0;
  for(let i=0;i<n;i++){ num+=(t[i]-mt)*(y[i]-my); den+=(t[i]-mt)**2; }
  return den? num/den : 0;
}
function summary() {
  const lms = S.lat.map(x=>x.ms);
  const fts = S.frameTimes;
  const fps = fts.map(ft=>1000/ft);
  const durSec = S.lat.length ? (S.lat[S.lat.length-1].t - S.lat[0].t)/1000 : 0;
  return {
    mode: S.useWorker ? "web-worker" : "main-thread",
    ttfi_ms: S.ttfi?.toFixed(1),
    inference: {
      n: lms.length, mean_ms:+mean(lms).toFixed(3), min_ms:+Math.min(...lms,0).toFixed(3),
      max_ms:+Math.max(...lms,0).toFixed(3), p50:+pct(lms,50).toFixed(3), p95:+pct(lms,95).toFixed(3), p99:+pct(lms,99).toFixed(3),
      throughput_per_s:+(durSec? lms.length/durSec:0).toFixed(2),
      RTF:+((CFG.STRIDE/CFG.HZ)/(mean(lms)/1000) || 0).toFixed(1),
      latency_drift_ms_per_s:+slope(S.lat).toFixed(4),
    },
    rendering: {
      frames: fts.length, mean_fps:+mean(fps).toFixed(1),
      low1pct_fps:+pct(fps,1).toFixed(1), frameTime_p95_ms:+pct(fts,95).toFixed(2), frameTime_p99_ms:+pct(fts,99).toFixed(2),
      longTasks: S.longTasks, totalBlocking_ms:+S.tbt.toFixed(1),
    },
    memory: { samples:S.mem.length, start_mb:+(S.mem[0]?.mb||0).toFixed(1), end_mb:+(S.mem[S.mem.length-1]?.mb||0).toFixed(1), leak_mb_per_s:+slope(S.mem).toFixed(4) },
    errors: S.errors,
  };
}

// ── Export CSV + JSON ──
function download(name, text, type="text/plain") {
  const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([text],{type})); a.download=name; a.click();
}
function exportResults() {
  const sum = summary();
  download(`webai_summary_${sum.mode}.json`, JSON.stringify(sum,null,2), "application/json");
  let csv = "type,t_ms,value\n";
  S.lat.forEach(x=>csv+=`latency_ms,${x.t.toFixed(1)},${x.ms.toFixed(3)}\n`);
  S.frameTimes.forEach((ft,i)=>csv+=`frametime_ms,${i},${ft.toFixed(2)}\n`);
  S.mem.forEach(m=>csv+=`mem_mb,${m.t.toFixed(1)},${m.mb.toFixed(2)}\n`);
  download(`webai_raw_${sum.mode}.csv`, csv, "text/csv");
  log("บันทึกผล JSON + CSV แล้ว");
}

// ── Auto-benchmark: รัน main-thread แล้ว web-worker เวลาเท่ากัน แล้วสรุปเทียบ ──
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
function resetMetrics(){ S.lat=[]; S.frameTimes=[]; S.mem=[]; S.longTasks=0; S.tbt=0; S.errors=0; S.infCount=0; S.lastFrame=performance.now(); }
async function autoBench(sec=60){
  if(!S.session){ log("โมเดลยังไม่พร้อม"); return; }
  const prevE=S.enabled, prevW=S.useWorker; S.enabled=true;
  // phase 1 — main thread
  S.useWorker=false; resetMetrics(); S.measuring=true; log(`[bench] Main thread ${sec}s…`);
  await sleep(sec*1000); S.measuring=false; const main=summary();
  // phase 2 — web worker
  S.useWorker=true; resetMetrics(); S.measuring=true; log(`[bench] Web Worker ${sec}s…`);
  await sleep(sec*1000); S.measuring=false; const worker=summary();
  S.enabled=prevE; S.useWorker=prevW;
  const cmp={ duration_s:sec, main, worker, deltas:{
    TBT_ms:            { main:main.rendering.totalBlocking_ms, worker:worker.rendering.totalBlocking_ms },
    low1pct_fps:       { main:main.rendering.low1pct_fps,      worker:worker.rendering.low1pct_fps },
    frameTime_p99_ms:  { main:main.rendering.frameTime_p99_ms, worker:worker.rendering.frameTime_p99_ms },
    inf_p50_ms:        { main:main.inference.p50,              worker:worker.inference.p50 },
    inf_p95_ms:        { main:main.inference.p95,              worker:worker.inference.p95 },
  }};
  download("webai_benchmark_compare.json", JSON.stringify(cmp,null,2), "application/json");
  log(`[bench] เสร็จ · TBT ${main.rendering.totalBlocking_ms}→${worker.rendering.totalBlocking_ms}ms · 1%low ${main.rendering.low1pct_fps}→${worker.rendering.low1pct_fps} fps`);
}

// ── Stress sweep: หา threshold ว่า main thread รับ inference ได้ถึงกี่ครั้ง/วินาที ก่อนกระทบ FPS ──
function getStressWindow(){
  const f=new Float32Array(CFG.WINDOW*N_CHANNELS);
  if(S.ring.length>=CFG.WINDOW){ for(let t=0;t<CFG.WINDOW;t++) f.set(S.ring[t], t*N_CHANNELS); return f; }
  for(let t=0;t<CFG.WINDOW;t++) for(let c=0;c<N_CHANNELS;c++) f[t*N_CHANNELS+c]=S.mean[c];  // synthetic (scaled≈0)
  return f;
}
function runStressPhase(rate, secPer, useWorker, flat){
  return new Promise((resolve)=>{
    S.useWorker=useWorker; resetMetrics(); S.measuring=true;
    const interval=1000/rate, end=performance.now()+secPer*1000;
    async function tick(){
      if(performance.now()>=end){ S.measuring=false; resolve(summary()); return; }
      const t0=performance.now();
      try{ await (useWorker?predictWorker(flat):predictMain(flat)); }catch{ S.errors++; }
      const dt=performance.now()-t0; S.infCount++;
      if(S.infCount>CFG.WARMUP) S.lat.push({t:performance.now(), ms:dt});
      setTimeout(tick, Math.max(0, interval-(performance.now()-t0)));  // รันถึง target rate หรือสูงสุดเท่าที่ไหว (ไม่ทับกัน)
    }
    tick();
  });
}
async function stressSweep(rates=[5,50,200,500,1000], secPer=12){
  if(!S.session){ log("โมเดลยังไม่พร้อม"); return; }
  const prevE=S.enabled, prevW=S.useWorker; S.enabled=false;   // ปิด inference ตาม MQTT ระหว่าง stress
  const flat=getStressWindow(), rows=[];
  for(const mode of ["main","worker"]){
    for(const r of rates){
      log(`[stress] ${mode} @ ${r}/s (${secPer}s)…`);
      const sum=await runStressPhase(r, secPer, mode==="worker", flat);
      rows.push({ mode, target_rate:r, achieved_per_s:sum.inference.throughput_per_s,
        inf_p50_ms:sum.inference.p50, inf_p95_ms:sum.inference.p95,
        mean_fps:sum.rendering.mean_fps, low1pct_fps:sum.rendering.low1pct_fps,
        tbt_ms:sum.rendering.totalBlocking_ms, longTasks:sum.rendering.longTasks });
    }
  }
  S.enabled=prevE; S.useWorker=prevW;
  download("webai_stress_sweep.json", JSON.stringify({secPer, rows}, null, 2), "application/json");
  let csv="mode,target_rate,achieved_per_s,inf_p50_ms,inf_p95_ms,mean_fps,low1pct_fps,tbt_ms,longTasks\n";
  rows.forEach(x=>csv+=`${x.mode},${x.target_rate},${x.achieved_per_s},${x.inf_p50_ms},${x.inf_p95_ms},${x.mean_fps},${x.low1pct_fps},${x.tbt_ms},${x.longTasks}\n`);
  download("webai_stress_sweep.csv", csv, "text/csv");
  log("[stress] เสร็จ · ดูไฟล์ sweep (json + csv)");
}

// ── Correctness test: รัน test-set จริง 4,374 หน้าต่างผ่านเบราว์เซอร์ เทียบกับ Python (Exp 1-G) ──
async function correctnessTest(){
  if(!S.session){ log("โมเดลยังไม่พร้อม"); return; }
  log("[correctness] โหลด fixture…");
  const ref = await (await fetch("webai/fixtures/test_reference.json")).json();
  const raw = new Float32Array(await (await fetch("webai/fixtures/test_windows.f32")).arrayBuffer());
  const N=ref.meta.n, C=N_CHANNELS, T=WINDOW_LEN, K=ref.classes.length;
  const mean=Float64Array.from(ref.scaler.mean), std=Float64Array.from(ref.scaler.std);
  log(`[correctness] คำนวณฟีเจอร์ ${N} หน้าต่าง…`);
  const feats=new Float32Array(N*N_FEATURES);
  for(let i=0;i<N;i++) feats.set(computeFeatures(raw.subarray(i*T*C,(i+1)*T*C), mean, std), i*N_FEATURES);
  log("[correctness] รันโมเดลในเบราว์เซอร์…");
  const res=await S.session.run({ features: new S.ort.Tensor("float32", feats, [N, N_FEATURES]) });
  const probs=res.probabilities.data;
  let agree=0, correct=0, linf=0; const pred=new Int32Array(N);
  const tp=Array(K).fill(0), fp=Array(K).fill(0), fn=Array(K).fill(0), conf={};
  for(let i=0;i<N;i++){
    let am=0; for(let k=1;k<K;k++) if(probs[i*K+k]>probs[i*K+am]) am=k; pred[i]=am;
    if(am===ref.pred_ref[i]) agree++;
    const t=ref.labels_true[i]; if(am===t) correct++;
    for(let k=0;k<K;k++){ const d=Math.abs(probs[i*K+k]-ref.prob_ref[i*K+k]); if(d>linf) linf=d; }
    if(am===t) tp[t]++; else { fp[am]++; fn[t]++; const key=ref.classes[t]+"→"+ref.classes[am]; conf[key]=(conf[key]||0)+1; }
  }
  const f1=[]; for(let k=0;k<K;k++){ const pr=tp[k]/((tp[k]+fp[k])||1), rc=tp[k]/((tp[k]+fn[k])||1); f1[k]=(pr+rc)?2*pr*rc/(pr+rc):0; }
  const macro=f1.reduce((a,b)=>a+b,0)/K;
  const out={ n:N,
    top1_agreement_web_vs_python_pct:+(100*agree/N).toFixed(3),
    prob_Linf_web_vs_python:linf,
    accuracy:+(correct/N).toFixed(4), macroF1:+macro.toFixed(4),
    perClassF1:Object.fromEntries(ref.classes.map((c,k)=>[c,+f1[k].toFixed(4)])),
    topConfusions:Object.entries(conf).sort((a,b)=>b[1]-a[1]).slice(0,8) };
  download("webai_correctness.json", JSON.stringify(out,null,2), "application/json");
  log(`[correctness] agree ${out.top1_agreement_web_vs_python_pct}% · L∞ ${linf.toExponential(1)} · acc ${out.accuracy} · macroF1 ${out.macroF1}`);
}

// ── UI panel (ลอยมุมขวาล่าง) ──
let $panel, $log;
function log(m){ if($log){ $log.textContent = m; } console.log("[webai]", m); }
function updatePanel() {
  if(!$panel) return;
  const s = summary();
  $panel.querySelector("#wa-pred").textContent = `${S.lastPred} (${S.lastConf.toFixed(2)})`;
  $panel.querySelector("#wa-lat").textContent = S.lat.length? `p50 ${s.inference.p50} · p95 ${s.inference.p95} ms · RTF ${s.inference.RTF}×` : "—";
  $panel.querySelector("#wa-fps").textContent = s.rendering.frames? `${s.rendering.mean_fps} fps · 1%low ${s.rendering.low1pct_fps} · TBT ${s.rendering.totalBlocking_ms}ms` : "—";
}
function buildPanel() {
  $panel = document.createElement("div");
  $panel.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:99999;width:320px;background:#0f2038ee;color:#eaf1ff;font:12px/1.5 system-ui,sans-serif;border:1px solid #2e6fd6;border-radius:10px;padding:10px 12px;box-shadow:0 6px 20px #0008";
  $panel.innerHTML = `
    <div style="font-weight:700;color:#8fc0ff;margin-bottom:6px">🧪 Web-AI Metrics (STE2027)</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">
      <button id="wa-enable">▶ เปิด inference</button>
      <button id="wa-worker">Main thread</button>
      <button id="wa-meas">⏺ เริ่มวัด</button>
      <button id="wa-export">⬇ Export</button>
      <button id="wa-bench">⏱ Auto-bench</button>
      <button id="wa-stress">💥 Stress sweep</button>
      <button id="wa-correct">📊 Correctness</button>
    </div>
    <div>คำทำนาย: <b id="wa-pred">—</b></div>
    <div>Latency: <span id="wa-lat">—</span></div>
    <div>Render: <span id="wa-fps">—</span></div>
    <div id="wa-log" style="margin-top:6px;color:#9fb6d6;font-size:11px">กำลังโหลดโมเดล…</div>`;
  document.body.appendChild($panel);
  $log = $panel.querySelector("#wa-log");
  for (const b of $panel.querySelectorAll("button")) b.style.cssText="background:#1e3a66;color:#eaf1ff;border:1px solid #2e6fd6;border-radius:6px;padding:3px 8px;cursor:pointer;font-size:11px";
  $panel.querySelector("#wa-enable").onclick = (e)=>{ S.enabled=!S.enabled; e.target.textContent = S.enabled?"⏸ ปิด inference":"▶ เปิด inference"; };
  $panel.querySelector("#wa-worker").onclick = (e)=>{ S.useWorker=!S.useWorker; e.target.textContent = S.useWorker?"Web Worker":"Main thread"; log(S.useWorker?"ย้าย inference ไป Web Worker":"inference บน main thread"); };
  $panel.querySelector("#wa-meas").onclick = (e)=>{ S.measuring=!S.measuring; e.target.textContent=S.measuring?"⏹ หยุดวัด":"⏺ เริ่มวัด"; if(S.measuring){ S.lat=[];S.frameTimes=[];S.mem=[];S.longTasks=0;S.tbt=0;S.errors=0; log("เริ่มเก็บ metrics…"); } else log("หยุดเก็บ · กด Export เพื่อบันทึก"); };
  $panel.querySelector("#wa-export").onclick = exportResults;
  $panel.querySelector("#wa-bench").onclick = ()=>autoBench(60);   // 60 วินาที × 2 โหมด (แก้เลขได้)
  $panel.querySelector("#wa-stress").onclick = ()=>stressSweep();  // sweep อัตรา inference หา threshold
  $panel.querySelector("#wa-correct").onclick = correctnessTest;   // รัน test-set จริงเทียบ Python
}

// ── init ──
async function init() {
  buildPanel();
  startObservers();
  requestAnimationFrame(fpsLoop);
  try {
    await loadModel();
    if (S.useWorker) {} // worker สร้างเมื่อสลับโหมดครั้งแรก (ดู setupWorker)
    connectTap();
    await setupWorker();
  } catch (e) { log("❌ โหลดโมเดลล้มเหลว: "+e.message); }
}
async function setupWorker() {
  try {
    S.worker = new Worker(new URL("./inference.worker.mjs", import.meta.url), { type:"module" });
    S.worker.postMessage({ init:true, modelDir:new URL(CFG.modelDir, location.href).href, ortUrl:ORT_URL, ortPath:ORT_PATH });
  } catch (e) { log("⚠ สร้าง Web Worker ไม่ได้ (ใช้ main thread อย่างเดียว): "+e.message); }
}

if (document.readyState==="loading") document.addEventListener("DOMContentLoaded", init);
else init();
