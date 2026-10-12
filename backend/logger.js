// ============================================================
// Logger — subscribe MQTT แล้วเก็บ payload ดิบลง raw_messages
//
// เก็บเฉพาะ payload ดิบ ยังไม่แตกเป็น signals
// เพราะถ้าแตกทุก field ที่ 5 Hz จะได้ ~100 แถว/วินาที = 8.6 ล้านแถว/วัน
// ซึ่งเกินจำเป็นมาก — ดึงค่าจาก JSONB ทีหลังได้อยู่แล้ว เช่น
//   SELECT ts, (payload->'actual_q'->>0)::float FROM raw_messages;
// จะแตกลง signals ตอนมี device profile แล้วค่อยเลือกเฉพาะตัวที่ใช้จริง
// ============================================================
import mqtt from 'mqtt';

const MQTT_URL       = process.env.MQTT_URL || 'mqtt://mqtt:1883';
const LOG_HZ         = Number(process.env.LOG_HZ || 5);
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 7);

const list = (v) => (v || '').split(',').map(s => s.trim()).filter(Boolean);

const LOG_TOPICS  = list(process.env.LOG_TOPICS) .length ? list(process.env.LOG_TOPICS) : ['#'];
// field ที่ไม่มีประโยชน์ ตัดทิ้งก่อนเก็บเพื่อให้แถวเล็กลง
// ของ UR3: target_q ซ้ำกับ actual_q ทุกหลัก ส่วน track_err กับ tcp_force เป็น 0 เสมอ
// ตั้งผ่าน env จะได้ไม่ผูกชื่อ field ของหุ่นรุ่นใดไว้ในโค้ด
const DROP_FIELDS = list(process.env.DROP_FIELDS);

// ============================================================
// สรุปสุขภาพรายวัน — daily_health
//
// raw_messages ถูกลบเมื่อเกิน RETENTION_DAYS แต่ค่าสรุปรายวันเก็บถาวร
// ใช้ดูแนวโน้มการเสื่อมระยะยาว (ร้อนขึ้นเหนือห้องมากขึ้นทีละน้อยข้ามสัปดาห์ = เริ่มเสื่อม)
// วันละ 6 แถวต่อที่มา เก็บ 10 ปียังไม่ถึง 50,000 แถว
// source แยก replay (ข้อมูลเพื่อนเล่นซ้ำ มีช่อง true_label) ออกจากหุ่นจริง ไม่ให้ปนกัน
// ============================================================
const HEALTH_TOPIC = process.env.HEALTH_TOPIC || 'ur/telemetry';
const REPORT_TZ    = process.env.REPORT_TZ    || 'Asia/Bangkok';   // วันตามเวลาไทย

async function ensureDailyTable(db) {
    await db.query(`
        CREATE TABLE IF NOT EXISTS daily_health (
            day         DATE     NOT NULL,
            source      TEXT     NOT NULL,           -- 'live' หรือ 'replay'
            joint       SMALLINT NOT NULL,           -- 1-6
            samples     INTEGER  NOT NULL,
            minutes     INTEGER  NOT NULL,           -- นาทีที่มีข้อมูล = เวลาทำงานโดยประมาณ
            temp_min    REAL, temp_max REAL, temp_avg REAL,
            current_avg REAL,
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (day, source, joint)
        )`);
}

// since = null → สรุปทุกวันที่ยังมีใน raw_messages (ตอนเริ่ม) · ปกติสรุปเมื่อวาน + วันนี้
async function summarizeDaily(db, since) {
    const r = await db.query(`
        WITH s AS (
            SELECT ts, (ts AT TIME ZONE $2)::date AS day,
                   CASE WHEN payload ? 'true_label' THEN 'replay' ELSE 'live' END AS source,
                   payload
            FROM raw_messages
            WHERE topic = $1
              AND payload ? 'joint_temperatures'
              AND ($3::timestamptz IS NULL OR ts >= $3)
        ), x AS (
            SELECT ts, day, source, j AS joint,
                   (payload->'joint_temperatures'->>(j - 1))::real  AS temp,
                   abs((payload->'actual_current'->>(j - 1))::real) AS cur
            FROM s, generate_series(1, 6) AS j
        )
        INSERT INTO daily_health
            (day, source, joint, samples, minutes, temp_min, temp_max, temp_avg, current_avg)
        SELECT day, source, joint, count(*), count(DISTINCT date_trunc('minute', ts)),
               min(temp), max(temp), avg(temp), avg(cur)
        FROM x WHERE temp IS NOT NULL
        GROUP BY day, source, joint
        ON CONFLICT (day, source, joint) DO UPDATE SET
            samples = EXCLUDED.samples,   minutes  = EXCLUDED.minutes,
            temp_min = EXCLUDED.temp_min, temp_max = EXCLUDED.temp_max,
            temp_avg = EXCLUDED.temp_avg, current_avg = EXCLUDED.current_avg,
            updated_at = NOW()`,
        [HEALTH_TOPIC, REPORT_TZ, since]);
    return r.rowCount;
}

// ย้อน 48 ชม. ครอบทั้งเมื่อวานและวันนี้ตามเวลาไทยเสมอ — สรุปซ้ำทุกชั่วโมง ข้ามเที่ยงคืนแล้วไม่ตกหล่น
const sinceYesterday = () => new Date(Date.now() - 2 * 86_400_000);

export function startLogger(db) {
    const minGapMs  = 1000 / LOG_HZ;
    const lastSaved = new Map();          // topic → เวลาที่เก็บล่าสุด (หรี่ความถี่แยกต่อ topic)
    let saved = 0, skipped = 0, failed = 0;

    const client = mqtt.connect(MQTT_URL, {
        clientId: `dt-logger-${Math.random().toString(16).slice(2)}`,
    });

    client.on('connect', () => {
        console.log(`[LOG] connected ${MQTT_URL}`);
        client.subscribe(LOG_TOPICS, (err, granted) => {
            if (err) return console.error('[LOG] subscribe error:', err.message);
            console.log('[LOG] subscribed:', granted.map(g => g.topic).join(' '));
            console.log(`[LOG] เก็บ ${LOG_HZ} Hz | ตัดทิ้ง: ${DROP_FIELDS.join(',') || '(ไม่ตัด)'} | เก็บย้อนหลัง ${RETENTION_DAYS} วัน`);
        });
    });

    client.on('error', (e) => console.error('[LOG] mqtt error:', e.message));

    client.on('message', async (topic, buf) => {
        // ── หรี่ความถี่ ──
        // เว็บยังได้ 10 Hz เหมือนเดิม ตรงนี้กรองเฉพาะขาที่จะลง DB
        const now = Date.now();
        if (now - (lastSaved.get(topic) || 0) < minGapMs) { skipped++; return; }
        lastSaved.set(topic, now);

        let payload;
        try { payload = JSON.parse(buf.toString()); }
        catch { return; }                                   // ไม่ใช่ JSON ก็ไม่เก็บ
        if (typeof payload !== 'object' || payload === null) return;
        // ข้อมูลโหมดเร่งเวลาเป็นแถวที่ข้ามมา ไม่ใช่การทำงานจริง ไม่เก็บลง DB
        if (payload.ff > 1) { skipped++; return; }

        for (const f of DROP_FIELDS) delete payload[f];

        try {
            await db.query(
                'INSERT INTO raw_messages (topic, run_id, label, payload) VALUES ($1, $2, $3, $4)',
                [topic, payload.run_id ?? null, payload.label ?? null, payload]
            );
            saved++;
        } catch (e) {
            failed++;
            if (failed <= 3) console.error('[LOG] insert error:', e.message);  // พิมพ์แค่ 3 ครั้งแรก กัน log ท่วม
        }
    });

    // ── รายงานทุก 10 วินาที ──
    setInterval(() => {
        if (saved || skipped || failed) {
            console.log(`[LOG] saved=${saved} skipped=${skipped} failed=${failed}`);
            saved = skipped = failed = 0;
        }
    }, 10_000);

    // ── ลบข้อมูลเก่าทุก 1 ชั่วโมง ──
    // ไม่งั้นข้อมูลโตไม่หยุดจนดิสก์เต็ม
    const purge = async () => {
        // สรุปรายวันก่อนลบ — ข้อมูลดิบหายแต่ค่าสรุปยังอยู่
        try {
            const n = await summarizeDaily(db, sinceYesterday());
            if (n) console.log(`[LOG] สรุปรายวัน ${n} แถว`);
        } catch (e) { console.error('[LOG] summarize error:', e.message); }
        try {
            const r = await db.query(
                'DELETE FROM raw_messages WHERE ts < NOW() - make_interval(days => $1)',
                [RETENTION_DAYS]
            );
            if (r.rowCount) console.log(`[LOG] ลบข้อมูลเก่า ${r.rowCount} แถว`);
        } catch (e) { console.error('[LOG] purge error:', e.message); }
    };
    // สร้างตาราง → สรุปย้อนหลังทุกวันที่ยังเหลือ → ค่อยเริ่มลบ (ลบก่อนจะสรุปไม่ทัน)
    ensureDailyTable(db)
        .then(() => summarizeDaily(db, null))
        .then(n => console.log(`[LOG] สรุปรายวันย้อนหลัง ${n} แถว`))
        .catch(e => console.error('[LOG] daily_health error:', e.message))
        .finally(() => { purge(); setInterval(purge, 3_600_000); });
}