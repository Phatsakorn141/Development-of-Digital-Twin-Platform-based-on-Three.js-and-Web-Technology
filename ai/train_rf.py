"""
เทรน Random Forest จากข้อมูลใน PostgreSQL
ใช้สูตร feature เดียวกับโมเดลของเพื่อน (7 สถิติ/ช่อง) เพื่อให้ inference ใช้โค้ดร่วมกันได้

ติดตั้ง:  pip install psycopg2-binary numpy scipy scikit-learn skl2onnx onnxruntime
รัน:      python train_rf.py
"""
import json, numpy as np, scipy.stats as st, psycopg2
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import classification_report, confusion_matrix
from skl2onnx import convert_sklearn
from skl2onnx.common.data_types import FloatTensorType

DSN        = "postgresql://twin:twinpass@localhost:5432/digitaltwin"
WINDOW     = 100      # ~11.6 วินาที ที่ 8.6 Hz ≈ 1 รอบการทำงาน
STRIDE     = 25       # เลื่อนทีละ 25 จุด (ซ้อนกัน 75%) เพื่อให้ได้ตัวอย่างเยอะขึ้น
TRAIN_FRAC = 0.7      # 70% แรกของแต่ละรอบ = train, 30% หลัง = test

# 18 ช่องที่ URSim ให้ค่าจริง (ตัด target_q/track_err/tcp_force ที่เป็นค่าซ้ำหรือศูนย์)
CHANNELS = ([f"q{i}"   for i in range(6)]
          + [f"v{i}"   for i in range(6)]
          + [f"tcp{i}" for i in range(6)])


def load_runs():
    """ดึงข้อมูลจาก DB แล้วจัดกลุ่มเป็น run — คืน [(label, ndarray(n,18)), ...]"""
    conn = psycopg2.connect(DSN)
    cur = conn.cursor()
    cur.execute("""
        SELECT run_id, label, payload
        FROM raw_messages
        WHERE label IS NOT NULL
        ORDER BY run_id, ts
    """)
    runs, cur_id, buf, cur_label = [], None, [], None
    for run_id, label, p in cur:
        q, v, t = p.get("actual_q") or [], p.get("joint_speed") or [], p.get("tcp_pose") or []
        if len(q) < 6 or len(v) < 6 or len(t) < 6:
            continue                      # แถวไม่ครบ ข้ามไป
        if run_id != cur_id:
            if buf: runs.append((cur_label, np.array(buf, dtype=np.float32)))
            cur_id, cur_label, buf = run_id, label, []
        buf.append([*q[:6], *v[:6], *t[:6]])
    if buf: runs.append((cur_label, np.array(buf, dtype=np.float32)))
    conn.close()
    return runs


def make_windows(seq, w, s):
    """ตัด time-series เป็น window ซ้อนกัน"""
    return [seq[i:i + w] for i in range(0, len(seq) - w + 1, s)]


def features(X, mean, std):
    """(n, W, C) → (n, C*7) — ต้องตรงกับตอน inference เป๊ะ ไม่งั้นผลเพี้ยนโดยไม่มี error"""
    Z = (X - mean) / std
    m   = Z.mean(1); sd = Z.std(1); mx = Z.max(1); mn = Z.min(1)
    rms = np.sqrt((Z ** 2).mean(1))
    sk  = st.skew(Z, axis=1, bias=False)
    ku  = st.kurtosis(Z, axis=1, bias=False)
    return np.nan_to_num(np.hstack([m, sd, mx, mn, rms, sk, ku]).astype(np.float32))


def main():
    runs = load_runs()
    print(f"โหลดได้ {len(runs)} รอบ")

    # ── แบ่ง train/test ตามเวลาภายในแต่ละรอบ ──
    # ห้ามสุ่มแบ่ง! window ซ้อนกัน 75% ถ้าสุ่มจะมี window ที่เกือบเหมือนกัน
    # อยู่ทั้งใน train และ test → ความแม่นยำจะสูงเกินจริงมาก
    Xtr, ytr, Xte, yte = [], [], [], []
    for label, seq in runs:
        cut = int(len(seq) * TRAIN_FRAC)
        for w in make_windows(seq[:cut], WINDOW, STRIDE): Xtr.append(w); ytr.append(label)
        for w in make_windows(seq[cut:], WINDOW, STRIDE): Xte.append(w); yte.append(label)

    Xtr, Xte = np.array(Xtr), np.array(Xte)
    ytr, yte = np.array(ytr), np.array(yte)
    print(f"train {Xtr.shape}  test {Xte.shape}")

    # ── scaler คำนวณจาก train เท่านั้น ──
    flat = Xtr.reshape(-1, Xtr.shape[2])
    mean, std = flat.mean(0), flat.std(0)
    std[std == 0] = 1.0                   # กันหารศูนย์ในช่องที่ค่านิ่ง

    Ftr, Fte = features(Xtr, mean, std), features(Xte, mean, std)

    clf = RandomForestClassifier(
        n_estimators=300, min_samples_leaf=2,
        class_weight="balanced",          # ชดเชยที่แต่ละคลาสมีข้อมูลไม่เท่ากัน
        random_state=42, n_jobs=-1,
    )
    clf.fit(Ftr, ytr)

    print("\n" + "=" * 60)
    print(classification_report(yte, clf.predict(Fte), digits=3))
    labels = sorted(set(ytr))
    print("confusion matrix (แถว=จริง คอลัมน์=ทำนาย)")
    print("        " + "".join(f"{l[:9]:>11}" for l in labels))
    for name, row in zip(labels, confusion_matrix(yte, clf.predict(Fte), labels=labels)):
        print(f"{name[:9]:>9}" + "".join(f"{v:>11}" for v in row))

    # ── export ให้ตรงรูปแบบโมเดลของเพื่อน ──
    onx = convert_sklearn(
        clf,
        initial_types=[("features", FloatTensorType([None, Ftr.shape[1]]))],
        options={id(clf): {"zipmap": False}},
    )
    with open("rf_ours.onnx", "wb") as f:
        f.write(onx.SerializeToString())
    np.savez("scaler.npz", mean=mean.astype(np.float32), std=std.astype(np.float32))
    json.dump(list(clf.classes_), open("classes.json", "w"), ensure_ascii=False, indent=2)
    json.dump(CHANNELS, open("channels.json", "w"), indent=2)

    print(f"\nบันทึกแล้ว: rf_ours.onnx / scaler.npz / classes.json / channels.json")
    print(f"input = {Ftr.shape[1]} features ({len(CHANNELS)} ช่อง × 7 สถิติ)")


if __name__ == "__main__":
    main()