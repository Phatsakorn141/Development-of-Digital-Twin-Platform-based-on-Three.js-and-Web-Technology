"""Fit a first-order thermal model to long_run and extrapolate to 2 hours."""
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
import numpy as np, psycopg2
from scipy.optimize import curve_fit

DSN = "host=localhost port=5433 dbname=ur_anomaly user=ur_admin password=password"
conn = psycopg2.connect(DSN)
cur = conn.cursor()

# ดึงค่าเฉลี่ยรายนาทีของทั้ง 6 ข้อ + กระแส
cur.execute("""
    SELECT floor(extract(epoch FROM time - (SELECT min(time) FROM telemetry WHERE run_id='long_run'))/30) AS half_min,
           avg(joint_temperatures[1]), avg(joint_temperatures[2]), avg(joint_temperatures[3]),
           avg(joint_temperatures[4]), avg(joint_temperatures[5]), avg(joint_temperatures[6]),
           avg(sqrt(actual_current[1]^2 + actual_current[2]^2 + actual_current[3]^2
                  + actual_current[4]^2 + actual_current[5]^2 + actual_current[6]^2))
    FROM telemetry WHERE run_id='long_run'
    GROUP BY 1 ORDER BY 1
""")
rows = cur.fetchall()
conn.close()

t = np.array([float(r[0]) * 0.5 for r in rows])     # นาที
T = np.array([[float(r[j + 1]) for j in range(6)] for r in rows])
I = np.array([float(r[7]) for r in rows])

print(f"ข้อมูล {len(t)} จุด ครอบคลุม {t[-1]:.1f} นาที")
print(f"กระแสรวม (L2 ทั้ง 6 ข้อ): เฉลี่ย {I.mean():.3f} A   sd {I.std():.3f}\n")


def model(x, Tinf, T0, tau):
    """T(t) = Tinf - (Tinf - T0) * exp(-t/tau)   — ระบบความร้อนอันดับหนึ่ง"""
    return Tinf - (Tinf - T0) * np.exp(-x / tau)


print(f"{'ข้อ':<5}{'เริ่ม':>8}{'จบ 44นาที':>11}{'ขึ้น':>8}"
      f"{'T_inf':>9}{'tau(นาที)':>11}{'ที่ 2ชม.':>10}{'RMSE':>8}")
print("-" * 72)

results = []
for j in range(6):
    y = T[:, j]
    try:
        p0 = [y[-1] + 3, y[0], 30]
        popt, _ = curve_fit(model, t, y, p0=p0, maxfev=20000)
        Tinf, T0, tau = popt
        rmse = float(np.sqrt(((model(t, *popt) - y) ** 2).mean()))
        at120 = model(120.0, *popt)
        print(f"J{j+1:<4}{y[0]:>8.2f}{y[-1]:>11.2f}{y[-1]-y[0]:>+8.2f}"
              f"{Tinf:>9.1f}{tau:>11.1f}{at120:>10.2f}{rmse:>8.3f}")
        results.append((j + 1, y[-1], at120, Tinf, tau))
    except Exception as e:
        print(f"J{j+1:<4}  ฟิตไม่ได้: {e}")

print("-" * 72)
print("\nคาดการณ์เมื่อเดินต่อเนื่อง 2 ชั่วโมง (120 นาที)")
for j, now, at120, Tinf, tau in results:
    print(f"  J{j}:  {now:.1f}°C ที่ 44 นาที  ->  {at120:.1f}°C ที่ 120 นาที "
          f"(+{at120-now:.2f})   เพดาน {Tinf:.1f}°C")

hot = max(results, key=lambda r: r[2])
print(f"\nข้อที่ร้อนสุด: J{hot[0]} = {hot[2]:.1f}°C ที่ 2 ชม. (เพดานทฤษฎี {hot[3]:.1f}°C)")
print("UR แจ้งว่า joint temperature ปกติทำงานได้ถึงราว 80°C ก่อน derate/protective stop")
