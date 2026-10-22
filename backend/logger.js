// ============================================================
// Logger — subscribe MQTT แล้วเก็บ payload ดิบลง raw_messages
//
// เก็บเฉพาะ payload ดิบ ยังไม่แตกเป็น signals
// เพราะถ้าแตกทุก field จะได้หลายร้อยแถว/วินาที = หลายล้านแถว/วัน
// ซึ่งเกินจำเป็นมาก — ดึงค่าจาก JSONB ทีหลังได้อยู่แล้ว เช่น
//   SELECT ts, (payload->'actual_q'->>0)::float FROM raw_messages;
// จะแตกลง signals ตอนมี device profile แล้วค่อยเลือกเฉพาะตัวที่ใช้จริง
// ทำงานใน container dt-api เดียวกับ API (index.js เรียก startLogger ตอนเริ่ม)
// ============================================================
// ไลบรารี MQTT ของ Node
import mqtt from 'mqtt';

// ── ค่าตั้งจาก environment (docker-compose.yml → service api) ──
// ที่อยู่ broker — "mqtt" คือชื่อ service ใน docker-compose
const MQTT_URL       = process.env.MQTT_URL || 'mqtt://mqtt:1883';
// เก็บกี่ข้อความ/วินาทีต่อ topic (ตอนนี้ compose ตั้ง 10) — ไม่ตั้ง = 5
const LOG_HZ         = Number(process.env.LOG_HZ || 5);
// เก็บข้อมูลดิบย้อนหลังกี่วัน เกินนี้ลบ
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 7);

// แปลงข้อความ "a, b,c" เป็น ['a','b','c'] (ตัดช่องว่าง ตัดตัวว่าง)
const list = (v) => (v || '').split(',').map(s => s.trim()).filter(Boolean);

// topic ที่ฟัง — ไม่ตั้ง = '#' (ทุก topic)
const LOG_TOPICS  = list(process.env.LOG_TOPICS) .length ? list(process.env.LOG_TOPICS) : ['#'];
// field ที่ไม่มีประโยชน์ ตัดทิ้งก่อนเก็บเพื่อให้แถวเล็กลง
// compose ตั้งไว้ "target_q,track_err,tcp_force" — ตั้งผ่าน env จะได้ไม่ผูกชื่อ field ของหุ่นรุ่นใดไว้ในโค้ด
// payload ปัจจุบันไม่มีช่อง track_err กับ tcp_force (แรงอยู่ใน actual_tcp_force) จึงตัดจริงแค่ target_q
// ⚠ target_q เคยซ้ำกับ actual_q ตอนใช้ URSim แต่ข้อมูลหุ่นจริงไม่ซ้ำ (DIAGNOSIS ใช้ส่วนต่าง)
//   ตัดแค่ขาลง DB เว็บยังได้ครบ — ถ้าจะวิเคราะห์คลาดเคลื่อนย้อนหลังจาก DB ต้องเอาออกจากรายการ
const DROP_FIELDS = list(process.env.DROP_FIELDS);

// ============================================================
// สรุปสุขภาพรายวัน — daily_health
//
// raw_messages ถูกลบเมื่อเกิน RETENTION_DAYS แต่ค่าสรุปรายวันเก็บถาวร
// ใช้ดูแนวโน้มการเสื่อมระยะยาว (ร้อนขึ้นเหนือห้องมากขึ้นทีละน้อยข้ามสัปดาห์ = เริ่มเสื่อม)
// วันละ 6 แถวต่อที่มา เก็บ 10 ปียังไม่ถึง 50,000 แถว
// source แยก replay (ข้อมูลเพื่อนเล่นซ้ำ มีช่อง true_label) ออกจากหุ่นจริง ไม่ให้ปนกัน
// ============================================================
// topic ที่มีอุณหภูมิ — สรุปเฉพาะ topic นี้
const HEALTH_TOPIC = process.env.HEALTH_TOPIC || 'ur/telemetry';
const REPORT_TZ    = process.env.REPORT_TZ    || 'Asia/Bangkok';   // วันตามเวลาไทย

// ── ensureDailyTable — สร้างตาราง daily_health ถ้ายังไม่มี (1 แถว = วัน × ที่มา × ข้อ) ──
// PRIMARY KEY (day, source, joint) — วันเดียวกัน ที่มาเดียวกัน ข้อเดียวกัน มีได้แถวเดียว
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

// ── summarizeDaily — สรุปอุณหภูมิ/กระแสรายข้อรายวันจาก raw_messages ลง daily_health ──
// สรุปซ้ำได้ไม่ซ้ำแถว (ON CONFLICT ทับค่าเดิม) จึงรันทุกชั่วโมงได้
// since = null → สรุปทุกวันที่ยังมีใน raw_messages (ตอนเริ่ม) · ปกติสรุปเมื่อวาน + วันนี้
// SQL 3 ขั้น: s = เลือกข้อความที่มีอุณหภูมิ แปะวันที่ (เวลาไทย) และที่มา
//            x = แตก 1 ข้อความเป็น 6 แถว (ข้อละแถว) ดึงอุณหภูมิกับกระแสของข้อนั้น
//            INSERT = จับกลุ่มตาม วัน × ที่มา × ข้อ หา ต่ำสุด/สูงสุด/เฉลี่ย แล้วเขียนลงตาราง
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
    // จำนวนแถวที่เขียน/ทับ
    return r.rowCount;
}

// ย้อน 48 ชม. ครอบทั้งเมื่อวานและวันนี้ตามเวลาไทยเสมอ — สรุปซ้ำทุกชั่วโมง ข้ามเที่ยงคืนแล้วไม่ตกหล่น
const sinceYesterday = () => new Date(Date.now() - 2 * 86_400_000);

// ── startLogger — ต่อ MQTT แล้วเก็บทุกข้อความลง raw_messages (หรี่เหลือ LOG_HZ ต่อ topic) ──
// พร้อมรายงานทุก 10 วิ · สรุปรายวัน + ลบข้อมูลเก่าเกิน RETENTION_DAYS ทุกชั่วโมง
export function startLogger(db) {
    // ระยะห่างขั้นต่ำระหว่างข้อความที่เก็บ (ms) เช่น 10 Hz → 100 ms
    const minGapMs  = 1000 / LOG_HZ;
    const lastSaved = new Map();          // topic → เวลาที่เก็บล่าสุด (หรี่ความถี่แยกต่อ topic)
    // ตัวนับไว้รายงาน: เก็บได้ · ข้าม · เขียนไม่สำเร็จ
    let saved = 0, skipped = 0, failed = 0;

    // ต่อ broker — clientId สุ่ม กันชนกับ client อื่น
    const client = mqtt.connect(MQTT_URL, {
        clientId: `dt-logger-${Math.random().toString(16).slice(2)}`,
    });

    // ต่อได้ → subscribe topic ที่ตั้งไว้ แล้วพิมพ์ค่าที่ใช้
    client.on('connect', () => {
        console.log(`[LOG] connected ${MQTT_URL}`);
        client.subscribe(LOG_TOPICS, (err, granted) => {
            if (err) return console.error('[LOG] subscribe error:', err.message);
            console.log('[LOG] subscribed:', granted.map(g => g.topic).join(' '));
            console.log(`[LOG] เก็บ ${LOG_HZ} Hz | ตัดทิ้ง: ${DROP_FIELDS.join(',') || '(ไม่ตัด)'} | เก็บย้อนหลัง ${RETENTION_DAYS} วัน`);
        });
    });

    client.on('error', (e) => console.error('[LOG] mqtt error:', e.message));

    // ── ทุกข้อความที่เข้ามา ──
    client.on('message', async (topic, buf) => {
        // ── หรี่ความถี่ ──
        // เว็บยังได้ครบทุกข้อความ (125 Hz) ตรงนี้กรองเฉพาะขาที่จะลง DB
        const now = Date.now();
        if (now - (lastSaved.get(topic) || 0) < minGapMs) { skipped++; return; }
        lastSaved.set(topic, now);

        // แปลงเป็น JSON
        let payload;
        try { payload = JSON.parse(buf.toString()); }
        catch { return; }                                   // ไม่ใช่ JSON ก็ไม่เก็บ
        if (typeof payload !== 'object' || payload === null) return;
        // ข้อมูลโหมดเร่งเวลาเป็นแถวที่ข้ามมา ไม่ใช่การทำงานจริง ไม่เก็บลง DB
        if (payload.ff > 1) { skipped++; return; }

        // ลบ field ที่ตั้งให้ตัดทิ้ง
        for (const f of DROP_FIELDS) delete payload[f];

        // เขียน 1 แถว: topic · run_id · label (ถ้ามี) · payload ทั้งก้อนเป็น JSONB
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
            // นับใหม่รอบถัดไป
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
        // ลบแถวที่เก่ากว่า RETENTION_DAYS วัน
        try {
            const r = await db.query(
                'DELETE FROM raw_messages WHERE ts < NOW() - make_interval(days => $1)',
                [RETENTION_DAYS]
            );
            if (r.rowCount) console.log(`[LOG] ลบข้อมูลเก่า ${r.rowCount} แถว`);
        } catch (e) { console.error('[LOG] purge error:', e.message); }
    };
    // สร้างตาราง → สรุปย้อนหลังทุกวันที่ยังเหลือ → ค่อยเริ่มลบ (ลบก่อนจะสรุปไม่ทัน)
    // .finally = ไม่ว่าขั้นก่อนสำเร็จหรือ error ก็เริ่มรอบลบ แล้วตั้งให้ทำซ้ำทุก 3,600,000 ms (1 ชม.)
    ensureDailyTable(db)
        .then(() => summarizeDaily(db, null))
        .then(n => console.log(`[LOG] สรุปรายวันย้อนหลัง ${n} แถว`))
        .catch(e => console.error('[LOG] daily_health error:', e.message))
        .finally(() => { purge(); setInterval(purge, 3_600_000); });
}
