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
        try {
            const r = await db.query(
                'DELETE FROM raw_messages WHERE ts < NOW() - make_interval(days => $1)',
                [RETENTION_DAYS]
            );
            if (r.rowCount) console.log(`[LOG] ลบข้อมูลเก่า ${r.rowCount} แถว`);
        } catch (e) { console.error('[LOG] purge error:', e.message); }
    };
    purge();
    setInterval(purge, 3_600_000);
}