#!/usr/bin/env bash
set -euo pipefail

DB=ur_anomaly
DUMP=/dump/ur_anomaly_20260616.dump
U=ur_admin

echo "=============================================="
echo "[1/5] DROP + CREATE database"
echo "=============================================="
psql -U "$U" -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $DB WITH (FORCE);"
psql -U "$U" -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DB;"

echo "=============================================="
echo "[2/5] timescaledb_pre_restore()"
echo "=============================================="
psql -U "$U" -d "$DB" -v ON_ERROR_STOP=1 -c "SELECT timescaledb_pre_restore();"

echo "=============================================="
echo "[3/5] pg_restore  (10-20 นาที อย่าปิดหน้าต่าง)"
echo "=============================================="
pg_restore -U "$U" -d "$DB" --no-owner --no-privileges --exit-on-error "$DUMP"

echo "=============================================="
echo "[4/5] timescaledb_post_restore()"
echo "=============================================="
psql -U "$U" -d "$DB" -v ON_ERROR_STOP=1 -c "SELECT timescaledb_post_restore();"

echo "=============================================="
echo "[5/5] ตรวจผล"
echo "=============================================="
ROWS=$(psql -U "$U" -d "$DB" -tAc "SELECT count(*) FROM telemetry;" | tr -d '[:space:]')
RUNS=$(psql -U "$U" -d "$DB" -tAc "SELECT count(*) FROM experiment_runs;" | tr -d '[:space:]')

echo "telemetry       = $ROWS"
echo "experiment_runs = $RUNS"
echo

if [ "$ROWS" = "2448566" ]; then
  echo ">>> OK - ข้อมูลถูกต้อง 2,448,566 แถว"
else
  echo ">>> ไม่ตรงเป้า (คาดไว้ 2448566) - อย่ารันซ้ำทับ ส่งผลนี้ให้ Claude ดูก่อน"
  exit 1
fi
