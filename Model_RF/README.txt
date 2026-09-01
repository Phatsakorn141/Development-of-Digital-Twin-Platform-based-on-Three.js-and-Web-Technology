DEPLOY BUNDLE — UR3 anomaly classifier (Random Forest)
======================================================
Files:
  rf.onnx                the model (input = 161 features, output = 9 class probs)
  scaler.npz             per-channel mean/std (needed before feature extraction)
  classes.json           class order (index -> name)
  thresholds.json        optional per-class decision thresholds
  predict_example_rf.py  runnable example (raw window -> prediction)

How to run:
  pip install numpy scipy onnxruntime
  python predict_example_rf.py

Input: a window of 125 time steps x 23 channels (1 second at 125 Hz).
Channel order (must match): q0..q5, i0..i5, tcp_x, tcp_y, tcp_z,
  tcp_speed_scalar, tcp_force_scalar, fx, fy, fz, tx, ty, tz.
For a live stream, slide a 125-sample window (stride 62 = 50%% overlap).

Model: Random Forest, test macro-F1 ~0.91 on real held-out runs.
