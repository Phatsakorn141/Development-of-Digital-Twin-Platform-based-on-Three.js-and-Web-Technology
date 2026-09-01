"""predict_example_rf.py — run the exported Random Forest with onnxruntime.
Pipeline: raw window (125 steps x 23 channels) -> scale -> 161 features -> rf.onnx.
Deps:  pip install numpy scipy onnxruntime
"""
import json, numpy as np, scipy.stats as st, onnxruntime as ort

CLASSES = json.load(open("classes.json"))
SC = np.load("scaler.npz"); MEAN, STD = SC["mean"], SC["std"]      # per-channel (23,)
SESS = ort.InferenceSession("rf.onnx", providers=["CPUExecutionProvider"])
OUT = [o.name for o in SESS.get_outputs()][-1]

def features(window_125x23):
    X = ((np.asarray(window_125x23, dtype=np.float32) - MEAN) / STD)[None]   # (1,125,23) scaled
    m=X.mean(1); s=X.std(1); mx=X.max(1); mn=X.min(1); rms=np.sqrt((X**2).mean(1))
    sk=st.skew(X,axis=1,bias=False,nan_policy="omit"); ku=st.kurtosis(X,axis=1,bias=False,nan_policy="omit")
    F=np.hstack([m,s,mx,mn,rms,sk,ku]).astype(np.float32)
    return np.nan_to_num(F)

def predict(window_125x23):
    probs = np.asarray(SESS.run([OUT], {"features": features(window_125x23)})[0])[0]
    k = int(probs.argmax())
    return CLASSES[k], float(probs[k]), dict(zip(CLASSES, probs.round(4).tolist()))

if __name__ == "__main__":
    demo = np.random.randn(125, 23).astype(np.float32)   # replace with a real 1-second window
    label, conf, allp = predict(demo)
    print("prediction:", label, f"({conf:.3f})"); print("all:", allp)
