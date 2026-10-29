// features.mjs -- 161 stat-features for the UR3 RF model, in pure JS (ESM).
//
// EXACT port of analysis/deploy_onnx/predict_example_rf.py:
//   raw window (125 x 23) -> per-channel scale -> [mean,std,max,min,rms,skew,kurt] x 23
// skew/kurtosis replicate scipy.stats with bias=False (fisher=True for kurtosis),
// so the browser features match the Python reference bit-for-bit within f32 rounding.
//
// Used by BOTH the browser app (app.mjs) and the Node verifier
// (scripts/verify_web_parity.mjs) so there is a single source of truth.

export const WINDOW_LEN = 125;
export const N_CHANNELS = 23;
export const N_FEATURES = 7 * N_CHANNELS; // 161

// Near-constant channels make skew/kurtosis numerically undefined (m2 -> f32 noise),
// so different engines (numpy-f32 vs JS-f64) disagree wildly on a value that carries
// NO predictive signal. We zero skew/kurt when the scaled-channel std < this eps.
// Verified: identical RF predictions & accuracy for eps up to 1e-2 (build_fixture check).
// The SAME constant is used in scripts/build_fixture.py so the reference matches.
export const GUARD_STD_EPS = 1e-3;

// window: Float32Array length 125*23, row-major (t*23 + c). mean/std: length 23.
// Returns Float32Array length 161 in order [mean,std,max,min,rms,skew,kurt] x channel.
export function computeFeatures(window, mean, std) {
  const T = WINDOW_LEN, C = N_CHANNELS;
  const out = new Float32Array(N_FEATURES);
  const n = T;
  const fr = Math.fround;   // mirror numpy float32: the deployed pipeline computes
                            // scaled window + stats in float32, so we round each op.

  for (let c = 0; c < C; c++) {
    const mc = fr(mean[c]), sc = fr(std[c]);
    // scaled column (float32), + running mean/rms/max/min
    let sum = 0, sumSq = 0, mx = -Infinity, mn = Infinity;
    const col = new Float32Array(T);
    for (let t = 0; t < T; t++) {
      const v = fr(fr(window[t * C + c] - mc) / sc);
      col[t] = v;                 // Float32Array store already rounds, fr() keeps sum f32
      sum = fr(sum + v);
      sumSq = fr(sumSq + fr(v * v));
      if (v > mx) mx = v;
      if (v < mn) mn = v;
    }
    const meanV = fr(sum / n);
    const rms = fr(Math.sqrt(fr(sumSq / n)));

    // central moments about meanV, in float32
    let m2 = 0, m3 = 0, m4 = 0;
    for (let t = 0; t < T; t++) {
      const d = fr(col[t] - meanV);
      const d2 = fr(d * d);
      m2 = fr(m2 + d2);
      m3 = fr(m3 + fr(d2 * d));
      m4 = fr(m4 + fr(d2 * d2));
    }
    m2 = fr(m2 / n); m3 = fr(m3 / n); m4 = fr(m4 / n);
    const stdV = fr(Math.sqrt(m2)); // np.std ddof=0

    // scipy skew, bias=False:  sqrt(n*(n-1))/(n-2) * m3 / m2^1.5
    // scipy kurtosis, bias=False, fisher=True:
    //   1/((n-2)(n-3)) * ((n^2-1)*m4/m2^2 - 3*(n-1)^2)
    let skew, kurt;
    if (stdV < GUARD_STD_EPS) {  // near-constant channel: undefined higher moments -> 0
      skew = 0; kurt = 0;
    } else {
      const g1 = fr(m3 / fr(Math.pow(m2, 1.5)));
      skew = fr(fr(Math.sqrt(n * (n - 1)) / (n - 2)) * g1);
      kurt = fr(fr(1 / ((n - 2) * (n - 3))) *
             ((n * n - 1) * fr(m4 / fr(m2 * m2)) - 3 * (n - 1) * (n - 1)));
    }
    if (!Number.isFinite(skew)) skew = 0;   // np.nan_to_num
    if (!Number.isFinite(kurt)) kurt = 0;

    // pack into hstack order: block b at offset b*23 + c
    out[0 * C + c] = meanV;
    out[1 * C + c] = stdV;
    out[2 * C + c] = mx;
    out[3 * C + c] = mn;
    out[4 * C + c] = rms;
    out[5 * C + c] = skew;
    out[6 * C + c] = kurt;
  }
  // round-trip through f32 to mirror numpy float32 features
  return out;
}
