// inference.worker.mjs — รัน feature extraction + onnx ใน Web Worker (ออกจาก main thread)
import { computeFeatures, N_FEATURES } from "./features.mjs";
let ort=null, session=null, mean=null, std=null, classes=null;

self.onmessage = async (e)=>{
  const d = e.data;
  if (d.init) {
    try {
      ort = await import(d.ortUrl);
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.wasmPaths = d.ortPath;
      ort.env.logLevel = "error";
      const sj = await (await fetch(d.modelDir+"scaler.json")).json();
      mean = Float64Array.from(sj.mean); std = Float64Array.from(sj.std);
      classes = await (await fetch(d.modelDir+"classes.json")).json();
      const gz = await fetch(d.modelDir+"rf.onnx.gz");
      const buf = await new Response(gz.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
      session = await ort.InferenceSession.create(buf, { executionProviders:["wasm"] });
      await session.run({ features: new ort.Tensor("float32", new Float32Array(N_FEATURES), [1,N_FEATURES]) });
      self.postMessage({ ready:true });
    } catch (err) { self.postMessage({ error: String(err) }); }
    return;
  }
  // d = { id, win: Float32Array(125*23) }
  if (!session) { self.postMessage({ id:d.id, error:"not ready" }); return; }
  const feats = computeFeatures(d.win, mean, std);
  const res = await session.run({ features: new ort.Tensor("float32", feats, [1,N_FEATURES]) });
  const probs = res.probabilities.data;
  let am=0; for (let k=1;k<probs.length;k++) if (probs[k]>probs[am]) am=k;
  self.postMessage({ id:d.id, label:classes[am], conf:probs[am] });
};
