// parity_benchmark.mjs — วัดว่า ONNX Runtime Web (WASM) ให้ผลตรงกับ Python ไหม
// พร้อมจับ latency  ดัดแปลงจาก verify_web_parity.mjs ของเพื่อน 2 จุด:
//   1. wasmPaths ต้องเป็น file:// URL ไม่งั้นรันบน Windows ไม่ได้
//   2. เขียนผลเป็น JSON ไม่ใช่พิมพ์จออย่างเดียว
//
// รัน:
//   node analysis/parity_benchmark.mjs
//   MODEL=rf_small.onnx REF=reference_small.json node analysis/parity_benchmark.mjs
//
// ต้องมีโปรเจกต์ web_digitaltwin ของเพื่อน (มี node_modules/onnxruntime-web ติดตั้งแล้ว)
// เปลี่ยนที่อยู่ได้ด้วย  WEB=<path> node analysis/parity_benchmark.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import os from "node:os";

const WEB = process.env.WEB
  || "C:/Users/palm/Downloads/web_digitaltwin/web_digitaltwin";
const HERE = dirname(fileURLToPath(import.meta.url));
const OUTDIR = join(HERE, "results");

const MODEL_FILE = process.env.MODEL || "rf.onnx";
const REF_FILE = process.env.REF || "reference.json";

const ort = await import(
  pathToFileURL(join(WEB, "node_modules/onnxruntime-web/dist/ort.mjs")).href
).catch(() => import(
  pathToFileURL(join(WEB, "node_modules/onnxruntime-web/index.mjs")).href
));
const { computeFeatures, N_FEATURES, WINDOW_LEN, N_CHANNELS } =
  await import(pathToFileURL(join(WEB, "public/features.mjs")).href);

// ★ ต้นฉบับใส่ path ดิบแบบ C:\... ทำให้ ESM loader บน Windows ปฏิเสธ
ort.env.wasm.wasmPaths =
  pathToFileURL(join(WEB, "node_modules/onnxruntime-web/dist") + "/").href;
ort.env.wasm.numThreads = 1;      // บังคับ single-thread ให้ผลคงที่ทุกครั้ง
ort.env.logLevel = "error";

const quant = (arr, q) => {
  const s = [...arr].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
};

const ref = JSON.parse(readFileSync(join(WEB, "fixtures", REF_FILE), "utf8"));
const { classes } = ref;
const mean = Float64Array.from(ref.scaler.mean);
const std = Float64Array.from(ref.scaler.std);
const N = ref.meta.n, T = ref.meta.window_len, C = ref.meta.n_channels;
if (T !== WINDOW_LEN || C !== N_CHANNELS)
  throw new Error(`fixture ไม่ตรงกับ features.mjs: ${T}x${C}`);

const raw = new Float32Array(readFileSync(join(WEB, "fixtures/windows.f32")).buffer);
const stride = T * C;

// ── 1. ฟีเจอร์ฝั่ง JS ตรงกับฝั่ง Python ไหม ──
const tf0 = performance.now();
const feats = new Float32Array(N * N_FEATURES);
let maxFeatDiff = 0;
for (let i = 0; i < N; i++) {
  const f = computeFeatures(raw.subarray(i * stride, (i + 1) * stride), mean, std);
  feats.set(f, i * N_FEATURES);
  const fr = ref.features_ref[i];
  for (let k = 0; k < N_FEATURES; k++) {
    const d = Math.abs(f[k] - fr[k]);
    if (d > maxFeatDiff) maxFeatDiff = d;
  }
}
const featMs = (performance.now() - tf0) / N;

// ── 2. โหลดโมเดล ──
const bytes = new Uint8Array(readFileSync(join(WEB, "models", MODEL_FILE)));
const t0 = Date.now();
const sess = await ort.InferenceSession.create(bytes, {
  executionProviders: ["wasm"], graphOptimizationLevel: "all",
});
const loadMs = Date.now() - t0;
const inName = sess.inputNames[0];
const outName = sess.outputNames[sess.outputNames.length - 1];

// ── 3. ความน่าจะเป็นตรงกันไหม + ทายตรงกันไหม + แม่นแค่ไหน ──
const res = await sess.run({ [inName]: new ort.Tensor("float32", feats, [N, N_FEATURES]) });
const probsT = res[outName];
const K = classes.length;
const getRow = (i) => probsT.dims?.length === 2
  ? Array.from(probsT.data.slice(i * K, (i + 1) * K))
  : classes.map((c, k) => {
      const m = probsT.data[i];
      return Number(m.get ? m.get(k) : (m[k] ?? m[c]));
    });

let maxProbDiff = 0, top1 = 0, correct = 0;
for (let i = 0; i < N; i++) {
  const row = getRow(i), rr = ref.probs_ref[i];
  let am = 0;
  for (let k = 0; k < K; k++) {
    const d = Math.abs(row[k] - rr[k]);
    if (d > maxProbDiff) maxProbDiff = d;
    if (row[k] > row[am]) am = k;
  }
  if (classes[am] === ref.pred_ref[i]) top1++;
  if (classes[am] === ref.labels_true[i]) correct++;
}

// ── 4. latency ทีละหน้าต่าง (สถานการณ์ใช้งานจริง) ──
const lat = [];
const one = new Float32Array(N_FEATURES);
for (let rep = 0; rep < 60; rep++) {
  one.set(feats.subarray((rep % N) * N_FEATURES, ((rep % N) + 1) * N_FEATURES));
  const s = performance.now();
  const r = await sess.run({ [inName]: new ort.Tensor("float32", one, [1, N_FEATURES]) });
  void r[outName];
  lat.push(performance.now() - s);
}
const warm = lat.slice(10);        // ทิ้ง 10 ครั้งแรกที่ยังไม่ warm
const p50 = quant(warm, 0.5), p95 = quant(warm, 0.95), p99 = quant(warm, 0.99);

const out = {
  measured_at: new Date().toISOString(),
  model: {
    file: MODEL_FILE,
    bytes: bytes.length,
    size_mb: +(bytes.length / 1048576).toFixed(1),
    n_classes: K,
    classes,
  },
  fixture: {
    file: REF_FILE,
    n_windows: N,
    window_len: T,
    n_channels: C,
    n_features: N_FEATURES,
  },
  parity: {
    feature_max_abs_diff: maxFeatDiff,
    prob_max_abs_diff: maxProbDiff,
    top1_agreement: top1 / N,
    accuracy_vs_truth: correct / N,
    top1_matched: top1,
    correct,
  },
  timing_ms: {
    model_load: loadMs,
    feature_extract_per_window: +featMs.toFixed(4),
    inference_p50: +p50.toFixed(4),
    inference_p95: +p95.toFixed(4),
    inference_p99: +p99.toFixed(4),
    end_to_end_per_window: +(featMs + p50).toFixed(4),
    latency_samples: warm.length,
  },
  environment: {
    node: process.version,
    platform: `${os.platform()} ${os.release()}`,
    cpu: os.cpus()[0]?.model ?? "unknown",
    cores: os.cpus().length,
    wasm_threads: 1,
  },
  notes: [
    "latency วัดทีละหน้าต่าง ทิ้ง 10 ครั้งแรกที่ยังไม่ warm เหลือ 50 ครั้ง",
    "end_to_end = เวลาคำนวณฟีเจอร์ + inference p50 (ต้นฉบับของเพื่อนวัดแค่ inference)",
    "single-thread WASM เพื่อให้ผลคงที่ทุกครั้ง",
  ],
};

mkdirSync(OUTDIR, { recursive: true });
const dest = join(OUTDIR, `parity_${MODEL_FILE.replace(/\.onnx$/, "")}.json`);
writeFileSync(dest, JSON.stringify(out, null, 2), "utf8");

const pct = (a) => (a * 100).toFixed(2) + "%";
console.log(`\n=== ${MODEL_FILE}  (${K} คลาส, N=${N}) ===`);
console.log(`model size           : ${out.model.size_mb} MB`);
console.log(`model load           : ${loadMs} ms`);
console.log(`feature max|Δ|       : ${maxFeatDiff.toExponential(2)}`);
console.log(`prob    max|Δ|       : ${maxProbDiff.toExponential(2)}`);
console.log(`top-1 agreement      : ${pct(top1 / N)}`);
console.log(`accuracy vs truth    : ${pct(correct / N)}`);
console.log(`latency p50/p95/p99  : ${p50.toFixed(3)} / ${p95.toFixed(3)} / ${p99.toFixed(3)} ms`);
console.log(`feature extract      : ${featMs.toFixed(3)} ms/window`);
console.log(`end-to-end / window  : ${(featMs + p50).toFixed(3)} ms`);
console.log(`\nบันทึกที่ ${dest}`);
