# UR3 Anomaly Detection — Data Pipeline & ML

A real-time data acquisition and analysis pipeline for collecting labeled UR3 robotic arm telemetry at 125 Hz, then training and explaining ML-based anomaly detection models for predictive maintenance. Covers the full path from robot → database → cleaned windows → ss-gVAE augmentation → classifier comparison → explainable-AI heatmaps.

---

## 📁 Project Structure

```
ur_anomaly_db/
├── docker-compose.yml          # TimescaleDB + Mosquitto MQTT broker
├── mosquitto.conf              # MQTT broker config
├── requirements.txt            # Python dependencies
│
├── init_data/
│   └── 01_init_schema.sql      # DB schema (experiment_runs + telemetry hypertable)
│
├── test_connection.py          # DB sanity check
├── ur3_publisher.py            # RTDE → MQTT publisher (125 Hz)
├── db_consumer.py              # MQTT → TimescaleDB writer (batch COPY)
├── ur3_pick_place.py           # urSim test driver (simulation only, not used on real robot)
│
├── backups/                    # Database backups (.dump files)
│
└── analysis/
    ├── data_utils.py                   # Shared helpers (DB I/O, cleaning, segmentation, phase)
    ├── aug_common.py                   # Shared augmentation machinery: canonical split,
    │                                   #   scaling, standardized save (used by 02 / 03 / 10 / 11)
    ├── 01_data.py                      # DATA: prep | visualize | windows  (was 01/02/03)
    ├── 02_generate.py                  # GEN: ssgvae | smotenc | timegan    (was 05/05b/05c)
    ├── 03_train_classifiers.py         # 5-model showdown (--method ssgvae|smotenc|timegan)
    ├── 04_plot_synthetic.py            # Real vs synthetic plots: single | all  (was 07 + 12)
    ├── 05_anomaly_heatmap.py           # 1D-CNN train + gradient saliency XAI heatmaps
    ├── 06_event_labeling.py            # Event-based window relabeling
    ├── 07_validate.py                  # VALIDATE: embeddings | temporal | novelty  (was 10/15/17)
    ├── 08_report.py                    # REPORT: compare | xlsx | perclass | significance | figures
    │                                   #   (was 11/13/14/16/18)
    ├── 09_ablation.py                  # ABLATION: budget | ratio           (was 19 + 23)
    ├── 10_model.py                     # MODELING: train | evaluate | export (was 20/21/22)
    ├── 11_diagnose.py                  # DIAGNOSE: offline | realtime | eval | plot
    │                                   #   (root-cause on real recorded runs)
    │
    ├── cleaned/                        # Output: cleaned parquet/csv per run
    ├── plots/                          # Output: diagnostic PNG plots
    ├── windows/                        # Output: windows.npy + labels.parquet
    ├── splits/run_split.json           # Canonical run-level split shared by every method
    ├── benchmark/                      # Output: benchmark_results.json (timing projection)
    ├── augmented_ssgvae/               # GEN #1 output bundle (windows+labels+meta+split
    │                                   #   +benchmark_results_06.json)
    ├── augmented_smotenc/              # GEN #2 output bundle (same layout)
    ├── augmented_timegan/              # GEN #3 output bundle (same layout)
    ├── validation/                     # Output: Embed_<method>_*.png + validation_metrics.json
    ├── comparison/                     # Output: method_comparison.* + compare_testF1.png
    ├── models/                         # Output: 1d_cnn_best.pth + classes.json
    ├── final_models/                   # Output: deployable RF/CNN + scaler + eval (10_model)
    ├── deploy_onnx/                    # Output: portable rf.onnx bundle (10_model export)
    ├── diagnosis/                      # Output: offline root-cause reports (11_diagnose offline)
    ├── faultsim/                       # Output: Phase-F eval report + timeline (11_diagnose eval)
    ├── live_runs/                      # Output: realtime logs + plots (11_diagnose realtime/plot)
    └── plot_synthetic/                 # Output: Real-vs-synthetic + XAI heatmap PNGs
```

> **Note (legacy):** `augmented_data/` from earlier single-method runs is
> superseded by the per-method `augmented_ssgvae/` folder and can be deleted.

---

## 🔄 Pipeline Flow

```
┌────────────┐    RTDE       ┌──────────────────┐
│  UR3 robot │ ─────────────►│ ur3_publisher.py │
│  @ 125 Hz  │               │  RTDE → JSON     │
└────────────┘               └────────┬─────────┘
                                       │ MQTT publish
                                       ▼
                            ┌──────────────────┐
                            │   MQTT broker    │
                            │   (Mosquitto)    │
                            └────────┬─────────┘
                                     │ MQTT subscribe
                                     ▼
                            ┌──────────────────┐
                            │ db_consumer.py   │
                            │ batch COPY       │
                            └────────┬─────────┘
                                     │
                                     ▼
                            ┌──────────────────┐
                            │   TimescaleDB    │
                            │  telemetry table │
                            └────────┬─────────┘
                                     │ analysis pipeline
                                     ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │  DATA PREP                                                        │
   │  01_data.py  prep → visualize → windows                          │
   │                                          │                        │
   │                                          ▼  windows.npy           │
   │  AUGMENTATION                                                     │
   │  02_generate.py  ssgvae | smotenc | timegan  (synthesize)        │
   │                                          │                        │
   │                                          ▼  augmented_windows.npy │
   │  MODELING & XAI                                                   │
   │  03_train_classifiers → 10_model → 11_diagnose → 05_anomaly_heatmap│
   └──────────────────────────────────────────────────────────────────┘
```

### Core components

**Data acquisition (`ur3_publisher.py`)**
Reads telemetry from the UR3 over RTDE protocol at 125 Hz using `ur_rtde`. Each sample includes joint positions, currents, TCP pose/speed/force, joint temperatures, and controller registers. Wraps every getter in `safe_get()` so missing fields on older PolyScope versions don't crash the pipeline. Publishes JSON payloads to the MQTT topic `ur/telemetry`.

**Data ingestion (`db_consumer.py`)**
Subscribes to `ur/telemetry` and batches incoming messages into TimescaleDB using psycopg3's `COPY` protocol (~10-20× faster than INSERT for 125 Hz workloads). Flushes every 250 rows or 2 seconds, whichever comes first.

**Storage (TimescaleDB)**
Two tables — `experiment_runs` (one row per scenario, holds the `anomaly_type` label) and `telemetry` (hypertable, 1-hour chunks, compressed after 1 day, segmented by `run_id`). Foreign key from `telemetry.run_id` ensures every telemetry row is tied to a labeled experiment.

**Analysis (`analysis/`)**
The pipeline, now organized as a handful of multi-command scripts: `01_data.py` (clean/segment → visualize → window), `02_generate.py` (the three synthetic-data methods), `03_train_classifiers.py` (five-model showdown), `07_validate.py` (manifold / temporal / novelty checks), `08_report.py` (comparison tables, Excel, per-class, significance, figures), `09_ablation.py` (budget / imbalance-ratio sweeps), `10_model.py` (train → evaluate → export the deployable model), `11_diagnose.py` (offline + real-time root-cause), and `05_anomaly_heatmap.py` (explainable-AI saliency).

---

## 🔧 Setup

### Prerequisites

- Docker + Docker Compose
- Python 3.11+
- Network connection to UR3 robot (LAN or same WiFi subnet)

### Install dependencies

```bash
pip install -r requirements.txt
```

`requirements.txt` now covers the whole pipeline, including the synthetic-data
stage:

- **generation:** `torch` (ss-gVAE, TimeGAN), `imbalanced-learn` (SMOTE-NC)
- **validation:** `scikit-learn` (t-SNE, Isomap), `umap-learn` (UMAP), `scipy`
- **reporting:** `pyarrow` (parquet), `openpyxl` + `Pillow` (Excel export in Step 13)

> The ML scripts import `torch`, `scikit-learn`, and `scipy` lazily where they can. If PyTorch is missing, the deep-learning models are skipped and the classical models (Random Forest / SVM) still run — the pipeline degrades gracefully rather than crashing.

### Start infrastructure

```bash
docker-compose up -d
docker-compose ps        # confirm both containers are running
```

### Verify the database

```bash
python test_connection.py
# Expected: ✅ All checks passed.
```

### Configure the robot IP

Edit `ur3_publisher.py` line 30:

```python
ROBOT_IP = "192.168.1.10"   # ← change to your UR3's IP
```

Make sure your PC is on the same subnet as the UR3 (use `ping <robot_ip>` to verify).

---

## 📥 Data Collection

The publisher and consumer run in **two separate terminals** simultaneously.

### Terminal 1 — start the consumer

Leave this running for the entire data collection session:

```bash
python db_consumer.py
```

### Terminal 2 — run scenarios one at a time

Each command below collects one cycle (= 9 picks). For multiple cycles, increment the suffix `_001` → `_002` → `_003` etc. Operator instructions are in the `--notes` field.

```bash
# Block A — Baseline & Drift
python ur3_publisher.py --run-id cold_start_d1_001 --anomaly-type normal --payload-grams 0 --speed-override 0.5 --notes "cold start day 1"
python ur3_publisher.py --run-id long_run --anomaly-type normal --payload-grams 0 --speed-override 0.5 --notes "30 cycles continuous"

# Block B — Mechanical Faults
python ur3_publisher.py --run-id payload_normal_001 --anomaly-type payload_normal --payload-grams 67 --speed-override 0.5 --notes "rubik's cube (~67g)"
python ur3_publisher.py --run-id payload_heavy_001 --anomaly-type payload_heavy --payload-grams 1000 --speed-override 0.5 --notes "added 1 kg weight"
python ur3_publisher.py --run-id gripper_low_001 --anomaly-type gripper_low --payload-grams 67 --speed-override 0.5 --gripper-force 50 --notes "50% of nominal force"
python ur3_publisher.py --run-id anomaly_payload_forced_drop_001 --anomaly-type payload_forced_drop --payload-grams 67 --speed-override 0.5 --gripper-force 20 --notes "operator pulls cube out mid-grip"
python ur3_publisher.py --run-id friction_push_001 --anomaly-type friction --payload-grams 0 --speed-override 0.5 --notes "manual push on arm during motion"
python ur3_publisher.py --run-id friction_band_001 --anomaly-type friction --payload-grams 0 --speed-override 0.5 --notes "rubber band on joint 3"
python ur3_publisher.py --run-id friction_weight_001 --anomaly-type friction  --payload-grams 0 --speed-override 0.5 --notes "weight attached to forearm link"

# Block C — Operating Mode
python ur3_publisher.py --run-id speed_30_001 --anomaly-type speed_30 --payload-grams 0 --speed-override 0.3 --notes "30% speed, no object"
python ur3_publisher.py --run-id speed_100_001 --anomaly-type speed_100 --payload-grams 0 --speed-override 1.0 --notes "100% speed, no object"
```

**During each run:** the publisher prints sample rate every second (`[rate] 125 Hz | queue=0 | dropped=0`). After all 9 picks complete, press `Ctrl+C` to stop the publisher (the consumer keeps running for the next scenario).

### CLI arguments reference

| Argument | Default | Description |
|----------|---------|-------------|
| `--run-id` | required | Unique identifier, pattern `<phase_label>_<NNN>` |
| `--anomaly-type` | `normal` | Label stored in `experiment_runs.anomaly_type` |
| `--payload-grams` | `100.0` | Object weight in grams |
| `--speed-override` | `1.0` | Speed multiplier (label only — set actual speed on PolyScope) |
| `--gripper-force` | `None` | Gripper force setting |
| `--notes` | `None` | Free-text notes |

---

## 🔍 Analysis

After collecting data, the analysis pipeline runs in three steps.

### Step 1 — Clean and segment

Pulls data from the DB, expands array columns into per-element scalars (`actual_q` → `q0..q5`), drops null/constant columns, segments cycles, and infers phase (approach / grasp / transport / release) from TCP velocity and force.

```bash
cd analysis

# All runs in the database
python 01_data.py prep

# A single run
python 01_data.py prep --run-ids friction_weight_001

# Multiple runs into one output file
python 01_data.py prep --run-ids payload_normal_001 payload_heavy_002 --out compare
```

**Output:** `analysis/cleaned/<stem>.parquet` (or `.csv` if pyarrow is missing)

### Step 2 — Visualize

Generates a 7-panel diagnostic plot per run: joint positions, joint currents, TCP pose, TCP speed, TCP force, joint temperatures (with drift annotation), and a colored phase strip with cycle dividers.

```bash
# Plot the first run found
python 01_data.py visualize

# Plot a specific run
python 01_data.py visualize --run-id payload_normal_001

# Plot every run
python 01_data.py visualize --all
```

**Output:** `analysis/plots/baseline_<run_id>.png`

### Step 3 — Generate windows for ML

Slices each cycle into overlapping fixed-length windows (W = 125 samples = 1.0 sec, stride = 62 = 50% overlap). Each window carries metadata: `run_id`, `anomaly_type`, `cycle_id`, `window_idx`, `phase_majority`, `phase_purity`. Windows never cross cycle boundaries.

```bash
# Generate windows from cleaned/all.parquet
python 01_data.py windows

# Custom window size
python 01_data.py windows --window 250 --stride 125
```

**Output (in `analysis/windows/`):**

- `windows.npy` — `(N × 125 × 23)` float32 tensor, ready for PyTorch / TensorFlow
- `labels.parquet` — `N` rows of metadata for filtering and querying
- `feature_columns.txt` — list of the 23 feature names in tensor channel order

---

## 🧬 Synthetic-Data Generation — Three Methods (for the paper)

The imbalance problem is now attacked with **three independent generators** so
their outputs can be compared head-to-head in the research paper:

| # | Method | Script | Idea |
|---|--------|--------|------|
| 1 | **ss-gVAE + VampPrior** | `02_generate.py ssgvae` | deep generative: encode a real anomaly seed, nudge its latent, decode |
| 2 | **SMOTE-NC** | `02_generate.py smotenc` | interpolate between a window and its k-NN; `phase_majority` kept as a genuine **nominal** feature |
| 3 | **TimeGAN** | `02_generate.py timegan` | adversarial time-series GAN (embedder/recovery/generator/supervisor/discriminator), PyTorch from scratch |

### What makes the three comparable — and leakage-safe

All three share `aug_common.py`, which enforces:

- **One canonical run-level split** (`splits/run_split.json`, seed 42, stratified by `anomaly_type`). Every method — and Step 6 — evaluates on the **identical held-out real test runs**.
- **Train-only exposure.** A generator only ever *sees* TRAIN runs (for training and for seeding), so synthetic windows are never derived from val/test runs. This closes the subtle "test-seed → synthetic-in-train" leak.
- **Matched targets** (`--target-per-phase`, default 1000) and **matched scaling**, so differences in the results reflect the *method*, not the settings.
- **One output layout per method** — `augmented_<method>/` with `augmented_windows.npy`, `augmented_labels.parquet`, `gen_meta.json`, `run_split.json`. Step 6 consumes any of them unchanged.

Synthetic rows keep `cycle_id = -1`, `run_id = synthetic_<type>`, plus a
`gen_method` column identifying which generator produced them.

### Run all three

```bash
python 02_generate.py ssgvae               # -> augmented_ssgvae/
python 02_generate.py smotenc              # -> augmented_smotenc/
python 02_generate.py timegan              # -> augmented_timegan/  (use --smoke to sanity-check fast)
```

Then the classifier showdown once per method, and the aggregate comparison:

```bash
python 03_train_classifiers.py --method ssgvae
python 03_train_classifiers.py --method smotenc
python 03_train_classifiers.py --method timegan
python 08_report.py compare                # -> comparison/method_comparison.* + compare_testF1.png
```

### Step 5 — Train ss-gVAE + synthesize anomaly data

Trains a Generative Variational Autoencoder with a **VampPrior** on **TRAIN normal data only**, then uses it to synthesize new anomaly windows by encoding real **TRAIN** anomaly seeds, nudging their latent vectors (temperature 0.5), and decoding — solving the class-imbalance problem before classification. Synthetic windows are flagged with `cycle_id = -1` and `run_id = synthetic_<type>` so downstream steps can always tell real from synthetic.

```bash
# Default: 300 epochs, target 1000 windows per anomaly×phase
python 02_generate.py ssgvae

# Faster smoke test
python 02_generate.py ssgvae --epochs 50 --target-per-phase 400

# Tune generation batch size (larger = faster on GPU)
python 02_generate.py ssgvae --gen-batch 512
```

**Output (in `analysis/augmented_ssgvae/`):**

- `augmented_windows.npy` — real + synthetic windows combined, `(N_total × 125 × 23)`
- `augmented_labels.parquet` — metadata with synthetic rows flagged (`cycle_id == -1`)
- `gen_meta.json` — method, seed, timing, per-channel fidelity
- `run_split.json` — copy of the canonical split used

| Argument | Default | Description |
|----------|---------|-------------|
| `--epochs` | `300` | VAE training epochs |
| `--target-per-phase` | `1000` | Synthetic windows to create per anomaly×phase group |
| `--gen-batch` | `512` | Windows decoded per batch during generation |
| `--seed` | `42` | Reproducibility seed |

### Step 5b — SMOTE-NC oversampling

Flattens each TRAIN anomaly window to 2875 continuous features, appends
`phase_majority` as a single **nominal** feature (this is what makes it
SMOTE-*NC* rather than plain SMOTE), and oversamples each anomaly class up to a
target matched to the ss-gVAE run. Synthetic windows are inverse-scaled back to
original engineering units.

```bash
python 02_generate.py smotenc               # -> augmented_smotenc/
python 02_generate.py smotenc --target-per-phase 1000 --k-neighbors 5
```

| Argument | Default | Description |
|----------|---------|-------------|
| `--target-per-phase` | `1000` | Synthetic windows per anomaly×phase (matches ss-gVAE) |
| `--k-neighbors` | `5` | SMOTE neighbourhood (auto-capped by the smallest class) |
| `--seed` | `42` | Reproducibility seed |

### Step 5c — TimeGAN

Trains one TimeGAN **per anomaly type** on that type's TRAIN windows, using the
three-phase schedule from the paper (embedding → supervised → joint). Phase
metadata is assigned to each generated window by nearest real per-phase
centroid. Runs on GPU if available, CPU otherwise.

```bash
python 02_generate.py timegan               # -> augmented_timegan/
python 02_generate.py timegan --smoke       # tiny steps + one class, just checks it runs
python 02_generate.py timegan --emb-steps 800 --sup-steps 800 --joint-steps 2000
```

| Argument | Default | Description |
|----------|---------|-------------|
| `--target-per-phase` | `1000` | Synthetic windows per anomaly×phase |
| `--emb-steps` / `--sup-steps` / `--joint-steps` | 600 / 600 / 1200 | training iterations per phase |
| `--batch` | `128` | mini-batch size |
| `--smoke` | off | tiny run to validate the pipeline end-to-end |

### Step 6 — Train & compare classifiers (the showdown)

Trains and evaluates **five** models on a chosen method's augmented dataset:
1D-CNN, LSTM, and Random Forest (the three "heroes"), plus MLP and SVM as
baselines. Uses the **canonical leakage-safe, run-level split**: the test set is
100% real, held-out runs the model has never seen in any form, and synthetic
windows go only into train/validation.

```bash
python 03_train_classifiers.py --method ssgvae     # or smotenc / timegan
python 03_train_classifiers.py --data-dir augmented_ssgvae   # explicit folder
python 03_train_classifiers.py --no-aug            # real-only baseline (no synthetic)
```

`--no-aug` trains on **real windows only** (synthetic ignored) and writes
`benchmark_results_06_noaug.json`; it is the reference the augmentation is
compared against. Each run now also saves per-class precision/recall/F1
(`per_class`) and the raw test predictions (`test_y_true` / `test_predictions`),
enabling per-class analysis and paired significance tests.

**Output:** `analysis/augmented_<method>/benchmark_results_06.json` — per-model accuracy, precision, recall, macro-F1, training time, **confusion matrices**, and **bootstrap 95% confidence intervals** on the test set. The console also prints a per-class classification report and the exact `run_id`s assigned to each split.

> **Report the `test` numbers, not `val`.** Validation metrics are for model selection only; the held-out real test metrics are the ones that belong in Chapter 4.

### Step 7 — Plot real vs synthetic (visual QA)

Draws the same 7-panel diagnostic layout as Step 2, overlaying a **real** window (solid lines) against a **synthetic** window (dashed) for a given anomaly class and phase — a quick visual sanity check that the ss-gVAE is producing realistic signals.

```bash
# Random anomaly-phase comparison
python 04_plot_synthetic.py single

# Every available anomaly × phase combination (many files)
python 04_plot_synthetic.py single --all

# A specific class and phase
python 04_plot_synthetic.py single --anomaly gripper_low --phase 2
```

**Output:** `analysis/plot_synthetic/Compare_<anomaly>_Phase<N>.png`

### Step 8 — Explainable-AI anomaly heatmaps

Trains a 1D-CNN on the augmented data and saves it, then scans a full run with a sliding window and computes **gradient-based saliency maps** — a 2D matrix (sensor feature × time) showing *where and when* the model detects anomalies, plus an anomaly-probability trace over time.

```bash
# 1. Train and save the CNN (writes models/1d_cnn_best.pth + classes.json)
python 05_anomaly_heatmap.py --train

# 2. Scan one run
python 05_anomaly_heatmap.py --scan payload_heavy_drop_001

# 3. Scan every run in cleaned/all.parquet
python 05_anomaly_heatmap.py --scan-all
```

**Output:**

- `analysis/models/1d_cnn_best.pth` — trained model weights
- `analysis/models/classes.json` — class-index → anomaly-type mapping
- `analysis/plot_synthetic/Matrix_Heatmap_<run_id>.png` — 2-panel XAI heatmap per run

### Step 10 — Validate synthetic data (t-SNE / UMAP / Isomap)

The quality gate for the paper: does the synthetic data live on the **same
manifold** as the real data? Each window is reduced to a per-channel
**summary-stats** feature vector (7 stats × 23 channels), then real vs synthetic
are embedded into 2D with **three** reducers and scored with quantitative
overlap metrics — so the check is not only visual.

```bash
python 07_validate.py embeddings                       # all methods found
python 07_validate.py embeddings --methods ssgvae timegan
python 07_validate.py embeddings --max-per-group 300   # points per class per origin
```

**Output (in `analysis/validation/`):**

- `Embed_<method>_byorigin.png` — 3 panels (t-SNE, UMAP, Isomap), real vs synthetic
- `Embed_<method>_bytype.png` — same panels, coloured by anomaly type (o = real, x = synthetic)
- `validation_metrics.json` — per method: real-vs-synthetic **silhouette** (≈0 = well mixed = good), **kNN mixing ratio** (≈1 = good), **NN-distance ratio** synth→real / real→real (≈1 = good)

### Step 11 — Aggregate the comparison

Collects every method's Step-6 classifier metrics, generation timing/fidelity,
and Step-10 overlap metrics into one place for the paper.

```bash
python 08_report.py compare
```

**Output (in `analysis/comparison/`):** `method_comparison.csv` / `.md`
(per method × model test accuracy, macro-F1, 95% CIs), `generation_summary.csv`,
and `compare_testF1.png` (grouped bar chart of test macro-F1 per model by method).

### Step 12 — Real vs synthetic plots for every method

Like Step 7 but for **all three** generators, so you can eyeball how each
method's synthetic signal compares to the real one.

```bash
# 07-style 7-panel figures, every (class,phase) group, all methods
python 04_plot_synthetic.py all --all
python 04_plot_synthetic.py all --all --mean          # plot the MEAN window (cleaner)

# compact cross-method overlay: real (black ±1σ) vs each method (coloured dashed)
python 04_plot_synthetic.py all --overlay --all
python 04_plot_synthetic.py all --overlay --anomaly gripper_low --phase 3
```

**Output (in `analysis/plot_compare/`):**
`<method>/Compare_<anomaly>_Phase<N>.png` (per method) and
`overlay/Overlay_<anomaly>_Phase<N>.png` (all methods on six key channels).

---

## 🎛️ Tuning notes (what was tried, and what stuck)

- **Equal synthetic budget (kept).** All three methods now emit exactly
  `target_per_phase` windows per (anomaly × phase) group, so totals match and
  the comparison is fair (ss-gVAE previously "filled up to" the target and made
  fewer).
- **ss-gVAE latent temperature: 0.5 (0.9 tried and reverted).** Raising it to
  0.9 did **not** improve manifold overlap (kNN-mixing stayed ≈ 0) and made rare
  classes wildly jittery — the off-manifold gap is a decoder-texture issue, not
  a temperature one. Kept at 0.5. Override with `--temperature` if experimenting.
- **TimeGAN steps 600/600/1200 → 2000/2000/5000 (kept, with caveat).** Longer
  training moved the overlap only marginally (NN-distance ratio 5.4 → 5.3) for a
  ~4× longer run (~25 min). Kept for a fairer comparison, but the gain is small —
  drop the steps for a quick check.

**Empirical takeaway:** for this dataset, fidelity ranks **SMOTE-NC ≫ ss-gVAE >
TimeGAN**, while downstream classifier utility is comparable across all three
(~0.86–0.90 macro-F1, Random Forest + SMOTE-NC best at ~0.905). Simple
hyperparameter nudges did not close the generative methods' manifold gap.

Re-run after any change:

```bash
python 02_generate.py ssgvae
python 02_generate.py timegan
python 03_train_classifiers.py --method ssgvae
python 03_train_classifiers.py --method timegan
python 07_validate.py embeddings
python 08_report.py xlsx
python 08_report.py compare
```

---

## 🧪 Pipeline Fixes & How to Verify Them

Three correctness/performance fixes were made to the ML stage. Each is described here with the exact command to confirm it on your data.

### Fix 1 — Data leakage in `03_train_classifiers.py` (most important)

**Problem.** The original split used `train_test_split(X, y, stratify=y)` at the *window* level. Two things made that unsafe: (a) windows overlap 50% (W=125, stride=62), so near-duplicate windows landed in both train and test; and (b) synthetic windows are near-clones of specific real seeds, so a seed in train with its synthetic sibling in test is effectively testing on training data. Both inflate accuracy/F1.

**Fix.** Split at the **run level**, stratified by `anomaly_type`. All windows from one run stay in a single split. Synthetic windows go only to train/validation. The test set is 100% real, unseen runs — matching the `Test = Real Data Only` design.

**Verify:**
```bash
python 02_generate.py ssgvae     # regenerate the augmented bundle first
python 03_train_classifiers.py
```
Check the console for `test: N (test is 100% real)` and that the run-leakage `assert` passed (no crash). In `benchmark_results_06.json`, confirm `metadata.split.test_runs` contains no `synthetic_*` entries. Expect **test scores to drop** vs the old numbers — that's the leakage being removed, not a regression.

### Fix 2 — (historical) crash-on-missing-library bug in the old benchmark script

**Problem.** The old `04_benchmark_training.py` had `import torch` at the top level, so it crashed on any machine without PyTorch, and its projection math double-counted.

**Status.** The benchmark script was a one-off timing estimator and has been **removed** in the script consolidation (real training now lives in `03_train_classifiers.py` and `10_model.py train`). The lazy-import lesson was carried into every remaining script — heavy imports (`torch`, `skl2onnx`, `onnx`) sit inside functions so `--help` and the torch-free paths work without them.

### Fix 3 — Slow generation in `02_generate.py ssgvae`

**Problem.** `synthesize_anomaly_data` decoded **one window at a time** — up to ~12,000 single-item decoder calls plus a GPU→CPU sync each, per full run. It also rescanned the entire anomaly index inside the group loop.

**Fix.** Generation is fully **vectorized**: encode each group's seeds once, sample all needed latents in one tensor, and decode in large batches (~500× fewer decoder launches and syncs). Group→seed selection is now a direct integer gather. On GPU the `[augment]` step drops from minutes to seconds.

**Verify:**
```bash
python 02_generate.py ssgvae --epochs 300 --target-per-phase 1000
```
The `[augment]` lines should complete quickly, and the output feeds `06` unchanged.

---

## 🔎 Model testing on real recorded runs

The model is validated **only on real recorded runs** (replayed offline from
`cleaned/all.parquet`). No urSim / MQTT / broker is involved. `11_diagnose.py`:

| sub-command | what it does |
|-------------|--------------|
| `offline`  | root-cause report for a recorded run / class / all anomaly runs |
| `realtime` | stream a recorded run (`--replay`) or a CSV (`--replay-file`) through the model window-by-window; auto-logs to `live_runs/` |
| `eval`     | build a ground-truth fault scenario (real fault signatures) and SCORE detection (rate / latency / WHAT / false-alarm), offline |
| `plot`     | plot a realtime log (anomaly score over time) |

```bash
cd analysis

# root-cause report for one recorded run
python 11_diagnose.py offline --run payload_heavy_drop_001

# stream a real run through the model (auto-saves its log to live_runs/)
python 11_diagnose.py realtime --replay friction_band_004 --log-all --warn 0.7
python 11_diagnose.py plot live_runs/<the_log_it_printed>.jsonl --warn 0.7

# scored fault-detection (real fault signatures, ground truth built in)
python 11_diagnose.py eval --warn 0.7
#   -> faultsim/eval_report.json + faultsim/eval_timeline.png
```

> `warn` / `danger` are severity thresholds on `1 - P(normal)`. A clean normal
> run reads low (~0.2-0.3); a run whose class is a labelled anomaly reads high —
> that is correct, not a false alarm.

Outputs: `diagnosis/` (offline reports), `live_runs/` (realtime logs + plots),
`faultsim/` (eval report + timeline).

---

## 💾 Database Backup & Restore

The database holds the only copy of the raw telemetry. Back it up regularly — especially before any schema change, big delete, or container recreation.

### Backup

Run from the project root in PowerShell or Command Prompt:

```powershell
# 1. Dump the database inside the container (custom format, compressed)
docker exec ur_timescaledb pg_dump -U ur_admin -d ur_anomaly -F c -f /tmp/backup.dump

# 2. Copy the dump file out to the host
docker cp ur_timescaledb:/tmp/backup.dump C:\66160001\ur_anomaly_db\backups\ur_anomaly_20260521.dump

# 3. (Optional) Clean up the dump inside the container
docker exec ur_timescaledb rm /tmp/backup.dump
```

Replace `20260521` with the current date (`YYYYMMDD`) each time you back up.

**Expected output:** a `.dump` file around 500 MB–2 GB depending on dataset size.

**Note on warnings:** `pg_dump` may print warnings about "circular foreign-key constraints" on `hypertable`, `chunk`, and `continuous_agg`. These are normal for TimescaleDB and do not affect the backup — they only mean restore needs the steps below.

### Restore

⚠️ **Restoring overwrites the current database.** Make a fresh backup first if you want to preserve current data.

#### Option 1 — Restore into an empty database (most common)

```powershell
# 1. Copy the dump file into the container
docker cp C:\66160001\ur_anomaly_db\backups\ur_anomaly_20260521.dump ur_timescaledb:/tmp/restore.dump

# 2. Drop the existing database and recreate it empty
docker exec ur_timescaledb psql -U ur_admin -d postgres -c "DROP DATABASE IF EXISTS ur_anomaly;"
docker exec ur_timescaledb psql -U ur_admin -d postgres -c "CREATE DATABASE ur_anomaly;"

# 3. Enable the TimescaleDB extension in the new database
docker exec ur_timescaledb psql -U ur_admin -d ur_anomaly -c "CREATE EXTENSION IF NOT EXISTS timescaledb;"

# 4. Restore from the dump (use --disable-triggers to handle the circular FK warning)
docker exec ur_timescaledb pg_restore -U ur_admin -d ur_anomaly --disable-triggers /tmp/restore.dump

# 5. Verify
docker exec ur_timescaledb psql -U ur_admin -d ur_anomaly -c "SELECT COUNT(*) FROM experiment_runs;"
docker exec ur_timescaledb psql -U ur_admin -d ur_anomaly -c "SELECT COUNT(*) FROM telemetry;"

# 6. Clean up
docker exec ur_timescaledb rm /tmp/restore.dump
```

#### Option 2 — Fresh start (wipe everything including Docker volumes)

Use this if the database is broken or you want a completely clean state:

```powershell
# 1. Stop containers and delete all data volumes
docker-compose down -v

# 2. Start fresh — docker-compose will recreate the database from init_data/01_init_schema.sql
docker-compose up -d

# 3. Wait ~10 seconds for the database to initialize, then restore
docker cp C:\66160001\ur_anomaly_db\backups\ur_anomaly_20260521.dump ur_timescaledb:/tmp/restore.dump
docker exec ur_timescaledb pg_restore -U ur_admin -d ur_anomaly --clean --if-exists --disable-triggers /tmp/restore.dump

# 4. Verify
docker exec ur_timescaledb psql -U ur_admin -d ur_anomaly -c "SELECT COUNT(*) FROM telemetry;"
```

### Best practices

- **Backup before:** modifying schema, deleting many rows, recreating containers, system migration
- **Keep at least 2-3 versions** of backups — never delete the last successful one until a new one is verified
- **External copy** — periodically copy the `backups/` folder to USB drive or cloud storage (Google Drive, OneDrive). If your local disk fails, the local backup is gone too.
- **Test restore** in a separate environment occasionally — a backup that doesn't restore isn't a backup

---

## 🗃️ Database Schema

### `experiment_runs` (one row per scenario)

| Column | Type | Description |
|--------|------|-------------|
| `run_id` | TEXT PK | Unique identifier (e.g. `payload_normal_001`) |
| `started_at` | TIMESTAMPTZ | UTC timestamp when publisher started |
| `ended_at` | TIMESTAMPTZ | UTC timestamp when publisher stopped |
| `anomaly_type` | TEXT | Class label (`normal`, `payload_heavy`, etc.) |
| `payload_grams` | REAL | Object weight |
| `speed_override` | REAL | Speed multiplier label |
| `gripper_force` | REAL | Gripper force setting |
| `notes` | TEXT | Free-text annotations |

### `telemetry` (hypertable, 125 Hz)

Time-series rows tied to `experiment_runs` via FK. Contains kinematics (joint positions, velocities, currents, control output), TCP data (pose, speed, force), thermal/electrical health (joint temperatures, voltage, robot current), safety/state flags, and general-purpose RTDE registers. Arrays use PostgreSQL `DOUBLE PRECISION[]` for 6-element joint/Cartesian vectors.

See `init_data/01_init_schema.sql` for the full column list.

---

## 📊 Current Status

- ✅ End-to-end pipeline operational on real UR3 hardware
- ✅ 125 Hz stable, 0 dropped rows during extended sessions
- ✅ Cycle segmentation refined with TCP speed + median home estimation
- ✅ Phase inference fallback when controller-side phase tag is unavailable
- ✅ **Three** synthetic-data generators: ss-gVAE (Step 5), SMOTE-NC (Step 5b), TimeGAN (Step 5c)
- ✅ Canonical leakage-safe run split shared by all methods (`splits/run_split.json`)
- ✅ Five-model classifier showdown, per-method (`06 --method ...`)
- ✅ Synthetic-data validation gate: t-SNE + UMAP + Isomap + overlap metrics (Step 10)
- ✅ Cross-method comparison bundle for the paper (Step 11)
- ✅ Explainable-AI gradient saliency heatmaps (`05_anomaly_heatmap.py`)
- ✅ Final deployable model + calibration + per-class thresholds (`10_model.py`)
- ✅ Portable ONNX export, verified vs source (`10_model.py export` -> `deploy_onnx/`)
- ✅ Root-cause diagnosis: what / why / where / when (`11_diagnose.py offline`)
- ✅ Real-time replay diagnosis + offline fault-injection eval (`11_diagnose.py realtime/eval`)
- ✅ Paired significance tests (bootstrap + McNemar) (`08_report.py significance`)
- ⏭️ Data collection in progress (esp. more `payload_heavy_drop` runs for a dedicated two-stage model)
- ⏭️ Next candidates: two-stage drop detector; long-run prognostics (temperature/wear forecasting)

---

## ⚠️ Known Limitations

- **Gripper telemetry:** all `gripper_*` columns currently NULL (RG2 integration deferred to Phase 2)
- **Phase tag from controller:** not used; phase is inferred from signal patterns (~85-90% accuracy)
- **Some PolyScope fields unavailable:** `actual_tcp_acceleration` (PolyScope 5.23+), `tool_temperature`, `collision_detection_ratio`, and a few others

---

## 🛠️ Troubleshooting

**`Connection refused` when starting publisher**
The robot is powered off or the IP is wrong. Check `ping <robot_ip>` and confirm the robot is initialized and in remote control mode.

**Sample rate drops below 125 Hz**
Usually a network issue — try wired Ethernet instead of WiFi. WiFi can introduce jitter that breaks the RTDE timing.

**`ImportError: pyarrow`**
Run `pip install pyarrow` for fast parquet I/O. The pipeline automatically falls back to CSV if pyarrow is missing.

**Foreign key violation on first telemetry batch**
The `experiment_runs` row must exist before telemetry inserts. `ur3_publisher.py` handles this automatically at startup — if it fails, check the DB is up: `docker-compose ps`.

**`pg_dump: warning: there are circular foreign-key constraints`**
Normal for TimescaleDB — the backup is still valid. When restoring, use the `--disable-triggers` flag as shown in the Restore section.

**Restore fails with "extension timescaledb already exists" or similar**
Use Option 2 (fresh start) in the Restore section — it wipes everything first so the restore can rebuild from scratch.

**Restore fails with "role ur_admin does not exist"**
The database role wasn't created. Make sure docker-compose has fully started before restoring — wait 10–15 seconds after `docker-compose up -d`.

---

## 🚀 Full pipeline cheat-sheet

```bash
# --- DATA: prep -> windows (01_data.py has 3 sub-commands) ---
python 01_data.py prep
python 01_data.py visualize --all
python 01_data.py windows

# --- generate synthetic data with all three methods (02_generate.py <method>) ---
python 02_generate.py ssgvae
python 02_generate.py smotenc
python 02_generate.py timegan

# --- classifier showdown per method (+ real-only baseline) ---
python 03_train_classifiers.py --no-aug
python 03_train_classifiers.py --method ssgvae
python 03_train_classifiers.py --method smotenc
python 03_train_classifiers.py --method timegan

# --- validate + compare (for the paper) ---
python 07_validate.py embeddings
python 07_validate.py temporal          # ACF / cross-channel / PSD / DTW fidelity
python 07_validate.py novelty           # precision/recall + PCA/kPCA overlap
python 08_report.py compare
python 04_plot_synthetic.py all --overlay --all
python 08_report.py xlsx                # 3-method Excel workbook
python 08_report.py perclass            # baseline delta + per-class / rare-class F1
python 08_report.py significance        # paired bootstrap + McNemar (needs saved preds)
python 08_report.py figures             # class-distribution + protocol figures
# python 09_ablation.py budget --methods smotenc --restore   # optional (regenerates bundles)
python 09_ablation.py ratio             # imbalance ratio + how-much-synthetic knee

# --- MODELING: train final models for deployment (train / evaluate / export) ---
python 10_model.py train --method smotenc --models rf,cnn --seeds 3
python 10_model.py evaluate --models rf,cnn
python 10_model.py export               # self-contained rf.onnx (+ --cnn) + verify -> deploy_onnx/

# --- root-cause diagnosis: what / why / where / when ---
python 11_diagnose.py offline --run payload_heavy_drop_001
python 11_diagnose.py offline --all-anomaly-runs

# --- Phase F: injected-fault detection, scored offline (no urSim needed) ---
python 11_diagnose.py eval --warn 0.7        # -> faultsim/eval_report.json + eval_timeline.png

# --- diagnosis on a real recorded run (auto-saves to live_runs/) ---
python 11_diagnose.py realtime --replay friction_band_004 --log-all --warn 0.7
python 11_diagnose.py plot live_runs/<log>.jsonl --warn 0.7      # plot the realtime log

# --- QA + explainability ---
python 04_plot_synthetic.py single --all
python 05_anomaly_heatmap.py --train
python 05_anomaly_heatmap.py --scan-all
# XAI on the FINAL deployed model (CNN ensemble + frozen scaler from 10_model train):
python 05_anomaly_heatmap.py --final --scan-all
```
