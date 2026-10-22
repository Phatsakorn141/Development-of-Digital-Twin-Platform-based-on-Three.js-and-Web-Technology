// ============================================================
// Digital Twin Backend — API
//
// REST API ให้หน้าเว็บ: เก็บไฟล์โมเดล (.glb) + project (.dtwp) + ดูข้อมูลที่ logger เก็บ
//   /api/health · /api/stats · /api/models · /api/projects · /api/health/daily
// พร้อมกันนั้นเริ่ม logger (logger.js) เก็บข้อความ MQTT ลง Postgres
// รันใน docker container dt-api (port 3001) — ตาราง DB สร้างจาก db/init/01_schema.sql
// ============================================================
// express = เว็บเซิร์ฟเวอร์ทำ REST API
import express from 'express';
// cors = อนุญาตให้หน้าเว็บที่อยู่คนละ port เรียก API ได้
import cors from 'cors';
// pg = ไลบรารีต่อ PostgreSQL
import pg from 'pg';
// multer = รับไฟล์ที่อัปโหลดแบบ multipart/form-data
import multer from 'multer';
// crypto ของ Node — สร้าง UUID และ sha256
import crypto from 'node:crypto';
// fs/promises เขียนไฟล์ลงดิสก์ · path ต่อชื่อ path ให้ถูก
import fs from 'node:fs/promises';
import path from 'node:path';
// ตัวเก็บข้อความ MQTT ลง DB (ไฟล์ logger.js)
import { startLogger } from './logger.js';

// port ของ API — docker-compose ตั้ง PORT=3001
const PORT = process.env.PORT || 3001;

// ── ต่อ Postgres ──
// DATABASE_URL ชี้ไปที่ host ชื่อ "db" ซึ่งคือชื่อ service ใน docker-compose
// ห้ามใช้ localhost เพราะในมุมมองของ container นี้ localhost คือตัวมันเอง
// Pool = เปิดการเชื่อมต่อค้างไว้หลายเส้น ใช้ซ้ำได้ ไม่ต้องต่อใหม่ทุก request
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// สร้างแอป express
const app = express();

// เว็บเสิร์ฟจาก :3000 แต่ API อยู่ :3001 → คนละ origin
// ถ้าไม่เปิด CORS เบราว์เซอร์จะบล็อกทุก request โดยไม่บอกสาเหตุที่ชัดเจน
app.use(cors());

// อ่าน body ที่เป็น JSON ให้อัตโนมัติ (req.body)
// .dtwp ปกติ ~4 KB แต่ตั้งเผื่อไว้ ค่า default ของ express คือ 100 KB
app.use(express.json({ limit: '20mb' }));

// ── ที่เก็บไฟล์โมเดล ──
// เก็บลงดิสก์ ไม่ใช่ลง Postgres — ไฟล์ 9.5 MB ถ้ายัดลง DB จะทำให้ backup ช้าและ DB บวม
// /data/models อยู่ใน docker volume modelfiles — ลบ container แล้วไฟล์ไม่หาย
const MODELS_DIR = process.env.MODELS_DIR || '/data/models';

// memoryStorage — รับไฟล์เข้า RAM ก่อนเพื่อคำนวณ sha256 หาไฟล์ซ้ำ
// ไฟล์ .glb ปกติ ~10 MB ถือว่าเล็กพอที่จะทำแบบนี้ได้
const upload = multer({
    storage: multer.memoryStorage(),
    limits:  { fileSize: 50 * 1024 * 1024 },   // กันอัปไฟล์ยักษ์จนหน่วยความจำเต็ม
});

// ── health check ──
// เรียกดูได้จากเบราว์เซอร์ตรงๆ ใช้แยกว่าปัญหาอยู่ที่ API หรือที่ DB
// GET /api/health → { ok, db, time }
app.get('/api/health', async (req, res) => {
    try {
        // คำสั่งง่ายสุด ถ้าตอบได้แปลว่าต่อ DB ได้
        const r = await db.query('SELECT NOW() AS now');
        res.json({ ok: true, db: true, time: r.rows[0].now });
    } catch (e) {
        // ตอบ 500 พร้อมข้อความจริง จะได้ไม่ต้องเดาว่าต่อ DB ไม่ได้เพราะอะไร
        res.status(500).json({ ok: false, db: false, error: e.message });
    }
});

// ── ดูสถานะการเก็บข้อมูล ──
// เปิดจากเบราว์เซอร์ได้ตรงๆ ใช้ยืนยันว่าข้อมูลลง DB จริง
// GET /api/stats → จำนวนแถว · เก่าสุด/ใหม่สุด · กี่ run · ขนาดตาราง
app.get('/api/stats', async (req, res) => {
    try {
        // นับจาก raw_messages ทั้งหมดในคำสั่งเดียว (pg_size_pretty แปลงขนาดเป็น "12 MB")
        const r = await db.query(`
            SELECT
              (SELECT COUNT(*)               FROM raw_messages) AS raw_count,
              (SELECT MIN(ts)                FROM raw_messages) AS oldest,
              (SELECT MAX(ts)                FROM raw_messages) AS newest,
              (SELECT COUNT(DISTINCT run_id) FROM raw_messages) AS runs,
              pg_size_pretty(pg_total_relation_size('raw_messages')) AS size
        `);
        res.json(r.rows[0]);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================================
// Models — ไฟล์ .glb
// ============================================================

// ── อัปโหลดโมเดล ──
// POST /api/models (form field ชื่อ file) → ข้อมูลโมเดล + reused (ไฟล์ซ้ำไหม)
// หน้าเว็บเรียกตอนกด Save to server (saveToServer ใน app.js)
app.post('/api/models', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'ไม่มีไฟล์ — ต้องส่ง form field ชื่อ file' });

        // ลายนิ้วมือของไฟล์ — เนื้อไฟล์เหมือนกันได้ค่าเดียวกันเสมอ
        const sha = crypto.createHash('sha256').update(req.file.buffer).digest('hex');

        // อัปไฟล์เดิมซ้ำ → คืนตัวเก่าไปเลย ไม่เก็บซ้ำ
        // ป้องกันไฟล์ 9.5 MB กองเต็มดิสก์เพราะกด Save หลายรอบ
        const dup = await db.query('SELECT * FROM models WHERE sha256 = $1', [sha]);
        if (dup.rowCount) return res.json({ ...dup.rows[0], reused: true });

        // ไฟล์ใหม่ → ตั้ง id สุ่ม แล้วเขียนลงดิสก์เป็น <id>.glb
        const id = crypto.randomUUID();
        await fs.mkdir(MODELS_DIR, { recursive: true });
        await fs.writeFile(path.join(MODELS_DIR, `${id}.glb`), req.file.buffer);

        // บันทึกข้อมูลกำกับลงตาราง models ($1..$4 = ค่าที่ส่งแยก กัน SQL injection)
        const r = await db.query(
            'INSERT INTO models (id, filename, size_bytes, sha256) VALUES ($1,$2,$3,$4) RETURNING *',
            [id, req.file.originalname, req.file.size, sha]
        );
        res.json({ ...r.rows[0], reused: false });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── รายชื่อโมเดล ──
// GET /api/models → ทุกโมเดล ใหม่สุดก่อน
app.get('/api/models', async (req, res) => {
    try {
        const r = await db.query('SELECT * FROM models ORDER BY uploaded_at DESC');
        res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ส่งไฟล์ .glb ให้เบราว์เซอร์โหลดเข้า Three.js ──
// GET /api/models/:id/file — ใช้ตอนเปิด project จาก server (loadFromServer ใน app.js)
app.get('/api/models/:id/file', async (req, res) => {
    try {
        // เช็คก่อนว่ามีโมเดลนี้ในตาราง
        const r = await db.query('SELECT filename FROM models WHERE id = $1', [req.params.id]);
        if (!r.rowCount) return res.status(404).json({ error: 'ไม่พบโมเดล' });
        // บอกชนิดไฟล์ว่าเป็น glTF แบบ binary แล้วส่งไฟล์จากดิสก์
        res.type('model/gltf-binary');
        res.sendFile(path.join(MODELS_DIR, `${req.params.id}.glb`));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// Projects — เนื้อหา .dtwp
// ============================================================

// ── รายชื่อ project พร้อมชื่อไฟล์โมเดลที่ผูกอยู่ ──
// GET /api/projects — LEFT JOIN: project ที่โมเดลถูกลบไปแล้วก็ยังแสดง
app.get('/api/projects', async (req, res) => {
    try {
        const r = await db.query(`
            SELECT p.id, p.name, p.model_id, p.updated_at,
                   m.filename AS model_filename
            FROM projects p
            LEFT JOIN models m ON m.id = p.model_id
            ORDER BY p.updated_at DESC`);
        res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ดึง project มาเปิด ──
// GET /api/projects/:id → ทั้งแถว รวม data (เนื้อหา .dtwp: joint · preset · keyframe · รายการโมเดล)
app.get('/api/projects/:id', async (req, res) => {
    try {
        const r = await db.query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
        if (!r.rowCount) return res.status(404).json({ error: 'ไม่พบ project' });
        res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── บันทึก project ──
// ส่ง id มาด้วย = เขียนทับตัวเดิม, ไม่ส่ง = สร้างใหม่
// ใช้ ON CONFLICT แทนการเช็คก่อนว่ามีหรือยัง เพื่อไม่ให้เกิด race
// POST /api/projects { id?, name, model_id, data }
app.post('/api/projects', async (req, res) => {
    try {
        // ดึงค่าจาก body (|| {} กัน body ว่าง)
        const { id, name, model_id, data } = req.body || {};
        if (!name || !data) return res.status(400).json({ error: 'ต้องมี name และ data' });

        // ไม่มี id = project ใหม่ สร้าง UUID ให้
        const pid = id || crypto.randomUUID();
        // EXCLUDED = ค่าที่พยายามจะ INSERT (ใช้ตอนชนแล้วเปลี่ยนเป็น UPDATE)
        const r = await db.query(`
            INSERT INTO projects (id, name, model_id, data)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (id) DO UPDATE
              SET name = EXCLUDED.name,
                  model_id = EXCLUDED.model_id,
                  data = EXCLUDED.data,
                  updated_at = NOW()
            RETURNING *`,
            [pid, name, model_id || null, data]
        );
        res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── สรุปสุขภาพรายวัน — อุณหภูมิ/กระแสรายข้อ ไม่ถูกลบตาม RETENTION_DAYS ──
// logger สรุปให้ทุกชั่วโมง (logger.js → daily_health)
// GET /api/health/daily?days=30 — หน้าเว็บตอนนี้ไม่ได้เรียกแล้ว เปิดดูจากเบราว์เซอร์ได้
app.get('/api/health/daily', async (req, res) => {
    // จำกัด days ให้อยู่ระหว่าง 1 ถึง 3650 (ไม่ใส่ = 30 วัน)
    const days = Math.min(3650, Math.max(1, Number(req.query.days) || 30));
    try {
        // to_char แปลงวันที่เป็นข้อความ YYYY-MM-DD (ไม่ติดเรื่องเขตเวลาตอนแปลงเป็น JSON)
        const r = await db.query(`
            SELECT to_char(day, 'YYYY-MM-DD') AS day, source, joint, samples, minutes,
                   temp_min, temp_max, temp_avg, current_avg
            FROM daily_health
            WHERE day >= CURRENT_DATE - $1::int
            ORDER BY day DESC, source, joint`, [days]);
        res.json(r.rows);
    } catch (e) {
        if (e.code === '42P01') return res.json([]);    // ตารางยังไม่ถูกสร้าง = ยังไม่มีข้อมูล
        res.status(500).json({ error: e.message });
    }
});

// เริ่มรับ request ที่ port 3001
app.listen(PORT, () => console.log(`[API] listening on :${PORT}`));

// เริ่มเก็บข้อมูลหลัง API พร้อมแล้ว
startLogger(db);    
