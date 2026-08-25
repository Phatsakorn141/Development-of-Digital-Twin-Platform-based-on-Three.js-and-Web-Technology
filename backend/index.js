// ============================================================
// Digital Twin Backend — API
//
// ชุด 2: โครงเปล่าที่รันได้ มี /api/health ตัวเดียว
// ใช้ยืนยันว่า Node ต่อ Postgres ได้ และเบราว์เซอร์เรียกข้าม port ได้
// ============================================================
import express from 'express';
import cors from 'cors';
import pg from 'pg';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startLogger } from './logger.js';

const PORT = process.env.PORT || 3001;

// ── ต่อ Postgres ──
// DATABASE_URL ชี้ไปที่ host ชื่อ "db" ซึ่งคือชื่อ service ใน docker-compose
// ห้ามใช้ localhost เพราะในมุมมองของ container นี้ localhost คือตัวมันเอง
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const app = express();

// เว็บเสิร์ฟจาก :3000 แต่ API อยู่ :3001 → คนละ origin
// ถ้าไม่เปิด CORS เบราว์เซอร์จะบล็อกทุก request โดยไม่บอกสาเหตุที่ชัดเจน
app.use(cors());

// .dtwp ปกติ ~4 KB แต่ตั้งเผื่อไว้ ค่า default ของ express คือ 100 KB
app.use(express.json({ limit: '20mb' }));

// ── ที่เก็บไฟล์โมเดล ──
// เก็บลงดิสก์ ไม่ใช่ลง Postgres — ไฟล์ 9.5 MB ถ้ายัดลง DB จะทำให้ backup ช้าและ DB บวม
const MODELS_DIR = process.env.MODELS_DIR || '/data/models';

// memoryStorage — รับไฟล์เข้า RAM ก่อนเพื่อคำนวณ sha256 หาไฟล์ซ้ำ
// ไฟล์ .glb ปกติ ~10 MB ถือว่าเล็กพอที่จะทำแบบนี้ได้
const upload = multer({
    storage: multer.memoryStorage(),
    limits:  { fileSize: 50 * 1024 * 1024 },   // กันอัปไฟล์ยักษ์จนหน่วยความจำเต็ม
});

// ── health check ──
// เรียกดูได้จากเบราว์เซอร์ตรงๆ ใช้แยกว่าปัญหาอยู่ที่ API หรือที่ DB
app.get('/api/health', async (req, res) => {
    try {
        const r = await db.query('SELECT NOW() AS now');
        res.json({ ok: true, db: true, time: r.rows[0].now });
    } catch (e) {
        // ตอบ 500 พร้อมข้อความจริง จะได้ไม่ต้องเดาว่าต่อ DB ไม่ได้เพราะอะไร
        res.status(500).json({ ok: false, db: false, error: e.message });
    }
});

// ── ดูสถานะการเก็บข้อมูล ──
// เปิดจากเบราว์เซอร์ได้ตรงๆ ใช้ยืนยันว่าข้อมูลลง DB จริง
app.get('/api/stats', async (req, res) => {
    try {
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
app.post('/api/models', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'ไม่มีไฟล์ — ต้องส่ง form field ชื่อ file' });

        const sha = crypto.createHash('sha256').update(req.file.buffer).digest('hex');

        // อัปไฟล์เดิมซ้ำ → คืนตัวเก่าไปเลย ไม่เก็บซ้ำ
        // ป้องกันไฟล์ 9.5 MB กองเต็มดิสก์เพราะกด Save หลายรอบ
        const dup = await db.query('SELECT * FROM models WHERE sha256 = $1', [sha]);
        if (dup.rowCount) return res.json({ ...dup.rows[0], reused: true });

        const id = crypto.randomUUID();
        await fs.mkdir(MODELS_DIR, { recursive: true });
        await fs.writeFile(path.join(MODELS_DIR, `${id}.glb`), req.file.buffer);

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
app.get('/api/models', async (req, res) => {
    try {
        const r = await db.query('SELECT * FROM models ORDER BY uploaded_at DESC');
        res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ส่งไฟล์ .glb ให้เบราว์เซอร์โหลดเข้า Three.js ──
app.get('/api/models/:id/file', async (req, res) => {
    try {
        const r = await db.query('SELECT filename FROM models WHERE id = $1', [req.params.id]);
        if (!r.rowCount) return res.status(404).json({ error: 'ไม่พบโมเดล' });
        res.type('model/gltf-binary');
        res.sendFile(path.join(MODELS_DIR, `${req.params.id}.glb`));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// Projects — เนื้อหา .dtwp
// ============================================================

// ── รายชื่อ project พร้อมชื่อไฟล์โมเดลที่ผูกอยู่ ──
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
app.post('/api/projects', async (req, res) => {
    try {
        const { id, name, model_id, data } = req.body || {};
        if (!name || !data) return res.status(400).json({ error: 'ต้องมี name และ data' });

        const pid = id || crypto.randomUUID();
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

app.listen(PORT, () => console.log(`[API] listening on :${PORT}`));

// เริ่มเก็บข้อมูลหลัง API พร้อมแล้ว
startLogger(db);    