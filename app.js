// ============================================================
// app.js — หน้าเว็บ Digital Twin ของแขนกล UR3 (ไฟล์หลักไฟล์เดียวของฝั่งเว็บ)
//
// ลำดับการทำงานเมื่อเปิดเว็บ:
//   1. โหลด config/params.json (ค่ากลางที่ Python ใช้ร่วม)
//   2. init() → initThree() สร้างฉาก 3D · bindEvents() ผูกปุ่มทั้งหมด
//   3. ผู้ใช้โหลดโมเดล .glb → ถ้าเป็น UR3 ตั้ง joint ให้อัตโนมัติ (autoSetupJoints)
//   4. กด Connect MQTT → รับ ur/telemetry → ขยับโมเดล + วิเคราะห์ (สถานะ · วินิจฉัย · เตือน)
//
// IMPORTS
// three        — Three.js core library สำหรับ 3D rendering
// OrbitControls — ให้ user หมุน/zoom กล้องด้วยเมาส์
// GLTFLoader   — โหลดไฟล์ .glb / .gltf เข้า scene
// TransformControls — gizmo ลูกศรลากย้าย/หมุน/ย่อขยายโมเดล (แถบเครื่องมือกลางหัวเว็บ)
// ที่อยู่จริงของ 'three' กำหนดใน importmap ของ index.html (three@0.160.0 จาก CDN)
// ============================================================
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

// ============================================================
// PARAMS — พารามิเตอร์กลางจาก config/params.json
// ไฟล์เดียวกับที่ฝั่ง Python อ่าน (ai/params.py) แก้ที่นั่นที่เดียวเปลี่ยนทั้งระบบ
// โหลดก่อนโค้ดส่วนอื่นทำงาน (top-level await ใช้ได้เพราะ app.js เป็น module)
// ============================================================
// cache: 'no-store' = ไม่ใช้ไฟล์เก่าใน cache แก้ params.json แล้วรีเฟรชเห็นผลทันที
const PARAMS = await fetch('./config/params.json', { cache: 'no-store' })
    // ตอบกลับไม่ใช่ 200 (เช่น 404 หาไฟล์ไม่เจอ) → โยน error
    .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
    })
    // อ่านไม่ได้ → แจ้งผู้ใช้ แล้วโยน error ต่อ (หยุดโหลดส่วนที่เหลือ เพราะทุกส่วนต้องใช้ PARAMS)
    .catch(e => {
        alert('อ่าน config/params.json ไม่ได้ — ' + e.message
            + '\nเช็คว่าเปิดเว็บผ่าน npx serve และไฟล์อยู่ในโฟลเดอร์ config');
        throw e;
    });
window.PARAMS = PARAMS;      // เปิดดูใน DevTools Console ได้

// ============================================================
// App State — ตัวแปร global ทั้งหมดของแอป
// เก็บไว้ใน object เดียวเพื่อให้ทุก function เข้าถึงได้ง่าย
// ============================================================
const state = {
    // ── Three.js core objects ──
    scene: null,        // Scene หลัก ใส่ไฟ / model / grid ลงไป
    camera: null,       // กล้อง PerspectiveCamera มองเข้า scene
    renderer: null,     // WebGL renderer วาดภาพลง <canvas>
    controls: null,     // OrbitControls รับ input เมาส์ควบคุมกล้อง
    model: null,        // Group "Scene" — รากของทุกโมเดลในฉาก (null = ยังไม่มีโมเดล)

    // ── Node management ──
    nodeMap: new Map(),             // uuid → Three.js Object3D (lookup เร็ว)
    nodeList: [],                   // array ของ { uuid, name, type } สำหรับ UI
    entities: [],                   // โมเดลในฉาก [{ id, name, file, wrap, root, ตำแหน่ง/หมุน/ขนาด }] ตัวแรก = หุ่นหลัก
    entityIdCounter: 0,             // ตัวนับออก id โมเดล ent_1, ent_2, …
    transform: null,                // TransformControls — gizmo ลากย้าย/หมุน/ย่อขยายโมเดล
    toolMode: 'translate',          // translate / rotate / scale
    toolTarget: null,               // entity ที่เลือกอยู่
    toolSnap: false,                // จับระยะทีละ 5 ซม. / 15°
    checkedNodeUUIDs: new Set(),    // uuid ที่ user check ✓ ใน Node Tree

    // ── Joint system ──
    joints: [],                     // array ของ joint object ทั้งหมด
    originalTransforms: new Map(),  // uuid → { position, rotation, visible } ค่าตอนโหลดครั้งแรก
    jointIdCounter: 0,              // auto-increment id ให้ joint ใหม่ (joint_0, joint_1 ...)

    // ── Sensor simulation ── (ปุ่มเล่นบนหัวเว็บถูกแทนด้วยแถบเครื่องมือแล้ว โค้ดยังอยู่แต่ไม่มีที่สั่งเริ่ม)
    simRunning: false,      // true = simulation กำลังเล่น
    simSpeed: 1.0,          // ตัวคูณความเร็ว sim (0.1× – 5×)
    simStartTime: 0,        // performance.now()/1000 ตอน start sim (ใช้คำนวณ elapsed)

    // ── Presets ── (ท่าที่บันทึกไว้ กดแล้วหุ่นไปท่านั้น)
    presets: [],            // array ของ preset object { id, name, values, savedAt }
    presetIdCounter: 0,     // auto-increment id ให้ preset ใหม่

    // ── Keyframe animation ── (ท่าเรียงตามเวลา เล่นต่อกันเป็นแอนิเมชัน)
    keyframes: [],          // array ของ keyframe { id, time, values }
    keyframeIdCounter: 0,   // auto-increment id ให้ keyframe ใหม่
    animPlaying: false,     // true = animation กำลังเล่น
    animStartTime: 0,       // timestamp ตอน play (ใช้คำนวณ elapsed)
    animLoop: false,        // true = loop ต่อเนื่องเมื่อถึง keyframe สุดท้าย

    // ── Project / Model บน server ──
    modelBlob:   null,   // ไฟล์ .glb ของหุ่นหลัก (โมเดลตัวแรก) — เก็บไว้ส่งขึ้น server ตอน Save
    modelId:     null,   // id หุ่นหลักบน server (null = ยังไม่เคยอัป) — โมเดลอื่นเก็บ id ใน entity ของตัวเอง
    projectId:   null,   // id project ที่เปิดอยู่ (null = ยังไม่เคยบันทึก)
    projectName: '',     // ชื่อ project

    // ── MQTT ──
    editingJointId: null,   // null = โหมดสร้างใหม่, มีค่า = กำลังแก้ joint ตัวนั้น
    mqttPaused: false,      // true = ยังรับ message แต่ไม่ apply ลงโมเดล (ใช้ตอน Calibrate)
    lastPayloads: {},       // topic → { payload, count, ts } สำหรับ Payload Inspector
    inspectorTimer: null,   // timer อัปเดตค่าสดใน inspector (รันเฉพาะตอนเปิด modal)
    // ── สถิติคุณภาพการรับข้อมูล ──
    netStats: {
        arrivals:  [],      // เวลาที่ข้อความมาถึง (ms) เก็บ 5 วินาทีล่าสุด
        latencies: [],      // latency ของแต่ละข้อความ (ms)
        lastSeq:   null,    // seq ล่าสุด ใช้ตรวจข้อความหาย
        lost:      0,       // จำนวนข้อความที่หายสะสม
        timer:     null,    // timer วาดแถบทุก 1 วินาที
    },
    mqttClient: null,       // mqtt.js client instance (null = ยังไม่ได้เชื่อมต่อ)
    mqttConnected: false,   // true = เชื่อมต่อ broker อยู่
};

// ============================================================
// DOM References — เก็บ element ที่ใช้บ่อยไว้ล่วงหน้า
// เพื่อไม่ต้อง querySelector ซ้ำทุกครั้งที่ต้องการ
// ชื่อ id ทั้งหมดอยู่ใน index.html
// ============================================================
const dom = {
    // viewport (พื้นที่ภาพ 3D ตรงกลาง)
    canvas: document.getElementById('three-canvas'),
    viewportContainer: document.getElementById('viewport-container'),
    viewportOverlay: document.getElementById('viewport-overlay'),       // overlay "No Model Loaded"

    // upload button + file input
    btnUpload: document.getElementById('btn-upload'),
    fileInput: document.getElementById('file-input'),
    btnAddModel:  document.getElementById('btn-add-model'),    // เพิ่มโมเดลเข้าฉากเดิม
    addFileInput: document.getElementById('add-file-input'),
    sceneList:    document.getElementById('scene-list'),       // แผง SCENE ในแถบซ้าย
    panelLeft:     document.getElementById('panel-left'),        // แผง Node Tree (หุบได้)
    btnToggleLeft: document.getElementById('btn-toggle-left'),

    // node tree panel
    nodeTreeContainer: document.getElementById('node-tree-container'),

    // joints panel
    jointsContainer: document.getElementById('joints-container'),
    btnAddJoint: document.getElementById('btn-add-joint'),
    selectionCount: document.getElementById('selection-count'),         // "N selected" badge

    // แถบเครื่องมือจัดฉาก (header center) — แทนแถบ simulation เดิม
    sceneTools: document.getElementById('scene-tools'),
    toolSnap:   document.getElementById('tool-snap'),
    toolTarget: document.getElementById('tool-target'),

    // Add Joint modal (หน้าต่างสร้าง/แก้ joint)
    modalOverlay: document.getElementById('modal-overlay'),
    modalTitle: document.getElementById('modal-title'),   // หัวข้อ modal — สลับข้อความตามโหมด
    modalClose: document.getElementById('modal-close'),
    modalCancel: document.getElementById('modal-cancel'),
    modalConfirm: document.getElementById('modal-confirm'),
    jointName: document.getElementById('joint-name'),
    jointType: document.getElementById('joint-type'),
    jointCoupledTarget: document.getElementById('joint-coupled-target'),
    jointCoupledRatio: document.getElementById('joint-coupled-ratio'),
    coupledGroup: document.getElementById('coupled-group'),             // แถวตั้งค่า coupled joint
    jointProperty: document.getElementById('joint-property'),
    jointMin: document.getElementById('joint-min'),
    jointMax: document.getElementById('joint-max'),
    jointStep: document.getElementById('joint-step'),
    jointSimPattern: document.getElementById('joint-sim-pattern'),
    jointSimFreq: document.getElementById('joint-sim-freq'),
    jointSrcTopic: document.getElementById('joint-src-topic'),   // topic ที่ joint นี้ฟัง
    jointSrcPath:  document.getElementById('joint-src-path'),    // ตำแหน่งค่าใน payload
    jointScale:    document.getElementById('joint-scale'),       // ตัวคูณแปลงหน่วย
    jointInvert:   document.getElementById('joint-invert'),      // กลับทิศ
    jointOffset:   document.getElementById('joint-offset'),      // เลื่อนจุดศูนย์
    jointUnit:     document.getElementById('joint-unit'),        // หน่วยของค่าหลังแปลงแล้ว
    simFreqGroup: document.getElementById('sim-freq-group'),            // แถว period (ซ่อนถ้า pattern=none)
    jointPivotNode: document.getElementById('joint-pivot-node'),
    pivotGroup: document.getElementById('pivot-group'),                 // แถว pivot dropdown (ซ่อนถ้า single node)
    modalLinkedNodes: document.getElementById('modal-linked-nodes'),    // แสดง chip ของ node ที่เลือก

    // tabs (แท็บของแผงขวา)
    tabJoints: document.getElementById('tab-joints'),
    tabPresets: document.getElementById('tab-presets'),
    tabAnimation: document.getElementById('tab-animation'),

    // project export/import
    btnExportProject: document.getElementById('btn-export-project'),
    btnImportProject: document.getElementById('btn-import-project'),
    projectFileInput: document.getElementById('project-file-input'),

    // presets tab
    btnSavePreset: document.getElementById('btn-save-preset'),
    presetsContainer: document.getElementById('presets-container'),

    // animation tab
    btnAddKeyframe: document.getElementById('btn-add-keyframe'),
    btnPlayAnim: document.getElementById('btn-play-anim'),
    animLoopChk: document.getElementById('anim-loop'),
    animTimecode: document.getElementById('anim-timecode'),             // แสดง "1.23s / 5.00s"
    animationContainer: document.getElementById('animation-container'),

    // viewport info bar (bottom-left)
    infoVertices: document.getElementById('info-vertices'),
    infoMeshes: document.getElementById('info-meshes'),
    infoNodes: document.getElementById('info-nodes'),

    // MQTT panel (header right)
    btnMqttToggle:  document.getElementById('btn-mqtt-toggle'),   // ปุ่มเปิด/ปิด panel
    mqttPanel:      document.getElementById('mqtt-panel'),         // panel กรอก credentials
    mqttUrl:        document.getElementById('mqtt-url'),           // input broker URL
    mqttUser:       document.getElementById('mqtt-user'),          // input username
    mqttPass:       document.getElementById('mqtt-pass'),          // input password
    btnMqttConnect: document.getElementById('btn-mqtt-connect'),   // ปุ่ม Connect/Disconnect
    btnMqttPause:   document.getElementById('btn-mqtt-pause'),    // ปุ่มหยุด/รับข้อมูลต่อ
    mqttStatus:     document.getElementById('mqtt-status'),        // badge แสดงสถานะ
    mqttDiscover:     document.getElementById('mqtt-discover'),      // checkbox ฟังทุก topic
    payloadInspector: document.getElementById('payload-inspector'),  // กล่องแสดง payload สด
    netStats:         document.getElementById('net-stats'),          // แถบสถิติมุมขวาล่าง
    btnSaveServer:  document.getElementById('btn-save-server'),   // ปุ่มบันทึกขึ้น server
    btnOpenServer:  document.getElementById('btn-open-server'),   // ปุ่มเปิดจาก server
    serverOverlay:  document.getElementById('server-overlay'),    // กล่องเลือก project
    serverList:     document.getElementById('server-list'),       // รายการ project ในกล่อง
    serverClose:    document.getElementById('server-close'),      // ปุ่มปิดกล่อง
};

// ============================================================
// Three.js Setup — สร้าง scene, camera, renderer, lights, grid
// เรียกครั้งเดียวตอน init()
// ============================================================
function initThree() {
    // ── Scene ──
    state.scene = new THREE.Scene();
    state.scene.background = new THREE.Color(0x0f1117);   // สีพื้นหลัง dark navy

    // ── Camera ── PerspectiveCamera(fov, aspect, near, far)
    // มุมมอง 45° · aspect=1 ชั่วคราว (จะ update ใน handleResize()) · เห็นตั้งแต่ 1 ซม. ถึง 1000 ม.
    state.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    state.camera.position.set(3, 2, 5);  // ตำแหน่งเริ่มต้น (โหลดโมเดลแล้ว frameScene ย้ายให้พอดีฉาก)

    // ── Renderer ──
    // วาดลง <canvas id="three-canvas"> · antialias = ขอบเรียบ
    state.renderer = new THREE.WebGLRenderer({ canvas: dom.canvas, antialias: true, alpha: false });
    state.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));  // ป้องกัน resolution เกินไป
    state.renderer.toneMapping = THREE.ACESFilmicToneMapping;            // tone mapping แบบ cinematic
    state.renderer.toneMappingExposure = 1.0;                             // ความสว่างรวม
    state.renderer.shadowMap.enabled = true;                              // เปิดการวาดเงา
    state.renderer.shadowMap.type = THREE.PCFSoftShadowMap;              // เงาแบบ soft

    // ── OrbitControls — หมุน / pan / zoom ด้วยเมาส์ ──
    // ลากซ้าย = หมุนรอบเป้า · ลากขวา = เลื่อน · ล้อเมาส์ = ซูม
    state.controls = new OrbitControls(state.camera, dom.canvas);
    state.controls.enableDamping = true;        // ทำให้กล้องหยุดแบบ smooth
    state.controls.dampingFactor = 0.08;        // ยิ่งน้อยยิ่งไหลนาน
    state.controls.minDistance = 0.05;          // ฉากเป็นหน่วยเมตร ซูมเข้าได้ถึง 5 ซม.
    state.controls.maxDistance = 100;           // ซูมออกได้ถึง 100 ม.

    // ── Lights ──
    // ambient: แสงรอบทิศทาง กันให้ model ไม่มืดเกิน
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    state.scene.add(ambientLight);

    // dirLight1: แสงหลัก (ขวาบนหน้า) cast shadow
    const dirLight1 = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight1.position.set(5, 8, 5);
    dirLight1.castShadow = true;
    dirLight1.shadow.mapSize.set(1024, 1024);   // ความละเอียดของเงา
    state.scene.add(dirLight1);

    // dirLight2: แสงเติม (ซ้ายหลัง) ทำให้มีมิติ
    const dirLight2 = new THREE.DirectionalLight(0xb0c4de, 0.4);
    dirLight2.position.set(-3, 4, -5);
    state.scene.add(dirLight2);

    // ── Grid ── ช่วยให้เห็น scale และทิศทาง
    const grid = new THREE.GridHelper(10, 50, 0x2d3245, 0x1a1d27);   // 10 ม. ช่องละ 20 ซม.
    grid.material.transparent = true;   // ให้เส้นจางลงได้
    grid.material.opacity = 0.6;
    state.scene.add(grid);

    handleResize();                              // ตั้งค่า aspect ratio ครั้งแรก
    window.addEventListener('resize', handleResize);   // ย่อ/ขยายหน้าต่าง → ปรับขนาดภาพตาม
    animate();                                   // เริ่ม render loop
}
// ── handleResize — ปรับ camera aspect + renderer size เมื่อหน้าต่างเปลี่ยนขนาด ──
// เรียกตอนเริ่ม · ตอนย่อ/ขยายหน้าต่าง · ตอนหุบ/กางแผง Node Tree
function handleResize() {
    // ขนาดจริงของพื้นที่ viewport (px)
    const rect = dom.viewportContainer.getBoundingClientRect();
    // อัตราส่วนกว้าง/สูง ไม่ตั้งให้ตรง ภาพจะยืดหรือบีบ
    state.camera.aspect = rect.width / rect.height;
    state.camera.updateProjectionMatrix();       // ต้องเรียกทุกครั้งที่เปลี่ยน aspect
    // ขยาย canvas ให้เต็มพื้นที่
    state.renderer.setSize(rect.width, rect.height);
}

// ── animate — render loop หลัก เรียกตัวเองซ้ำทุก frame ผ่าน requestAnimationFrame ──
// ทุก frame (~60 ครั้ง/วินาที ตามจอ):
//   1. อัปเดต simulation (ถ้ากำลังรัน)
//   2. อัปเดต animation playback (ถ้ากำลังเล่น)
//   3. อัปเดต OrbitControls (damping)
//   4. render scene
// ค่าจาก MQTT ไม่ได้อัปเดตตรงนี้ — อัปเดตทันทีที่ข้อความมาถึง (ดู connectMQTT) แล้วรอบนี้แค่วาดภาพ
function animate() {
    // ขอให้เบราว์เซอร์เรียก animate อีกครั้งเฟรมถัดไป
    requestAnimationFrame(animate);
    if (state.simRunning) updateSimulation();
    if (state.animPlaying) updateAnimationPlayback();
    state.controls.update();
    // วาดฉากจากมุมกล้อง
    state.renderer.render(state.scene, state.camera);
}

// ============================================================
// Scene — หลายโมเดลในฉากเดียว (แบบ ก · เผื่อต่อยอดเป็นหุ่นหลายตัว)
//
//   state.model (Group "Scene")        ราก ใช้แทนโมเดลเดี่ยวเดิม — โค้ดที่ traverse state.model ยังทำงาน
//     └ entity.wrap (Group ชื่อไฟล์)    ตำแหน่ง · หมุน · ขนาดของโมเดลนั้นในฉาก หน่วยเมตร
//         └ entity.root (gltf.scene)  โมเดลจากไฟล์ เลื่อนให้ฐานอยู่ที่จุดกำเนิดของ wrap
//
// joint จำว่าอยู่ entity ไหน (joint.entity) โหลดไฟล์เดียวกันสองตัว ชื่อกระดูกจึงไม่ชนกัน
// entity ตัวแรกคือ "หุ่นหลัก" — Save ขึ้น server ใช้เป็น model_id ของ project
// ============================================================
// ตัวคูณแปลงองศา → เรเดียน (three.js ใช้เรเดียน แต่แผง SCENE ให้กรอกเป็นองศา)
const DEG2RAD = Math.PI / 180;
// ปัดทศนิยม 3 ตำแหน่ง (มิลลิเมตร) — กันตัวเลขยาวเฟื้อยในแผง/ไฟล์
const round3 = v => Math.round(v * 1000) / 1000;

// ── loadGLB — อ่านไฟล์ .glb เป็น Object3D ──
// คืน Promise: สำเร็จได้ gltf.scene · ไม่สำเร็จได้ error
function loadGLB(fileOrBlob) {
    // สร้าง URL ชั่วคราวชี้ไปที่ไฟล์ในหน่วยความจำ ให้ GLTFLoader โหลดได้
    const url = URL.createObjectURL(fileOrBlob);
    return new Promise((resolve, reject) => {
        // load(url, เสร็จ, ความคืบหน้า, ผิดพลาด) — ทั้งสองกรณีคืน URL ชั่วคราวทิ้ง
        new GLTFLoader().load(url,
            (gltf) => { URL.revokeObjectURL(url); resolve(gltf.scene); },
            undefined,
            (err) => { URL.revokeObjectURL(url); reject(err); });
    });
}

// ── knownUnits — ไฟล์นี้กี่หน่วยเท่ากับ 1 เมตร ──
// รู้จักจาก params.json → models.units_per_meter ไม่รู้จักถือว่าเป็นเมตร (แก้ได้ในแผง SCENE)
function knownUnits(fileName) {
    // ?. = ถ้าไม่มีหมวด models ก็ไม่ error ใช้ {} แทน
    const t = PARAMS.models?.units_per_meter || {};
    // ไม่อยู่ในตาราง → 1 (ถือว่าเป็นเมตร)
    return Number(t[fileName]) || 1;
}

// ── disposeObject — คืนหน่วยความจำ GPU (geometry/material) ของทุกชิ้นใต้ obj ──
// three.js ไม่คืนให้เองตอน remove ออกจากฉาก ไม่เรียกแล้วโหลดโมเดลใหม่หลายรอบ เครื่องจะอืด
function disposeObject(obj) {
    // traverse = ไล่ทุก node ลูกหลาน
    obj.traverse((c) => {
        c.geometry?.dispose();
        // material อาจเป็นตัวเดียวหรือหลายตัว (array) — ทำให้เป็น array แล้วคืนทุกตัว
        if (c.material) (Array.isArray(c.material) ? c.material : [c.material]).forEach(m => m.dispose());
    });
}

// ── freshEntityId — ออก id ใหม่ ent_1, ent_2, … ที่ไม่ซ้ำกับโมเดลในฉาก ──
function freshEntityId() {
    let id;
    // เพิ่มตัวนับไปเรื่อยๆ จนได้ id ที่ยังไม่มีใครใช้
    do { id = `ent_${++state.entityIdCounter}`; } while (state.entities.some(e => e.id === id));
    return id;
}

// ── clearScene — ล้างทุกอย่าง (ตอน Upload ใหม่แทนฉากเดิม) ──
function clearScene() {
    state.transform?.detach();             // ปลด gizmo ก่อนทิ้งโมเดล
    state.toolTarget = null;
    updateToolUI();
    // หยุดสิ่งที่กำลังขยับโมเดลอยู่
    stopSimulation();
    stopAnimationPlayback();
    // เอากลุ่มรากออกจากฉาก แล้วคืนหน่วยความจำ GPU
    if (state.model) { state.scene.remove(state.model); disposeObject(state.model); }
    // ล้างข้อมูลทุกอย่างที่ผูกกับโมเดลเดิม
    state.model = null;
    state.entities = [];
    state.entityIdCounter = 0;
    state.nodeMap.clear();
    state.nodeList = [];
    state.joints = [];
    state.jointIdCounter = 0;
    state.checkedNodeUUIDs.clear();
    state.originalTransforms.clear();
    state.presets = [];
    state.keyframes = [];
}

// ── ensureRoot — สร้าง Group "Scene" เป็นรากของทุกโมเดล (ครั้งแรกที่มีโมเดลเข้าฉาก) ──
function ensureRoot() {
    // มีแล้วไม่ต้องสร้างซ้ำ
    if (state.model) return;
    state.model = new THREE.Group();
    state.model.name = 'Scene';
    state.scene.add(state.model);
}

// ── addEntityObject — ใส่โมเดลที่โหลดแล้วเข้าฉาก ──
// spec มาจากไฟล์ project ตอนเปิดของเดิม (id · ตำแหน่ง · หมุน · ขนาด) ไม่มีก็ใช้ค่าตั้งต้น
function addEntityObject(gltfScene, fileOrBlob, spec = {}) {
    ensureRoot();
    // ชื่อไฟล์: จาก project ก่อน → จากไฟล์ที่เลือก → ชื่อสำรอง
    const fileName = spec.file || fileOrBlob?.name || 'model.glb';
    // ใช้ id จาก project ถ้ายังไม่ซ้ำ ไม่งั้นออก id ใหม่
    const id = spec.id && !state.entities.some(e => e.id === spec.id) ? spec.id : freshEntityId();

    // ให้ฐานของโมเดลอยู่ที่จุดกำเนิด: กลางแนวราบ ล่างสุดแตะพื้น (หน่วยของไฟล์)
    // Box3 = กล่องที่ครอบโมเดลพอดี
    const box = new THREE.Box3().setFromObject(gltfScene);
    const c = box.getCenter(new THREE.Vector3());
    // เลื่อนกลับด้วยจุดกึ่งกลาง x/z และยกขึ้นเท่าความลึกที่จมใต้พื้น
    gltfScene.position.set(-c.x, -box.min.y, -c.z);

    // wrap = กลุ่มห่อโมเดล — ตำแหน่ง/หมุน/ขนาดในฉากตั้งที่ตัวนี้ ไม่แตะค่าข้างในไฟล์
    const wrap = new THREE.Group();
    // ชื่อกลุ่ม = ชื่อไฟล์ตัด .glb/.gltf ออก
    wrap.name = fileName.replace(/\.(glb|gltf)$/i, '');
    // ฝาก id ไว้ที่ wrap — entityIdOfNode ไล่ขึ้นมาหาจากตรงนี้
    wrap.userData.entityId = id;
    wrap.add(gltfScene);
    state.model.add(wrap);

    // ข้อมูลของโมเดลนี้ (entity)
    const ent = {
        id, name: wrap.name, file: fileName,
        blob: fileOrBlob || null,                   // ตัวไฟล์ — เก็บไว้อัปขึ้น server
        modelId: spec.model_id || null,             // id บน server (ถ้าเคยอัปแล้ว)
        unitsPerMeter: Number(spec.units_per_meter) || knownUnits(fileName),
        position:    spec.position     ? [...spec.position]     : null,     // เมตร [x, y, z]
        rotationDeg: spec.rotation_deg ? [...spec.rotation_deg] : [0, 0, 0], // องศา [x, y, z]
        scale:       spec.scale        ? [...spec.scale]        : [1, 1, 1], // เท่า [x, y, z]
        wrap, root: gltfScene,
    };
    if (!ent.position) ent.position = autoPlace(ent);   // ยังไม่อยู่ใน state.entities
    state.entities.push(ent);
    // ใส่ค่าตำแหน่ง/หมุน/ขนาดลง wrap
    applyEntityTransform(ent);
    // เพิ่ม node ทั้งหมดของโมเดลนี้เข้า nodeMap / nodeList
    parseNodeTree(gltfScene);
    return ent;
}

// ── autoPlace — วางโมเดลใหม่ถัดไปทางขวาของของที่มีอยู่ ห่าง 20 ซม. ──
function autoPlace(ent) {
    // โมเดลแรก → วางที่จุดกำเนิด
    if (state.entities.length === 0) return [0, 0, 0];
    // วางชั่วคราวที่จุดกำเนิดเพื่อวัดขนาดจริงของตัวเอง
    ent.position = [0, 0, 0];
    applyEntityTransform(ent);
    const mine = new THREE.Box3().setFromObject(ent.wrap);
    // กล่องครอบทุกโมเดลที่มีอยู่
    const all = new THREE.Box3();
    for (const o of state.entities) all.expandByObject(o.wrap);
    // ขอบซ้ายของตัวใหม่ = ขอบขวาของของเดิม + 20 ซม.
    return [round3(all.max.x + 0.2 - mine.min.x), 0, 0];
}

// ── applyEntityTransform — เอาค่าตำแหน่ง/หมุน/ขนาดของ entity ไปใส่ wrap ──
// ขนาดจริง = ค่าที่ผู้ใช้ตั้ง × (1 ÷ หน่วยต่อเมตรของไฟล์) เช่น UR3: 1 × 1/11.12 → ขนาดจริงเป็นเมตร
function applyEntityTransform(ent) {
    // ตัวคูณแปลงหน่วยของไฟล์ → เมตร
    const k = 1 / (ent.unitsPerMeter || 1);
    ent.wrap.position.set(ent.position[0], ent.position[1], ent.position[2]);
    // องศา → เรเดียน
    ent.wrap.rotation.set(ent.rotationDeg[0] * DEG2RAD, ent.rotationDeg[1] * DEG2RAD, ent.rotationDeg[2] * DEG2RAD);
    ent.wrap.scale.set(ent.scale[0] * k, ent.scale[1] * k, ent.scale[2] * k);
    // คำนวณตำแหน่งในโลกใหม่ทันที (โค้ดที่วัดกล่องต่อจากนี้จะได้ค่าถูก)
    ent.wrap.updateMatrixWorld(true);
}

// ── entityIdOfNode — node นี้อยู่ในโมเดลไหน (ไล่ขึ้นหา wrap) ──
function entityIdOfNode(node) {
    // ไล่จาก node ขึ้นไปหา parent ทีละชั้น จนเจอตัวที่มี entityId (คือ wrap)
    for (let n = node; n; n = n.parent) if (n.userData?.entityId) return n.userData.entityId;
    // หาไม่เจอ → ถือว่าเป็นของหุ่นหลัก
    return state.entities[0]?.id ?? null;
}

// ── setEntityId — เปลี่ยน id ให้ตรงกับไฟล์ project (joint ในไฟล์อ้าง id นี้) ──
function setEntityId(ent, newId) {
    if (!newId || ent.id === newId) return;
    // มีโมเดลอื่นใช้ id นี้อยู่ → ย้ายตัวนั้นไป id ใหม่ก่อน
    const clash = state.entities.find(e => e !== ent && e.id === newId);
    if (clash) setEntityId(clash, freshEntityId());
    // joint ที่ผูกกับ id เดิม เปลี่ยนตาม
    for (const j of state.joints) if (j.entity === ent.id) j.entity = newId;
    ent.id = newId;
    ent.wrap.userData.entityId = newId;
}

// ── frameScene — ตั้งกล้องให้เห็นทั้งฉาก ──
function frameScene() {
    if (!state.model) return;
    // กล่องครอบทุกโมเดล
    const box = new THREE.Box3().setFromObject(state.model);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    // ระยะกล้อง = ด้านที่ยาวสุด × 1.6 + 30 ซม. (ให้มีที่ว่างรอบๆ)
    const d = Math.max(size.x, size.y, size.z) * 1.6 + 0.3;
    // หมุนรอบจุดกลางฉาก
    state.controls.target.copy(c);
    // วางกล้องเฉียงขวา-บน-หน้า
    state.camera.position.set(c.x + d * 0.55, c.y + d * 0.45, c.z + d * 0.85);
    // ระยะใกล้สุดที่เห็น ตามขนาดฉาก (เล็กเกินไปภาพจะกระพริบ)
    state.camera.near = Math.max(0.001, d / 1000);
    state.camera.updateProjectionMatrix();
    state.controls.update();
}

// ── afterSceneChange — อัปเดตหน้าจอทุกส่วนหลังเพิ่ม/ลบโมเดล ──
// frame: true = ย้ายกล้องให้เห็นทั้งฉากด้วย
function afterSceneChange({ frame = false } = {}) {
    // วาดทุกแผงใหม่ให้ตรงกับข้อมูลล่าสุด
    updateStats();
    renderNodeTree();
    renderSceneList();
    markBoundNodes();
    renderJoints();
    renderPresets();
    renderKeyframes();
    updateSelectionCount();
    updatePresetControls();
    updateAnimControls();
    // มีโมเดลอย่างน้อย 1 ตัว → ซ่อนข้อความ "No Model Loaded" แสดงแถบเครื่องมือ
    const has = state.entities.length > 0;
    dom.viewportOverlay.classList.toggle('hidden', has);    // "No Model Loaded"
    dom.sceneTools.classList.toggle('hidden', !has);
    if (frame) frameScene();
}

// ── loadModel — เปิดโมเดลใหม่แทนทั้งฉาก (ปุ่ม Upload) ──
// onLoaded(ent) ถูกเรียกหลังโมเดลพร้อม — importJoint หา node ด้วยชื่อ ต้องรอโมเดลก่อน
function loadModel(file, onLoaded) {
    // โหลดไฟล์ให้เสร็จก่อนค่อยล้างของเก่า — ไฟล์เสียจะได้ไม่เสียฉากเดิมไปด้วย
    loadGLB(file).then((scene) => {
        clearScene();
        // เก็บตัวไฟล์ไว้ — ตอน Save ขึ้น server ต้องมี blob ส่งไป
        state.modelBlob = file;
        state.modelId   = null;     // โหลดไฟล์ใหม่ = ยังไม่รู้ว่าตรงกับโมเดลไหนบน server
        const ent = addEntityObject(scene, file);
        afterSceneChange({ frame: true });
        // ผู้เรียกทำต่อ (เช่น autoSetupJoints ตั้ง joint UR3)
        if (typeof onLoaded === 'function') onLoaded(ent);
    }).catch((error) => {
        console.error('Error loading model:', error);
        alert('Failed to load model. Please check that the file is a valid GLTF/GLB.');
    });
}

// ── addModel — เพิ่มโมเดลเข้าฉากเดิม ไม่ลบของเก่า (ปุ่มเพิ่มโมเดล) ──
function addModel(file, onLoaded) {
    // ยังไม่มีฉาก → ทำเหมือน Upload
    if (!state.model) return loadModel(file, onLoaded);
    loadGLB(file).then((scene) => {
        const ent = addEntityObject(scene, file);
        afterSceneChange({ frame: true });
        if (typeof onLoaded === 'function') onLoaded(ent);
    }).catch((error) => {
        console.error('Error adding model:', error);
        alert('เพิ่มโมเดลไม่สำเร็จ — เช็คว่าเป็นไฟล์ GLTF/GLB');
    });
}
// ── removeEntity — เอาโมเดลออกจากฉาก พร้อม joint ของมัน ──
function removeEntity(id) {
    const ent = state.entities.find(e => e.id === id);
    if (!ent) return;
    // เหลือตัวสุดท้าย → ล้างทั้งฉากไปเลย
    if (state.entities.length === 1) { clearScene(); afterSceneChange(); return; }
    // กำลังเลือกตัวนี้อยู่ → ปลด gizmo ก่อน
    if (state.toolTarget === ent) selectEntity(null);

    // ลบ joint ที่ผูกกับโมเดลนี้ (removeJoint คืนโครงสร้าง node ให้เหมือนเดิมด้วย)
    for (const j of state.joints.filter(j => j.entity === id)) removeJoint(j.id);
    // เก็บ uuid ของทุก node ในโมเดลนี้
    const uuids = new Set();
    ent.root.traverse(n => uuids.add(n.uuid));
    // ลบ node เหล่านั้นออกจากตารางทั้งหมด
    for (const u of uuids) {
        state.nodeMap.delete(u);
        state.originalTransforms.delete(u);
        state.checkedNodeUUIDs.delete(u);
    }
    state.nodeList = state.nodeList.filter(n => !uuids.has(n.uuid));
    // เอาออกจากฉาก + คืนหน่วยความจำ GPU
    state.model.remove(ent.wrap);
    disposeObject(ent.wrap);
    // ลบตัวที่ 0 = ลบหุ่นหลัก
    const wasMain = state.entities[0] === ent;
    state.entities = state.entities.filter(e => e !== ent);
    if (wasMain) {                          // หุ่นหลักเปลี่ยนเป็นตัวถัดไป
        state.modelBlob = state.entities[0].blob;
        state.modelId   = state.entities[0].modelId;
    }
    afterSceneChange();
}

// ── fetchFileBlob — โหลดไฟล์จาก URL เป็น Blob (ใช้ดึงโมเดลที่ขาดตอนเปิด project) ──
async function fetchFileBlob(url) {
    const r = await fetch(url, { cache: 'no-store' });
    // ไม่ใช่ 200 → error (ผู้เรียกจะใส่ชื่อไฟล์ลงรายการ "หาไม่เจอ")
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.blob();
}

// ── syncEntities — ทำให้ฉากมีโมเดลครบตามไฟล์ project ──
// ตัวที่โหลดอยู่แล้ว (ชื่อไฟล์ตรงกัน) ใช้ตัวเดิม ตัวที่ขาดไปดึงด้วย fetchFile(spec)
// แล้วตั้ง id · ตำแหน่ง · หมุน · ขนาดตามไฟล์ — joint ในไฟล์อ้าง id เหล่านี้
// คืนรายชื่อไฟล์ที่หาไม่เจอ
// fetchFile ต่างกันตามที่มา: Import ไฟล์ = ดึงจากโฟลเดอร์เว็บ · Open จาก server = ดึงจาก API
async function syncEntities(list, fetchFile) {
    const missing = [];
    // กันจับคู่โมเดลเดียวกันซ้ำ (เช่น project มี UR3 สองตัว)
    const used = new Set();
    for (const spec of list) {
        // หาโมเดลในฉากที่ชื่อไฟล์ตรงกันและยังไม่ถูกจับคู่
        let ent = state.entities.find(e => !used.has(e) && e.file === spec.file);
        if (!ent) {
            // ไม่มี → ดึงไฟล์แล้วใส่เข้าฉาก
            try {
                const blob = await fetchFile(spec);
                const scene = await loadGLB(blob);
                ent = addEntityObject(scene, blob, spec);
            } catch (e) {
                missing.push(spec.file || spec.name || spec.id);
                continue;
            }
        }
        used.add(ent);
        // ตั้งค่าตามไฟล์ project
        setEntityId(ent, spec.id);
        if (spec.model_id) ent.modelId = spec.model_id;
        ent.unitsPerMeter = Number(spec.units_per_meter) || ent.unitsPerMeter;
        if (spec.position)     ent.position    = [...spec.position];
        if (spec.rotation_deg) ent.rotationDeg = [...spec.rotation_deg];
        if (spec.scale)        ent.scale       = [...spec.scale];
        applyEntityTransform(ent);
    }
    // กัน id ชนกับของที่เพิ่มทีหลัง
    // ตัวนับต้องไม่น้อยกว่าเลขของ id ที่มีอยู่ (ent_3 → ตัวนับอย่างน้อย 3)
    for (const e of state.entities) {
        const n = Number(String(e.id).replace(/^ent_/, ''));
        if (Number.isFinite(n)) state.entityIdCounter = Math.max(state.entityIdCounter, n);
    }
    afterSceneChange({ frame: true });
    return missing;
}

// ── แผง SCENE — รายการโมเดลในฉาก + ปรับตำแหน่ง/หมุน/ขนาด ──
// ข้อความขนาด เช่น "0.94×0.75×2.00 ม."
const fmtSize = s => `${s.x.toFixed(2)}×${s.y.toFixed(2)}×${s.z.toFixed(2)} ม.`;
// ขนาดจริงของโมเดลในฉาก (กว้าง × สูง × ลึก) จากกล่องครอบ
const entitySize = ent => new THREE.Box3().setFromObject(ent.wrap).getSize(new THREE.Vector3());

// ── renderSceneList — วาดแผง SCENE ใหม่ทั้งแผง: 1 แถวต่อโมเดล + ฟอร์มตำแหน่ง/หมุน/ขนาด ──
// เรียกตอนเพิ่ม/ลบ/เลือกโมเดล · ตอนลาก gizmo ใช้ syncSceneForm แทน (ไม่วาดใหม่ทุกเฟรม)
function renderSceneList() {
    const box = dom.sceneList;
    if (!box) return;
    // ไม่มีโมเดล → ซ่อนแผง
    box.classList.toggle('hidden', state.entities.length === 0);
    if (!state.entities.length) { box.innerHTML = ''; return; }

    // สร้างแถวช่องกรอก 1 แถว: ป้ายชื่อ + ช่อง input ตามจำนวน fields ([ชื่อช่อง, ค่า, คำใบ้])
    // data-f บอกว่าช่องนี้คือค่าอะไร (upm / p0-p2 / r0-r2 / s0-s2) ใช้ตอนรับ event พิมพ์
    const inputs = (label, fields) =>
        `<div class="scene-f"><label>${label}</label><div class="scene-in">`
      + fields.map(([f, v, ph]) =>
            `<input type="text" inputmode="decimal" data-f="${f}" value="${v}" placeholder="${ph}" title="${ph}">`).join('')
      + `</div></div>`;

    // หัวแผง + 1 กล่องต่อโมเดล
    box.innerHTML = '<div class="scene-head">SCENE <span>ขนาดในฉาก · หน่วยเมตร</span></div>'
      + state.entities.map((e, i) => {
            // จำนวน joint ของโมเดลนี้
            const nj = state.joints.filter(j => j.entity === e.id).length;
            // class: open = ฟอร์มกางอยู่ · sel = ถูกเลือกให้ลาก · escapeHtml กันชื่อไฟล์มีอักขระ HTML
            // แถวบน: ไอคอน (ตัวแรก = หุ่นหลัก) · ชื่อ · ขนาด · ปุ่ม ⚙ · ปุ่ม ✕
            // ฟอร์ม: หน่วย/เมตร · ตำแหน่ง XYZ · หมุน XYZ · ย่อขยาย XYZ · ข้อมูลกำกับ
            return `<div class="scene-ent${e._open ? ' open' : ''}${e === state.toolTarget ? ' sel' : ''}" data-id="${escapeHtml(e.id)}">`
              + `<div class="scene-row">`
              + `<span class="material-icons-round scene-ic">${i === 0 ? 'precision_manufacturing' : 'view_in_ar'}</span>`
              + `<span class="scene-name" title="${escapeHtml(e.file)}">${escapeHtml(e.name)}</span>`
              + `<span class="scene-size">${fmtSize(entitySize(e))}</span>`
              + `<button class="btn-icon scene-edit" title="ตำแหน่ง · หมุน · ขนาด"><span class="material-icons-round">tune</span></button>`
              + `<button class="btn-icon scene-del" title="เอาออกจากฉาก"><span class="material-icons-round">close</span></button>`
              + `</div><div class="scene-form">`
              + inputs('หน่วย/เมตร', [['upm', e.unitsPerMeter, 'กี่หน่วยในไฟล์ = 1 เมตร']])
              + inputs('ตำแหน่ง (ม.)', e.position.map((v, k) => [`p${k}`, v, 'XYZ'[k]]))
              + inputs('หมุน (°)', e.rotationDeg.map((v, k) => [`r${k}`, v, 'XYZ'[k]]))
              + inputs('ย่อ/ขยาย (×)', e.scale.map((v, k) => [`s${k}`, v, 'XYZ'[k]]))
              + `<div class="scene-meta">${i === 0 ? 'หุ่นหลัก · ' : ''}${nj} joint · ${escapeHtml(e.file)}</div>`
              + `</div></div>`;
        }).join('');
}

// ── bindSceneList — ผูก event ของแผง SCENE ครั้งเดียว (delegation: แถววาดใหม่ก็ยังทำงาน) ──
// คลิก ⚙ = เปิด/ปิดฟอร์ม · ✕ = ลบโมเดล · คลิกชื่อ = เลือกให้ลากได้ · พิมพ์ในช่อง = ขยับทันที
function bindSceneList() {
    const box = dom.sceneList;
    if (!box) return;
    // จาก element ที่ถูกคลิก ไล่ขึ้นหากล่อง .scene-ent แล้วหา entity จาก data-id
    const entOf = el => state.entities.find(e => e.id === el.closest('.scene-ent')?.dataset.id);

    box.addEventListener('click', (e) => {
        const ent = entOf(e.target);
        if (!ent) return;
        if (e.target.closest('.scene-edit')) {
            // ⚙ → สลับเปิด/ปิดฟอร์ม (จำไว้ใน ent._open ให้วาดใหม่แล้วยังเปิดอยู่)
            ent._open = !ent._open;
            e.target.closest('.scene-ent').classList.toggle('open', ent._open);
        } else if (e.target.closest('.scene-del')) {
            // ✕ → ถามยืนยันก่อน บอกด้วยว่า joint จะหายกี่ข้อ
            const nj = state.joints.filter(j => j.entity === ent.id).length;
            if (confirm(`เอา ${ent.name} ออกจากฉาก?` + (nj ? ` joint ของโมเดลนี้ ${nj} ข้อจะถูกลบด้วย` : ''))) {
                removeEntity(ent.id);
            }
        } else if (e.target.closest('.scene-row')) {
            selectEntity(ent === state.toolTarget ? null : ent);   // คลิกชื่อ = เลือก/เลิกเลือกให้ลากได้
        }
    });

    // พิมพ์ปุ๊บขยับปั๊บ — ไม่วาดรายการใหม่ ช่องที่กำลังพิมพ์จะได้ไม่หลุด focus
    box.addEventListener('input', (e) => {
        const inp = e.target.closest('input[data-f]');
        const ent = inp && entOf(inp);
        if (!ent) return;
        // ยังพิมพ์ไม่เป็นตัวเลข (เช่น "-" หรือ "") → รอก่อน
        const v = parseFloat(inp.value);
        if (!Number.isFinite(v)) return;
        // f = ชื่อช่อง เช่น "p2" → ตัวแรกบอกชนิด (p/r/s) ตัวที่สองบอกแกน k (0=X 1=Y 2=Z)
        const f = inp.dataset.f, k = Number(f.slice(1));
        // หน่วย/เมตร และขนาด ต้องมากกว่า 0
        if (f === 'upm')        { if (v <= 0) return; ent.unitsPerMeter = v; }
        else if (f[0] === 'p')  ent.position[k] = v;
        else if (f[0] === 'r')  ent.rotationDeg[k] = v;
        else if (f[0] === 's')  { if (v <= 0) return; ent.scale[k] = v; }
        applyEntityTransform(ent);
        // อัปเดตข้อความขนาดในแถวนั้นอย่างเดียว
        inp.closest('.scene-ent').querySelector('.scene-size').textContent = fmtSize(entitySize(ent));
    });
}

// ============================================================
// Scene tools — คลิกเลือกโมเดลในฉาก แล้วลาก gizmo เพื่อย้าย · หมุน · ย่อขยาย
// TransformControls เกาะที่ entity.wrap ทั้งก้อน joint ข้างในขยับตามไปด้วย
// ค่าที่ลากเขียนกลับเข้า entity → แผง SCENE และไฟล์ project เห็นค่าเดียวกัน
// ============================================================
// ตัวยิงเส้นจากกล้องผ่านจุดที่คลิก ใช้หาว่าคลิกโดนโมเดลไหน (สร้างครั้งเดียวใช้ซ้ำ)
const pickRay = new THREE.Raycaster();

// ── initSceneTools — สร้าง gizmo + ผูกปุ่มบนแถบ + คลิกเลือกใน viewport + คีย์ลัด (เรียกครั้งเดียวจาก bindEvents) ──
function initSceneTools() {
    // gizmo ลูกศร 3 สี (แดง X · เขียว Y · น้ำเงิน Z) ผูกกับกล้องและ canvas
    const tc = new TransformControls(state.camera, state.renderer.domElement);
    tc.setSize(0.8);            // เล็กกว่าค่าปกติเล็กน้อย
    state.scene.add(tc);
    state.transform = tc;

    // ลาก gizmo อยู่ → ปิดการหมุนกล้อง ไม่งั้นกล้องหมุนตามไปด้วย
    // e.value = true ตอนเริ่มลาก · false ตอนปล่อย
    tc.addEventListener('dragging-changed', (e) => {
        state.controls.enabled = !e.value;
        if (!e.value && state.toolTarget) renderSceneList();   // ปล่อยเมาส์แล้วค่อยวาดรายการใหม่ (ขนาดเปลี่ยน)
    });
    // ทุกครั้งที่ลากแล้วโมเดลขยับ → อ่านค่าเก็บเข้า entity + อัปเดตช่องในแผง SCENE
    tc.addEventListener('objectChange', () => {
        const ent = state.toolTarget;
        if (!ent) return;
        readEntityTransform(ent);
        syncSceneForm(ent);
    });

    // คลิก (ไม่ลาก) ใน viewport = เลือกโมเดล · ลากหมุนกล้อง หรือกดโดน gizmo ไม่นับ
    const el = state.renderer.domElement;
    // จำจุดที่กดเมาส์ลง และกดโดน gizmo ไหม (tc.axis มีค่า = เมาส์อยู่บนลูกศร)
    let down = null;
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, gizmo: !!tc.axis }; });
    el.addEventListener('pointerup', (e) => {
        // e.button 0 = ปุ่มซ้าย
        if (!down || e.button !== 0) return;
        // ระยะที่เมาส์เลื่อนระหว่างกดกับปล่อย (px)
        const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
        const onGizmo = down.gizmo;
        down = null;
        // เลื่อนเกิน 4 px = ลากหมุนกล้อง ไม่ใช่คลิก
        if (moved > 4 || onGizmo) return;
        // คลิกโดนโมเดล = เลือก · คลิกที่ว่าง = pickEntity คืน null = เลิกเลือก
        selectEntity(pickEntity(e.clientX, e.clientY));
    });

    // ปุ่มบนแถบ
    dom.sceneTools.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        // ปุ่มโหมดมี data-mode (translate / rotate / scale)
        if (b.dataset.mode) setToolMode(b.dataset.mode);
        else if (b === dom.toolSnap) setToolSnap(!state.toolSnap);
        else if (b.classList.contains('tool-x')) selectEntity(null);
    });

    // คีย์ลัดแบบโปรแกรม 3D: W ย้าย · E หมุน · R ย่อขยาย · S จับระยะ · Esc เลิกเลือก
    document.addEventListener('keydown', (e) => {
        // กด Ctrl/Alt ร่วม (เช่น Ctrl+S) หรือยังไม่มีโมเดล → ไม่ใช่คีย์ลัดของเรา
        if (e.ctrlKey || e.metaKey || e.altKey || !state.entities.length) return;
        // กำลังพิมพ์ในช่องกรอก → ไม่ทำคีย์ลัด
        if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
        const k = e.key.toLowerCase();
        if (k === 'w') setToolMode('translate');
        else if (k === 'e') setToolMode('rotate');
        else if (k === 'r') setToolMode('scale');
        else if (k === 's') setToolSnap(!state.toolSnap);
        else if (e.key === 'Escape') selectEntity(null);
    });

    // ตั้งโหมดเริ่มต้น (ย้าย) และไฮไลต์ปุ่ม
    setToolMode(state.toolMode);
}

// ── pickEntity — ยิงเส้นจากจุดที่คลิก หาว่าโดนโมเดลไหน ──
function pickEntity(clientX, clientY) {
    if (!state.model) return null;
    const r = state.renderer.domElement.getBoundingClientRect();
    // แปลงพิกัดเมาส์ (px) เป็นพิกัดจอแบบ −1 ถึง 1 ที่ three.js ใช้ (แกน Y กลับทิศ)
    pickRay.setFromCamera(new THREE.Vector2(
        ((clientX - r.left) / r.width) * 2 - 1,
        -((clientY - r.top) / r.height) * 2 + 1), state.camera);
    // หาทุกชิ้นที่เส้นตัดผ่าน (true = รวมลูกหลาน) เรียงใกล้ไปไกล — เอาชิ้นแรกที่มองเห็น
    const hit = pickRay.intersectObject(state.model, true).find(h => h.object.visible);
    if (!hit) return null;
    // ชิ้นที่โดน อยู่ในโมเดลไหน
    const id = entityIdOfNode(hit.object);
    return state.entities.find(x => x.id === id) || null;
}

// ── selectEntity — เลือกโมเดลให้ gizmo เกาะ (null = เลิกเลือก ซ่อน gizmo) ──
function selectEntity(ent) {
    state.toolTarget = ent || null;
    // attach = ให้ gizmo เกาะ wrap ของโมเดล · detach = ปลดและซ่อน
    if (ent) state.transform.attach(ent.wrap);
    else state.transform.detach();
    updateToolUI();
    renderSceneList();                       // ไฮไลต์แถวที่เลือก
}
// ── setToolMode — เปลี่ยนโหมด gizmo: translate ย้าย · rotate หมุน · scale ย่อขยาย ──
function setToolMode(mode) {
    state.toolMode = mode;
    const tc = state.transform;
    // เปลี่ยนหน้าตา gizmo (ลูกศร / วงแหวน / กล่อง)
    tc.setMode(mode);
    // หมุนเฉพาะรอบแกนตั้ง กันหุ่น/สายพานเอียงล้มโดยไม่ตั้งใจ (มุมอื่นพิมพ์ในแผง SCENE ได้)
    // โหมดหมุน → ซ่อนวงแหวนแกน X และ Z เหลือแค่ Y
    tc.showX = tc.showZ = mode !== 'rotate';
    updateToolUI();
}

// ── setToolSnap — เปิด/ปิดการจับระยะ (ย้ายทีละ 5 ซม. · หมุนทีละ 15°) ──
function setToolSnap(on) {
    state.toolSnap = on;
    // null = ไม่จับระยะ ลากได้อิสระ
    state.transform.setTranslationSnap(on ? 0.05 : null);                         // ทีละ 5 ซม.
    state.transform.setRotationSnap(on ? THREE.MathUtils.degToRad(15) : null);    // ทีละ 15°
    updateToolUI();
}

// ── updateToolUI — ไฮไลต์ปุ่มโหมดที่ใช้อยู่ + แสดงชื่อโมเดลที่เลือกบนแถบ ──
function updateToolUI() {
    // เรียกได้ก่อนหน้าเว็บพร้อม (เช่นจาก clearScene) — ยังไม่มีแถบก็ข้าม
    if (!dom.sceneTools) return;
    // ปุ่มที่ data-mode ตรงกับโหมดปัจจุบัน → ใส่ class active (สีม่วง)
    dom.sceneTools.querySelectorAll('.tool-btn[data-mode]').forEach(b =>
        b.classList.toggle('active', b.dataset.mode === state.toolMode));
    dom.toolSnap.classList.toggle('active', state.toolSnap);
    // มีโมเดลที่เลือก → ชื่อ + ปุ่ม ✕ · ไม่มี → ข้อความแนะนำ
    const ent = state.toolTarget;
    dom.toolTarget.innerHTML = ent
        ? `<b>${escapeHtml(ent.name)}</b><button class="tool-x" title="เลิกเลือก (Esc)"><span class="material-icons-round">close</span></button>`
        : 'คลิกโมเดลในฉากเพื่อเลือก';
}

// ── อ่านค่าจาก wrap ที่ gizmo ลากไป กลับเข้า entity (หน่วยเมตร · องศา · เท่า) ──
function readEntityTransform(ent) {
    const w = ent.wrap, k = ent.unitsPerMeter || 1;
    // ตำแหน่ง ปัด 3 ตำแหน่ง (มม.)
    ent.position    = w.position.toArray().map(round3);
    // มุม: เรเดียน → องศา ปัด 1 ตำแหน่ง
    ent.rotationDeg = [w.rotation.x, w.rotation.y, w.rotation.z].map(r => Math.round(r / DEG2RAD * 10) / 10);
    // ขนาด: wrap เก็บรวมตัวแปลงหน่วยไว้แล้ว → คูณ k กลับให้เป็นตัวเลขที่ผู้ใช้เห็น (1 = ขนาดจริง)
    ent.scale       = w.scale.toArray().map(s => round3(s * k));
    if (ent.scale.some(s => s < 0.01)) {     // ลากย่อจนติดลบ/ศูนย์ → หยุดไว้ที่ 0.01
        ent.scale = ent.scale.map(s => Math.max(0.01, s));
        applyEntityTransform(ent);
    }
}

// ── อัปเดตช่องกรอกของโมเดลนั้นในแผง SCENE โดยไม่วาดใหม่ทั้งแผง (เรียกทุกเฟรมตอนลาก) ──
function syncSceneForm(ent) {
    // หากล่องของโมเดลนี้ (CSS.escape กันอักขระพิเศษใน id)
    const row = dom.sceneList?.querySelector(`.scene-ent[data-id="${CSS.escape(ent.id)}"]`);
    if (!row) return;
    // ใส่ค่าลงช่องตามชื่อ — ช่องที่ผู้ใช้กำลังพิมพ์อยู่ไม่ทับ
    const set = (f, v) => {
        const inp = row.querySelector(`input[data-f="${f}"]`);
        if (inp && document.activeElement !== inp) inp.value = v;
    };
    ent.position.forEach((v, k) => set(`p${k}`, v));
    ent.rotationDeg.forEach((v, k) => set(`r${k}`, v));
    ent.scale.forEach((v, k) => set(`s${k}`, v));
}

// ============================================================
// Node Tree Parsing — traverse ทุก node ใน model
// สร้าง nodeMap (uuid→Object3D) และ nodeList (array สำหรับ UI)
// บันทึก originalTransforms ไว้ใช้ reset ทีหลัง
// เรียกครั้งละ 1 โมเดล (ตอนใส่เข้าฉากใน addEntityObject)
// ============================================================
function parseNodeTree(root) {
    root.traverse((node) => {
        // เก็บ node ไว้ใน Map เพื่อ lookup ด้วย uuid ได้เร็ว O(1)
        state.nodeMap.set(node.uuid, node);

        // เก็บข้อมูลย่อสำหรับแสดง UI (ไม่เก็บ Object3D ทั้งก้อนใน nodeList)
        state.nodeList.push({
            uuid: node.uuid,
            name: node.name || `[unnamed_${node.type}]`,
            type: node.type
        });

        // snapshot transform ตอนโหลดครั้งแรก ใช้สำหรับ reset / base value
        // clone = คัดลอกค่า ไม่งั้นได้ตัวอ้างอิงเดียวกับ node ที่จะเปลี่ยนตามตอนขยับ
        state.originalTransforms.set(node.uuid, {
            position: node.position.clone(),
            rotation: new THREE.Euler(node.rotation.x, node.rotation.y, node.rotation.z, node.rotation.order),
            visible: node.visible,
        });
    });
}

// ── getNodeIcon — แปลง Three.js type string → icon name + CSS class สำหรับ UI ──
// Mesh = ชิ้นรูปทรง · Group/Object3D = กลุ่ม · Bone = กระดูก (ข้อต่อของ UR3 เป็น Bone)
function getNodeIcon(type) {
    switch (type) {
        case 'Mesh': case 'SkinnedMesh': return { icon: 'hexagon', cls: 'mesh' };
        case 'Group': case 'Object3D':   return { icon: 'folder', cls: 'group' };
        case 'Bone':                      return { icon: 'skeleton', cls: 'bone' };
        case 'DirectionalLight': case 'PointLight': case 'SpotLight': case 'AmbientLight':
            return { icon: 'light_mode', cls: 'light' };
        case 'PerspectiveCamera': case 'OrthographicCamera':
            return { icon: 'videocam', cls: 'camera' };
        default: return { icon: 'circle', cls: 'object' };
    }
}

// ── getTypeBadge — ย่อชื่อ type ให้สั้นลงสำหรับแสดงเป็น badge ข้างชื่อ node ──
// เช่น SkinnedMesh → SkMesh · DirectionalLight → DirLight
function getTypeBadge(type) {
    return type
        .replace('Perspective','P')
        .replace('Orthographic','O')
        .replace('Directional','Dir')
        .replace('Skinned','Sk');
}

// ============================================================
// Node Tree Rendering — สร้าง HTML tree จาก model hierarchy
// ============================================================

// ── renderNodeTree — clear container แล้วสร้าง tree ใหม่ทั้งหมดจาก root ──
function renderNodeTree() {
    dom.nodeTreeContainer.innerHTML = '';
    // ไม่มีโมเดล → ข้อความว่าง
    if (!state.entities.length) {
        dom.nodeTreeContainer.innerHTML = '<div class="empty-state"><span class="material-icons-round">cloud_upload</span>'
            + '<p>Upload a 3D model to see its node tree</p></div>';
        return;
    }
    // แยกตามโมเดล — หัวกลุ่มใช้ชื่อไฟล์แทนชื่อรากในไฟล์ (เช่น Sketchfab_model)
    for (const ent of state.entities) {
        dom.nodeTreeContainer.appendChild(createTreeNodeElement(ent.root, 0, ent.name));
    }
}

// ── createTreeNodeElement — สร้าง div สำหรับ node เดียว + children แบบ recursive ──
// depth ใช้กำหนด padding-left ให้เห็น indent ของ hierarchy
// labelOverride = ชื่อที่จะแสดงแทนชื่อ node (ใช้กับรากของแต่ละโมเดล)
function createTreeNodeElement(node, depth, labelOverride) {
    const container = document.createElement('div');
    container.className = 'tree-node';
    const hasChildren = node.children && node.children.length > 0;
    const iconInfo = getNodeIcon(node.type);
    const name = labelOverride || node.name || '[unnamed]';

    // ── แถวหลักของ node (toggle icon, checkbox, icon, label, type badge) ──
    const row = document.createElement('div');
    row.className = 'tree-node-row';
    row.style.paddingLeft = `${depth * 4 + 4}px`;   // indent ตาม depth
    row.dataset.uuid = node.uuid;                     // เก็บ uuid ไว้ใน DOM สำหรับ markBoundNodes

    // ── ปุ่ม ▼ expand/collapse children ──
    const toggle = document.createElement('span');
    toggle.className = `material-icons-round tree-toggle ${!hasChildren ? 'no-children' : ''}`;
    toggle.textContent = 'expand_more';

    // ── checkbox สำหรับเลือก node เข้า joint ──
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'tree-checkbox';
    checkbox.checked = state.checkedNodeUUIDs.has(node.uuid);  // restore state ถ้า re-render
    checkbox.dataset.uuid = node.uuid;
    checkbox.addEventListener('change', (e) => {
        // ไม่ให้ event ไหลขึ้นไปถึงแถว (ไม่งั้นจะ highlight ด้วย)
        e.stopPropagation();
        // เพิ่ม/ลบ uuid จาก checkedNodeUUIDs ตาม checked state
        if (e.target.checked) state.checkedNodeUUIDs.add(node.uuid);
        else state.checkedNodeUUIDs.delete(node.uuid);
        updateSelectionCount();
        updateAddJointButton();
    });

    // ── icon สีตาม node type ──
    const icon = document.createElement('span');
    icon.className = `material-icons-round tree-icon ${iconInfo.cls}`;
    icon.textContent = iconInfo.icon;

    // ── label แสดงชื่อ node ──
    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = name;
    label.title = `${name} (${node.type})`;   // tooltip แสดง type เต็ม

    // ── badge แสดง type ย่อ ──
    const badge = document.createElement('span');
    badge.className = 'tree-type-badge';
    badge.textContent = getTypeBadge(node.type);

    // ประกอบแถว: ▼ ☐ ไอคอน ชื่อ badge
    row.appendChild(toggle);
    row.appendChild(checkbox);
    row.appendChild(icon);
    row.appendChild(label);
    row.appendChild(badge);
    container.appendChild(row);

    // ── click บน row → highlight node ใน 3D viewport ──
    row.addEventListener('click', (e) => {
        if (e.target === checkbox) return;  // ถ้า click checkbox ให้ checkbox จัดการเอง
        e.stopPropagation();
        highlightNode(node.uuid);
    });

    // ── click toggle ▼ → expand/collapse children ──
    // (childrenEl ประกาศด้านล่าง แต่ฟังก์ชันนี้ทำงานตอนคลิกซึ่งตอนนั้นมีค่าแล้ว)
    toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!hasChildren) return;
        toggle.classList.toggle('collapsed');
        childrenEl.classList.toggle('collapsed');
    });

    // ── children container — สร้าง recursive สำหรับ child แต่ละตัว ──
    const childrenEl = document.createElement('div');
    childrenEl.className = 'tree-children';
    if (hasChildren) {
        // เรียกตัวเองซ้ำกับลูกแต่ละตัว ลึกลงไป 1 ชั้น
        for (const child of node.children) {
            childrenEl.appendChild(createTreeNodeElement(child, depth + 1));
        }
    }
    container.appendChild(childrenEl);
    return container;
}

// ── updateSelectionCount — อัปเดต badge "N selected" ใน header ──
function updateSelectionCount() {
    const count = state.checkedNodeUUIDs.size;
    // มีที่เลือก → แสดงจำนวน · ไม่มี → ซ่อน badge
    if (count > 0) {
        dom.selectionCount.textContent = `${count} selected`;
        dom.selectionCount.classList.remove('hidden');
    } else {
        dom.selectionCount.classList.add('hidden');
    }
}

// ── updateAddJointButton — enable ปุ่ม + เฉพาะเมื่อมี node ที่เลือกอย่างน้อย 1 ──
function updateAddJointButton() {
    dom.btnAddJoint.disabled = state.checkedNodeUUIDs.size === 0;
}

// ============================================================
// 3D Highlight — แสดง bounding box สีม่วงรอบ node ที่ click
// หายไปเองหลัง 3 วินาที
// ============================================================
let highlightOutlines = [];   // เก็บ Box3Helper ที่กำลังแสดงอยู่ ไว้ลบทีหลัง

// ── highlightNode — highlight node เดียว ──
// คลิกชื่อ node ใน Node Tree → วาดกรอบสีม่วงรอบชิ้นนั้นในภาพ 3D ให้รู้ว่าคือชิ้นไหน
function highlightNode(uuid) {
    // ลบ highlight เก่าก่อน
    highlightOutlines.forEach(h => state.scene.remove(h));
    highlightOutlines = [];

    const node = state.nodeMap.get(uuid);
    if (!node) return;

    // กล่องครอบ node นี้ (รวมลูกหลาน) ในพิกัดโลก
    const box = new THREE.Box3().setFromObject(node);
    if (box.isEmpty()) return;   // empty group ไม่มี bounding box

    // Box3Helper = เส้นกรอบกล่องที่มองเห็นได้
    const helper = new THREE.Box3Helper(box, new THREE.Color(0x6366f1));  // สีม่วง indigo
    state.scene.add(helper);
    highlightOutlines.push(helper);

    // ลบ highlight หลัง 3 วินาที
    setTimeout(() => {
        state.scene.remove(helper);
        highlightOutlines = highlightOutlines.filter(h2 => h2 !== helper);
    }, 3000);
}

// ── highlightMultipleNodes — highlight หลาย node พร้อมกัน (ใช้ตอน click "show nodes" บน joint) ──
function highlightMultipleNodes(uuids) {
    // ลบกรอบเก่า
    highlightOutlines.forEach(h => state.scene.remove(h));
    highlightOutlines = [];
    // วาดกรอบรอบทุก node ที่ส่งมา (ข้ามตัวที่หาไม่เจอ/ไม่มีขนาด)
    for (const uuid of uuids) {
        const node = state.nodeMap.get(uuid);
        if (!node) continue;
        const box = new THREE.Box3().setFromObject(node);
        if (box.isEmpty()) continue;
        const helper = new THREE.Box3Helper(box, new THREE.Color(0x6366f1));
        state.scene.add(helper);
        highlightOutlines.push(helper);
    }
    // ลบทั้งหมดหลัง 3 วินาที
    setTimeout(() => {
        highlightOutlines.forEach(h => state.scene.remove(h));
        highlightOutlines = [];
    }, 3000);
}

// ============================================================
// Stats — นับ vertices / meshes / nodes แสดงที่ info bar ล่าง viewport
// นับรวมทุกโมเดลในฉาก
// ============================================================
function updateStats() {
    let vertices = 0, meshes = 0, nodes = 0;
    if (state.model) {
        state.model.traverse((node) => {
            nodes++;
            if (node.isMesh) {
                meshes++;
                // getAttribute('position') → BufferAttribute ที่เก็บ xyz ของแต่ละ vertex
                const pos = node.geometry?.getAttribute('position');
                if (pos) vertices += pos.count;
            }
        });
    }
    // toLocaleString ใส่จุลภาคคั่นหลักพัน เช่น 339,666
    dom.infoVertices.textContent = `${vertices.toLocaleString()} vertices`;
    dom.infoMeshes.textContent = `${meshes} meshes`;
    dom.infoNodes.textContent = `${nodes} nodes`;
}

// ============================================================
// Joint System — ระบบสร้าง/ลบ/ควบคุม joint
//
// แนวคิดหลัก: "pivotGroup pattern"
//   เมื่อสร้าง joint ที่มีหลาย node จะสร้าง THREE.Group (pivotGroup)
//   แทรกเข้าใน hierarchy แทนที่ node เดิม แล้วย้าย node ที่เลือกเป็น child
//   เมื่อหมุน/เลื่อน pivotGroup → node ทั้งหมดขยับพร้อมกัน
//
//   pivotGroup อยู่ใต้ parent เดิมของ node (ไม่ใช่ scene root)
//   → ทำให้ parent joint หมุนแล้วพา child joint ติดไปด้วย (forward kinematics)
//
// joint ที่มี node เดียว (เช่นกระดูกของ UR3) ไม่ต้องใช้ pivotGroup
//   หมุน node นั้นตรงๆ รอบจุดหมุนของตัวเอง (ค่า = ค่าเดิม + ค่าของ joint)
// ============================================================

// ── openAddJointModal — เปิด modal "Add Joint" และ populate ข้อมูล ──
function openAddJointModal() {
    // ยังไม่ได้ติ๊ก node ใน Node Tree → เปิดไม่ได้
    if (state.checkedNodeUUIDs.size === 0) return;

    // แสดง chip ชื่อ node ที่เลือกไว้ใน modal
    dom.modalLinkedNodes.innerHTML = '';
    for (const uuid of state.checkedNodeUUIDs) {
        const info = state.nodeList.find(n => n.uuid === uuid);
        if (!info) continue;
        const chip = document.createElement('span');
        chip.className = 'linked-node-chip';
        chip.innerHTML = `<span class="material-icons-round">link</span>${escapeHtml(info.name)}`;
        dom.modalLinkedNodes.appendChild(chip);
    }

    // ── สร้าง pivot dropdown ──
    // option 1: centroid (คำนวณอัตโนมัติ)
    // option 2: manual (กรอก XYZ เอง)
    // option 3+: node ที่เลือกไว้ (ใช้ node นั้นเป็น pivot center)
    // ⚠ หน้าเว็บยังไม่มีช่องกรอก XYZ (dom.pivotX / pivotManualGroup ไม่มี) — เลือก manual จะได้จุด (0,0,0)
    dom.jointPivotNode.innerHTML = '<option value="centroid">Centroid (auto — average of all nodes)</option>';
    dom.jointPivotNode.innerHTML += '<option value="manual">กำหนดเอง (Manual XYZ) — ระบุพิกัดจุดหมุนเอง</option>';
    for (const uuid of state.checkedNodeUUIDs) {
        const info = state.nodeList.find(n => n.uuid === uuid);
        if (!info) continue;
        const opt = document.createElement('option');
        opt.value = uuid;
        opt.textContent = `${info.name}  (use as pivot center)`;
        dom.jointPivotNode.appendChild(opt);
    }

    // Auto-fill pivot XYZ จาก bounding box center ของ node แรกที่เลือก
    // user ปรับค่าเองได้ถ้า auto-fill ไม่ตรงข้อต่อจริง
    // (ตอนนี้ dom.pivotX ไม่มี บล็อกนี้จึงถูกข้าม)
    const firstUUID = [...state.checkedNodeUUIDs][0];
    const firstNode = firstUUID ? state.nodeMap.get(firstUUID) : null;
    if (firstNode && dom.pivotX) {
        const c = getNodeCenter(firstNode);
        dom.pivotX.value = c.x.toFixed(3);
        dom.pivotY.value = c.y.toFixed(3);
        dom.pivotZ.value = c.z.toFixed(3);
    }

    // เมื่อเปลี่ยน pivot dropdown → แสดง/ซ่อน manual XYZ
    dom.jointPivotNode.onchange = () => updatePivotVisibility();

    // ── Reset form ไปค่า default ──
    // revolute = หมุนรอบแกน · rotation.y = หมุนรอบแกน Y ของ node · ไม่จำลองสัญญาณ
    dom.jointName.value = '';
    dom.jointType.value = 'revolute';
    dom.jointProperty.value = 'rotation.y';
    dom.jointSimPattern.value = 'none';
    dom.jointSimFreq.value = '3';

    // ── binding: สืบ topic จาก joint ตัวก่อนหน้า ──
    // ปกติทุก joint ของหุ่นตัวเดียวกันใช้ topic เดียวกัน จะได้ไม่ต้องพิมพ์ซ้ำ 6 รอบ
    const prevJoint = state.joints[state.joints.length - 1];
    dom.jointSrcTopic.value = prevJoint?.srcTopic || '';
    dom.jointSrcPath.value  = '';    // path ต่างกันทุก joint ไม่สืบทอด
    // การแปลงค่าเริ่มต้น = ส่งผ่านตรงๆ (คูณ 1 · บวก 0 · ไม่กลับทิศ)
    dom.jointScale.value    = '1';
    dom.jointOffset.value   = '0';
    dom.jointInvert.checked = false;
    if (dom.jointUnit) dom.jointUnit.value = defaultUnitFor(dom.jointProperty.value);

    // ซ่อนส่วนที่ยังไม่เกี่ยว แล้วอัปเดตช่อง min/max/การแสดงผลตามค่าเริ่มต้น
    dom.coupledGroup.style.display = 'none';
    if (dom.pivotManualGroup) dom.pivotManualGroup.style.display = 'none';
    updateMinMaxDefaults();
    updateSimFreqVisibility();
    updatePivotVisibility();

    // ── Populate coupled target dropdown ด้วย joint ที่มีอยู่แล้ว ──
    // coupled = joint ที่ขยับตาม joint อื่นด้วยอัตราส่วน (เช่นเฟืองคู่)
    dom.jointCoupledTarget.innerHTML = '<option value="">-- เลือก Joint ต้นทาง --</option>';
    for (const j of state.joints) {
        const opt = document.createElement('option');
        opt.value = j.id;
        opt.textContent = j.name;
        dom.jointCoupledTarget.appendChild(opt);
    }

    // ── แสดง/ซ่อน coupled config เมื่อ type เปลี่ยน ──
    dom.jointType.onchange = () => {
        const isContinuous = dom.jointType.value === 'continuous';
        const isCoupled = dom.jointType.value === 'coupled';
        dom.coupledGroup.style.display = isCoupled ? 'flex' : 'none';
        if (isContinuous) {
            // continuous joint ใช้ min/max เป็น speed ไม่ใช่ angle limit
            dom.jointMin.value = '0';
            dom.jointMax.value = '6.28';   // 2π rad/s
            dom.jointStep.value = '0.01';
        } else {
            updateMinMaxDefaults();
        }
    };
    // เปิดตัวแสดง payload สด (ช่วยเลือก path) แล้วเปิด modal
    startInspector();
    dom.modalOverlay.classList.remove('hidden');
    dom.jointName.focus();
}

// ── openEditJointModal — เปิด modal ในโหมดแก้ไข joint ที่มีอยู่แล้ว ──
// ต่างจาก openAddJointModal ตรงที่ไม่แตะ node ที่ผูกไว้และไม่แตะ pivot
// เพราะสองอย่างนั้นต้องรื้อ hierarchy ใหม่ — ถ้าจำเป็นต้องเปลี่ยนให้ลบแล้วสร้างใหม่
function openEditJointModal(jointId) {
    const joint = state.joints.find(j => j.id === jointId);
    if (!joint) return;

    // จำไว้ว่ากำลังแก้ตัวไหน — ปุ่มยืนยันจะเรียก saveJointEdit แทน addJoint
    state.editingJointId = jointId;

    // ── แสดง chip ของ node ที่ผูกอยู่ (ดูอย่างเดียว) ──
    dom.modalLinkedNodes.innerHTML = '';
    for (const uuid of joint.nodeUUIDs) {
        const info = state.nodeList.find(n => n.uuid === uuid);
        const chip = document.createElement('span');
        chip.className = 'linked-node-chip';
        chip.innerHTML = `<span class="material-icons-round">link</span>${escapeHtml(info ? info.name : '?')}`;
        dom.modalLinkedNodes.appendChild(chip);
    }

    // ซ่อน pivot ทั้งกลุ่ม — แก้ไม่ได้ในโหมดนี้ ไม่ต้องแสดงให้สับสน
    dom.pivotGroup.style.display = 'none';
    if (dom.pivotManualGroup) dom.pivotManualGroup.style.display = 'none';

    // ── เติมค่าเดิมของ joint ลงในฟอร์ม ──
    // ?? = ใช้ค่าขวาเมื่อค่าซ้ายเป็น null/undefined (ไฟล์เก่าที่ไม่มีช่องนั้น)
    dom.jointName.value         = joint.name;
    dom.jointType.value         = joint.jointType || 'revolute';
    dom.jointProperty.value     = joint.property;
    dom.jointMin.value          = joint.min;
    dom.jointMax.value          = joint.max;
    dom.jointStep.value         = joint.step;
    dom.jointSimPattern.value   = joint.simPattern || 'none';
    dom.jointSimFreq.value      = joint.simPeriod ?? 3;
    dom.jointCoupledRatio.value = joint.coupledRatio ?? 1;

    // ค่าการรับข้อมูล MQTT ของ joint นี้
    dom.jointSrcTopic.value = joint.srcTopic || '';
    dom.jointSrcPath.value  = joint.srcPath  || '';
    dom.jointScale.value    = joint.scale  ?? 1;
    dom.jointOffset.value   = joint.offset ?? 0;
    dom.jointInvert.checked = !!joint.invert;
    if (dom.jointUnit) dom.jointUnit.value = joint.unit ?? defaultUnitFor(joint.property);

    // ── dropdown coupled: ตัดตัวเองออก กัน joint ผูกกับตัวเองแล้ว loop ไม่รู้จบ ──
    dom.jointCoupledTarget.innerHTML = '<option value="">-- เลือก Joint ต้นทาง --</option>';
    for (const j of state.joints) {
        if (j.id === jointId) continue;
        const opt = document.createElement('option');
        opt.value = j.id;
        opt.textContent = j.name;
        dom.jointCoupledTarget.appendChild(opt);
    }
    // เลือกตัวที่ผูกไว้เดิม
    dom.jointCoupledTarget.value = joint.coupledTarget || '';

    // แสดงแถว coupled เฉพาะ joint ชนิด coupled
    dom.coupledGroup.style.display = (joint.jointType === 'coupled') ? 'flex' : 'none';
    updateSimFreqVisibility();

    // ── เปลี่ยน Joint Type ระหว่างแก้ไข: แสดง/ซ่อน coupled เท่านั้น ──
    // ห้าม reset min/max เหมือนโหมด Add เพราะจะทับค่าที่ผู้ใช้ตั้งไว้ (เช่น -6.29/6.29)
    dom.jointType.onchange = () => {
        dom.coupledGroup.style.display = (dom.jointType.value === 'coupled') ? 'flex' : 'none';
    };

    // ── เปลี่ยนหน้าตา modal ให้รู้ว่าอยู่โหมดแก้ไข ──
    if (dom.modalTitle) {
        dom.modalTitle.innerHTML =
            '<span class="material-icons-round" style="font-size:20px;vertical-align:middle;margin-right:6px;">edit</span>Edit Joint';
    }
    dom.modalConfirm.innerHTML =
        '<span class="material-icons-round" style="font-size:16px;">save</span>Save Changes';

    // เปิดตัวแสดง payload สด แล้วเปิด modal
    startInspector();
    dom.modalOverlay.classList.remove('hidden');
    dom.jointName.focus();
}
// ── saveJointEdit — บันทึกค่าที่แก้ทับลง joint เดิม ──
// สำคัญ: แก้ property ของ object เดิม ไม่สร้าง object ใหม่และไม่ push
// ตำแหน่งใน state.joints จึงไม่ขยับ → mapping กับ actual_q[i] ไม่พัง
function saveJointEdit() {
    const joint = state.joints.find(j => j.id === state.editingJointId);
    // หา joint ไม่เจอ (ถูกลบไประหว่างนั้น) → ปิด modal เฉยๆ
    if (!joint) { closeModal(); return; }

    const newProperty = dom.jointProperty.value;

    // ── ถ้าเปลี่ยน property ต้องคืนค่าแกนเดิมก่อน แล้วจับ base ของแกนใหม่ ──
    // ไม่งั้น node จะค้างมุมของแกนเก่าไว้ตลอด เช่นเปลี่ยน rotation.y → rotation.x
    // แล้ว rotation.y ยังค้างค่าสุดท้ายอยู่ ทำให้ท่าเพี้ยนถาวร
    // (joint ที่มี pivotGroup ไม่ต้องทำ เพราะ applyJointValue reset ทั้ง group ทุก frame อยู่แล้ว)
    if (newProperty !== joint.property && !joint.pivotGroup) {
        // คืนค่าแกนเดิมของทุก node กลับเป็นค่าตั้งต้น
        for (const uuid of joint.nodeUUIDs) {
            const node = state.nodeMap.get(uuid);
            if (!node) continue;
            const oldBase = joint.baseValues?.get(uuid);
            if (oldBase !== undefined) setNodePropertyValue(node, joint.property, oldBase);
        }
        // จำค่าตั้งต้นของแกนใหม่
        const newBase = new Map();
        for (const uuid of joint.nodeUUIDs) {
            const node = state.nodeMap.get(uuid);
            if (node) newBase.set(uuid, getNodePropertyValue(node, newProperty));
        }
        joint.baseValues = newBase;
    }

    // ── เขียนค่าใหม่ทับ ──
    // ชื่อว่าง → ใช้ชื่อเดิม · ตัวเลขอ่านจากช่องด้วย parseFloat
    joint.name          = dom.jointName.value.trim() || joint.name;
    joint.property      = newProperty;
    joint.min           = parseFloat(dom.jointMin.value);
    joint.max           = parseFloat(dom.jointMax.value);
    joint.step          = parseFloat(dom.jointStep.value);
    joint.jointType     = dom.jointType.value;
    joint.simPattern    = dom.jointSimPattern.value;
    joint.simPeriod     = parseFloat(dom.jointSimFreq.value);
    joint.coupledTarget = dom.jointCoupledTarget.value || null;
    joint.coupledRatio  = parseFloat(dom.jointCoupledRatio.value) || 1;

    // ค่าการรับข้อมูล MQTT — ช่องที่ไม่ใช่ตัวเลขใช้ค่าปลอดภัย (คูณ 1 / บวก 0)
    joint.srcTopic = dom.jointSrcTopic.value.trim();
    joint.srcPath  = dom.jointSrcPath.value.trim();
    const sc = parseFloat(dom.jointScale.value);
    const of = parseFloat(dom.jointOffset.value);
    joint.scale  = Number.isFinite(sc) ? sc : 1;
    joint.offset = Number.isFinite(of) ? of : 0;
    joint.invert = dom.jointInvert.checked;
    joint.unit   = dom.jointUnit ? dom.jointUnit.value : '';

    resubscribeJoints();   // เผื่อเพิ่ง/เปลี่ยน topic ระหว่างที่ต่อ broker อยู่

    // apply ซ้ำด้วยค่าเดิม เพื่อให้ค่าถูก clamp เข้า min/max ที่เพิ่งเปลี่ยน
    applyJointValue(joint, joint.value);

    // ปิด modal แล้ววาดการ์ด joint ใหม่
    closeModal();
    renderJoints();
    updatePresetControls();
    updateAnimControls();
}

// ── defaultUnitFor — เดาหน่วยเริ่มต้นจาก property ──
// ใช้เป็นค่าตั้งต้นให้ผู้ใช้เท่านั้น แก้ทีหลังได้เสมอ
// และใช้เติมย้อนหลังให้ .dtwp เก่าที่ยังไม่มี field unit
function defaultUnitFor(property) {
    if (!property) return '';
    if (property.startsWith('rotation')) return 'rad';
    if (property.startsWith('position')) return 'm';
    return '';   // visible ไม่มีหน่วย
}

// ── updateMinMaxDefaults — set min/max/step default ตาม property ที่เลือก ──
function updateMinMaxDefaults() {
    const prop = dom.jointProperty.value;
    if (prop.startsWith('rotation')) {
        dom.jointMin.value = '-3.14';   // -π rad ≈ -180°
        dom.jointMax.value = '3.14';    // +π rad ≈ +180°
        dom.jointStep.value = '0.01';
    } else if (prop.startsWith('position')) {
        // เลื่อนได้ ±5 หน่วยของไฟล์โมเดล (หน่วยในไฟล์ ไม่ใช่เมตรในฉาก)
        dom.jointMin.value = '-5';
        dom.jointMax.value = '5';
        dom.jointStep.value = '0.01';
    } else if (prop === 'visible') {
        dom.jointMin.value = '0';
        dom.jointMax.value = '1';
        dom.jointStep.value = '1';      // toggle เฉพาะ 0 หรือ 1
    }
}

// ── updateSimFreqVisibility — แสดง/ซ่อน "Cycle Period" เมื่อ pattern เปลี่ยน ──
// ถ้า pattern = none ไม่ต้องกำหนด period
function updateSimFreqVisibility() {
    dom.simFreqGroup.style.display = dom.jointSimPattern.value === 'none' ? 'none' : 'flex';
}

// ── updatePivotVisibility — แสดง/ซ่อน pivot dropdown ──
// pivot มีประโยชน์เฉพาะเมื่อมีหลาย node และ property ไม่ใช่ visible
function updatePivotVisibility() {
    const prop = dom.jointProperty.value;
    const multiNode = state.checkedNodeUUIDs.size > 1;
    const showPivot = multiNode && prop !== 'visible';
    dom.pivotGroup.style.display = showPivot ? 'flex' : 'none';

    // แสดง manual XYZ input เมื่อ user เลือก กำหนดเอง
    // (ตอนนี้ไม่มีช่องกรอกในหน้าเว็บ บล็อกนี้จึงไม่ทำงาน)
    if (dom.pivotManualGroup) {
        const isManual = dom.jointPivotNode.value === 'manual';
        dom.pivotManualGroup.style.display = (showPivot && isManual) ? 'flex' : 'none';
    }
}

// ── closeModal — ปิด modal และคืนสภาพกลับเป็นโหมด Add ──
function closeModal() {
    // หยุดอัปเดต payload สด
    stopInspector();
    dom.modalOverlay.classList.add('hidden');
    state.editingJointId = null;     // ออกจากโหมดแก้ไขเสมอ

    // คืนหัวข้อกับปุ่มกลับเป็นของโหมด Add ไม่งั้นครั้งหน้าเปิดมาจะยังขึ้น "Edit Joint"
    if (dom.modalTitle) {
        dom.modalTitle.innerHTML =
            '<span class="material-icons-round" style="font-size:20px;vertical-align:middle;margin-right:6px;">settings</span>Add Joint';
    }
    dom.modalConfirm.innerHTML =
        '<span class="material-icons-round" style="font-size:16px;">add</span>Create Joint';
}

// ============================================================
// Pivot helper — คำนวณตำแหน่ง world-space center ของ node
//
// ใช้ bounding box แทน node.position เพราะ GLB หลายไฟล์ bake geometry
// ไว้ใน vertices (node.position = 0,0,0 เสมอ) แต่ bounding box ถูกเสมอ
// ============================================================
function getNodeCenter(node) {
    state.model.updateWorldMatrix(true, true);    // อัปเดต world matrix ทั้ง tree ก่อนคำนวณ
    const box = new THREE.Box3().setFromObject(node);
    if (!box.isEmpty()) {
        const c = new THREE.Vector3();
        box.getCenter(c);
        return c;   // คืน world-space center
    }
    // fallback สำหรับ empty group (ไม่มี geometry): ใช้ world position แทน
    const wp = new THREE.Vector3();
    node.getWorldPosition(wp);
    return wp;
}

// ── addJoint — สร้าง joint ใหม่จากข้อมูลใน modal ──
// ขั้นตอนหลัก:
//   1. อ่านค่าจาก form
//   2. คำนวณตำแหน่ง pivot (centroid / specific node / manual)
//   3. สร้าง pivotGroup และแทรกเข้า hierarchy เดิม (ไม่ใช่ scene root)
//   4. ย้าย topmost nodes เป็น child ของ pivotGroup (attach รักษา world position)
//   5. push joint object เข้า state.joints
function addJoint() {
    // ── อ่านค่าจาก form ──
    // ไม่ตั้งชื่อ → "Joint N"
    const name = dom.jointName.value.trim() || `Joint ${state.jointIdCounter + 1}`;
    // node ที่ติ๊กไว้ใน Node Tree (แปลง Set เป็น array)
    const nodeUUIDs = [...state.checkedNodeUUIDs];
    const property = dom.jointProperty.value;
    const min = parseFloat(dom.jointMin.value);
    const max = parseFloat(dom.jointMax.value);
    const step = parseFloat(dom.jointStep.value);
    const simPattern = dom.jointSimPattern.value;
    const simPeriod = parseFloat(dom.jointSimFreq.value);
    const jointType = dom.jointType.value;
    const coupledTarget = dom.jointCoupledTarget.value || null;
    const coupledRatio = parseFloat(dom.jointCoupledRatio.value) || 1;
    // ค่าการรับข้อมูล MQTT: topic · path ในข้อความ · ตัวคูณ · ค่าเลื่อน · กลับทิศ · หน่วย
    const srcTopic = dom.jointSrcTopic.value.trim();
    const srcPath  = dom.jointSrcPath.value.trim();
    const scale    = parseFloat(dom.jointScale.value);
    const offset   = parseFloat(dom.jointOffset.value);
    const invert   = dom.jointInvert.checked;
    const unit     = dom.jointUnit ? dom.jointUnit.value : '';
    if (nodeUUIDs.length === 0) return;

    // ── บันทึก base value ของแต่ละ node ก่อน joint เปลี่ยนค่า ──
    // ใช้สำหรับ joint แบบ single-node (ไม่มี pivotGroup)
    const baseValues = new Map();
    for (const uuid of nodeUUIDs) {
        const node = state.nodeMap.get(uuid);
        if (node) baseValues.set(uuid, getNodePropertyValue(node, property));
    }

    let pivotGroup = null;
    let pivotBasePosition = null;
    const originalParentData = new Map();    // เก็บ parent เดิมไว้ restore เมื่อลบ joint
    const pivotNodeUUID = dom.jointPivotNode.value;

    // ── ต้องการ pivotGroup เมื่อ: หลาย node หรือ manual pivot หรือ specific node pivot ──
    // (single node + centroid ไม่ต้องการ pivot เพราะหมุนรอบตัวเองได้เลย)
    const usesPivot = property !== 'visible' && (
        nodeUUIDs.length > 1 ||
        pivotNodeUUID === 'manual' ||
        pivotNodeUUID !== 'centroid'
    );

    if (usesPivot) {
        // กลุ่มจุดหมุน — ชื่อขึ้นต้น __ ให้รู้ว่าเป็นของที่ระบบสร้าง
        pivotGroup = new THREE.Group();
        pivotGroup.name = `__joint_pivot_${state.jointIdCounter}`;

        // ── คำนวณตำแหน่ง pivot (world space) ตามโหมดที่เลือก ──
        const centroid = new THREE.Vector3();

        if (pivotNodeUUID === 'manual') {
            // user กรอก XYZ เอง → ใช้ค่านั้นตรงๆ ไม่คำนวณอัตโนมัติ
            // (ไม่มีช่องกรอก → ?. ได้ undefined → || 0 → จุดหมุนอยู่ที่ (0,0,0))
            centroid.set(
                parseFloat(dom.pivotX?.value) || 0,
                parseFloat(dom.pivotY?.value) || 0,
                parseFloat(dom.pivotZ?.value) || 0
            );
        } else if (pivotNodeUUID !== 'centroid') {
            // user เลือก node เฉพาะเป็น pivot → ใช้ bounding box center ของ node นั้น
            const pivotNode = state.nodeMap.get(pivotNodeUUID);
            if (pivotNode) centroid.copy(getNodeCenter(pivotNode));
        } else {
            // Centroid auto: เฉลี่ย bounding box center ของทุก node ที่เลือก
            let count = 0;
            for (const uuid of nodeUUIDs) {
                const node = state.nodeMap.get(uuid);
                if (node) { centroid.add(getNodeCenter(node)); count++; }
            }
            if (count > 0) centroid.divideScalar(count);
        }

        // ── หา topmost nodes — node ที่ไม่มี ancestor อื่นในกลุ่มที่เลือก ──
        // เพราะถ้า A เป็น parent ของ B ใน selection เดียวกัน
        // เราแค่ attach A เข้า pivotGroup (B ติดตาม A อยู่แล้ว)
        const selectedSet = new Set(nodeUUIDs);
        const topmostUUIDs = nodeUUIDs.filter(uuid => {
            const node = state.nodeMap.get(uuid);
            if (!node) return false;
            // ไล่ขึ้นไปทุกชั้น ดูว่ามีบรรพบุรุษอยู่ในกลุ่มที่เลือกไหม
            let p = node.parent;
            while (p) {
                if (selectedSet.has(p.uuid)) return false;   // มี ancestor ใน selection → ไม่ topmost
                p = p.parent;
            }
            return true;
        });

        // ── แทรก pivotGroup เข้าใน hierarchy เดิม (ไม่ใช่ scene root) ──
        // สาเหตุ: ถ้าใส่ที่ scene root parent joint หมุนแล้ว child joint ไม่ตาม
        // วิธี: หา parent ของ topmost node แรก แล้วใส่ pivotGroup ไว้แทน
        let pivotParent = state.scene;
        if (topmostUUIDs.length > 0) {
            const firstTopNode = state.nodeMap.get(topmostUUIDs[0]);
            if (firstTopNode && firstTopNode.parent) pivotParent = firstTopNode.parent;
        }

        // แปลง world-space centroid → local space ของ pivotParent
        // เพราะ pivotGroup.position ต้องเป็น local space ของ parent มัน
        pivotParent.updateWorldMatrix(true, false);
        const localCentroid = pivotParent.worldToLocal(centroid.clone());
        pivotParent.add(pivotGroup);
        pivotGroup.position.copy(localCentroid);
        pivotGroup.updateWorldMatrix(true, false);
        pivotBasePosition = localCentroid.clone();    // เก็บไว้ reset position ทุก frame

        // ── ย้าย topmost nodes เป็น child ของ pivotGroup ──
        // attach() รักษา world position ไว้ (ไม่กระโดด)
        for (const uuid of topmostUUIDs) {
            const node = state.nodeMap.get(uuid);
            if (node && node.parent) {
                originalParentData.set(uuid, { parent: node.parent });  // เก็บ parent เดิม
                node.updateWorldMatrix(true, false);
                pivotGroup.updateWorldMatrix(true, false);
                pivotGroup.attach(node);
            }
        }
    }

    // ── สร้าง joint object ──
    const joint = {
        id: `joint_${state.jointIdCounter++}`,
        name,
        nodeUUIDs,
        entity: entityIdOfNode(state.nodeMap.get(nodeUUIDs[0])),   // อยู่โมเดลไหนในฉาก
        property,
        min, max, step,
        value: 0,               // ค่าปัจจุบัน (เริ่มที่ 0)
        baseValues,             // Map(uuid → ค่าเริ่มต้น) สำหรับ single-node joint
        pivotGroup,             // THREE.Group สำหรับ pivot (null ถ้า single node)
        pivotBasePosition,      // local position ของ pivotGroup ใช้ reset ทุก frame
        originalParentData,     // Map(uuid → { parent }) ใช้ restore เมื่อลบ joint
        simPattern,             // รูปคลื่นจำลอง (none/sine/…)
        simPeriod,              // ความยาว 1 รอบของคลื่นจำลอง (วินาที)
        jointType,              // revolute / continuous / coupled
        coupledTarget,          // id ของ joint ที่ตาม (เฉพาะ coupled)
        coupledRatio,           // อัตราส่วนที่ตาม
        srcTopic, srcPath,
        scale:  Number.isFinite(scale)  ? scale  : 1,    // ช่องว่าง → 1 (ไม่แปลงหน่วย)
        offset: Number.isFinite(offset) ? offset : 0,
        invert,
        unit,
        _pivotNodeUUID: dom.jointPivotNode.value,   // บันทึกไว้ export .dtwp
    };

    state.joints.push(joint);
    updatePresetControls();
    updateAnimControls();
    closeModal();

    // ── Reset selection ──
    state.checkedNodeUUIDs.clear();
    updateSelectionCount();
    updateAddJointButton();
    uncheckAllTreeCheckboxes();
    markBoundNodes();       // highlight node ที่ถูก bind แล้วใน tree
    renderJoints();
}
// ── removeJoint — ลบ joint และ restore hierarchy กลับสู่สภาพเดิม ──
function removeJoint(jointId) {
    // หาตำแหน่งใน array (ใช้ลบด้วย splice)
    const idx = state.joints.findIndex(j => j.id === jointId);
    if (idx === -1) return;
    const joint = state.joints[idx];

    if (joint.pivotGroup) {
        // ── Reset rotation + position ของ pivotGroup กลับ origin ก่อน detach ──
        // เพื่อให้ node กลับตำแหน่ง visual ที่ถูกต้องเมื่อ attach กลับ parent เดิม
        joint.pivotGroup.rotation.set(0, 0, 0);
        if (joint.pivotBasePosition) joint.pivotGroup.position.copy(joint.pivotBasePosition);
        joint.pivotGroup.updateWorldMatrix(true, true);

        // ── Restore node กลับ parent เดิม ──
        // attach() รักษา world position ไว้ขณะย้าย parent
        for (const [uuid, origData] of joint.originalParentData) {
            const node = state.nodeMap.get(uuid);
            if (node && origData.parent) origData.parent.attach(node);
        }

        // ── ลบ pivotGroup ออกจาก scene ──
        if (joint.pivotGroup.parent) joint.pivotGroup.parent.remove(joint.pivotGroup);
    } else {
        // ── single-node joint: restore ค่า property กลับ base value ──
        for (const uuid of joint.nodeUUIDs) {
            const node = state.nodeMap.get(uuid);
            const baseVal = joint.baseValues?.get(uuid);
            if (node && baseVal !== undefined) setNodePropertyValue(node, joint.property, baseVal);
        }
    }

    // เอาออกจาก array แล้ววาดหน้าจอใหม่
    state.joints.splice(idx, 1);
    markBoundNodes();
    renderJoints();
    updatePresetControls();
    updateAnimControls();
}

// ── getNodePropertyValue — อ่านค่า property ปัจจุบันของ node ──
// property เป็น string เช่น "rotation.y", "position.x", "visible"
function getNodePropertyValue(node, property) {
    // แยก "rotation.y" → prop = "rotation", axis = "y"
    const [prop, axis] = property.split('.');
    if (prop === 'visible') return node.visible ? 1 : 0;
    // node["rotation"]["y"] = node.rotation.y
    return node[prop][axis];
}

// ── setNodePropertyValue — กำหนดค่า property ของ node ──
function setNodePropertyValue(node, property, value) {
    const [prop, axis] = property.split('.');
    // visible: ค่า ≥ 0.5 = แสดง
    if (prop === 'visible') { node.visible = value >= 0.5; return; }
    node[prop][axis] = value;
}

// ── applyJointValue — apply ค่า joint ลง 3D objects จริงๆ ──
// ทุกครั้งที่ slider เคลื่อน / sim update / animation playback / ข้อความ MQTT เรียกฟังก์ชันนี้
function applyJointValue(joint, value) {
    // continuous joint หมุนต่อเนื่อง ไม่มี limit clamp
    const clamped = (joint.jointType === 'continuous')
        ? value
        : Math.min(joint.max, Math.max(joint.min, value));   // clamp ให้อยู่ใน min-max

    // จำค่าปัจจุบันไว้ (slider / preset / export ใช้)
    joint.value = clamped;

    if (joint.pivotGroup) {
        const [prop, axis] = joint.property.split('.');
        // ── Reset pivotGroup ทุก frame ก่อน apply ค่าใหม่ ──
        // ป้องกัน drift สะสมจาก floating point
        joint.pivotGroup.position.copy(joint.pivotBasePosition);
        joint.pivotGroup.rotation.set(0, 0, 0);
        // หมุน = ตั้งมุมตรงๆ · เลื่อน = บวกเพิ่มจากตำแหน่งตั้งต้น
        if (prop === 'rotation') joint.pivotGroup.rotation[axis] = clamped;
        else if (prop === 'position') joint.pivotGroup.position[axis] += clamped;
    } else {
        // ── single-node joint: apply ค่า relative จาก base ──
        // UR3: กระดูกแต่ละข้อ (ShoulderBone ฯลฯ) หมุนแบบนี้ — มุมใหม่ = มุมตั้งต้นในไฟล์ + ค่าของ joint
        for (const uuid of joint.nodeUUIDs) {
            const node = state.nodeMap.get(uuid);
            if (!node) continue;
            if (joint.property === 'visible') {
                setNodePropertyValue(node, joint.property, clamped);
            } else {
                // baseVal + clamped เพื่อให้ค่าเป็น offset จาก position เดิม
                const baseVal = joint.baseValues?.get(uuid) ?? 0;
                setNodePropertyValue(node, joint.property, baseVal + clamped);
            }
        }
    }
}

// ── syncJointUI — sync ค่าใน UI ทั้งหมดของ joint ให้ตรงกับค่าปัจจุบัน ──
// เรียกหลัง applyJointValue ทุกครั้ง
function syncJointUI(joint, value) {
    // หา element ในการ์ดของ joint นี้ด้วย id ที่ renderJoints ตั้งไว้
    const slider  = document.getElementById(`slider-${joint.id}`);
    const numEl   = document.getElementById(`num-${joint.id}`);
    const valEl   = document.getElementById(`val-${joint.id}`);
    const degEl   = document.getElementById(`deg-${joint.id}`);     // แสดงเป็นองศา
    const cardEl  = document.getElementById(`card-${joint.id}`);
    const limitEl = document.getElementById(`limit-${joint.id}`);   // warning icon

    // การ์ดอาจยังไม่ถูกวาด → เช็คก่อนทุกตัว
    if (slider) slider.value = value;
    if (numEl)  numEl.value  = value.toFixed(3);
    if (valEl)  valEl.textContent = value.toFixed(3);
    if (degEl) {
        // เดิมเดาจาก property ว่า rotation = radian เสมอ ซึ่งจริงเฉพาะกับ UR3
        // ตอนนี้ดูจาก unit ที่ผู้ใช้ระบุจริง
        if (joint.unit === 'rad') {
            degEl.textContent = `${(value * 180 / Math.PI).toFixed(1)}°`;   // องศาอ่านง่ายกว่า
        } else {
            degEl.textContent = joint.unit || '';                            // หน่วยอื่นแสดงชื่อหน่วยไปตรงๆ
        }
    }
    // เพิ่ม class 'simulating' เมื่อ sim กำลังรัน (เปลี่ยนสี card)
    if (cardEl) cardEl.classList.toggle('simulating', state.simRunning);

    // แสดง warning icon เมื่อค่า >= 90% ของ range
    if (limitEl && joint.jointType !== 'continuous') {
        const range = joint.max - joint.min;
        // ระยะจาก min คิดเป็นสัดส่วนของช่วง (0 = ที่ min · 1 = ที่ max)
        const pct = range > 0 ? Math.abs(value - joint.min) / range : 0;
        limitEl.style.display = pct >= 0.9 ? 'inline-flex' : 'none';
    }
}

// ── uncheckAllTreeCheckboxes — uncheck checkbox ทุกตัวใน node tree ──
// เรียกหลัง addJoint เสร็จ เพื่อ reset selection
function uncheckAllTreeCheckboxes() {
    document.querySelectorAll('.tree-checkbox').forEach(cb => { cb.checked = false; });
}

// ── markBoundNodes — highlight row ของ node ที่ถูก bind ใน joint แล้ว ──
// เพิ่ม class 'bound' → แสดงสีต่างให้ user รู้ว่า node นี้มี joint แล้ว
function markBoundNodes() {
    // ล้างของเก่าก่อน
    document.querySelectorAll('.tree-node-row.bound').forEach(el => el.classList.remove('bound'));
    // รวม uuid ทุกตัวที่อยู่ใน joint ใดก็ได้
    const allBound = new Set();
    for (const joint of state.joints) for (const uuid of joint.nodeUUIDs) allBound.add(uuid);
    allBound.forEach(uuid => {
        const row = document.querySelector(`.tree-node-row[data-uuid="${uuid}"]`);
        if (row) row.classList.add('bound');
    });
}

// ── calibrateJoint — คำนวณ offset ย้อนกลับจากท่าที่ผู้ใช้ตั้งไว้ ──
// วิธีใช้: กด Pause → ลาก slider จนโมเดลตรงกับของจริง → กดปุ่มนี้
// ระบบหาว่า offset ต้องเป็นเท่าไหร่ ค่าดิบถึงจะแปลงออกมาได้ท่านี้พอดี
// ผู้ใช้จึงไม่ต้องรู้เลยว่า -1.5708 มาจากไหน
// (UR3 ไม่ต้องทำแล้ว — offset ตั้งให้อัตโนมัติจาก ur3_default.dtwp)
function calibrateJoint(jointId) {
    const joint = state.joints.find(j => j.id === jointId);
    if (!joint) return;

    // ต้องเคยได้ค่าดิบจาก MQTT มาก่อน ถึงจะคำนวณย้อนได้
    if (!Number.isFinite(joint._lastRaw)) {
        alert('joint นี้ยังไม่เคยได้รับข้อมูลจาก MQTT\n\n'
            + 'ต้องกด Connect และผูก MQTT Topic / Payload Path ให้เรียบร้อยก่อน '
            + 'แล้วรอให้ข้อมูลเข้ามาอย่างน้อย 1 ครั้ง');
        return;
    }

    // ค่าที่จะได้ถ้า offset เป็น 0
    let base = joint._lastRaw * (joint.scale ?? 1);
    if (joint.invert) base = -base;

    // อยากให้ผลลัพธ์ออกมาเท่ากับ joint.value (ท่าที่ผู้ใช้ตั้งไว้)  →  offset = value - base
    joint.offset = joint.value - base;

    renderJoints();
    console.log(`Calibrate "${joint.name}": offset = ${joint.offset.toFixed(4)} rad `
              + `(${(joint.offset * 180 / Math.PI).toFixed(1)}°)`);
}

// ── setMqttPaused — หยุด/รับข้อมูลต่อ ──
// ตอน pause ยังรับ message ปกติ (ยังเก็บ _lastRaw และ payload inspector ยังอัปเดต)
// แค่ไม่ apply ลงโมเดล ผู้ใช้จึงลาก slider ได้โดยไม่โดนเขียนทับ 125 ครั้ง/วินาที
function setMqttPaused(paused) {
    state.mqttPaused = paused;
    // เปลี่ยนปุ่มเป็น Resume / Pause ตามสถานะ
    if (dom.btnMqttPause) {
        dom.btnMqttPause.innerHTML = paused
            ? '<span class="material-icons-round">play_arrow</span>Resume'
            : '<span class="material-icons-round">pause</span>Pause';
        dom.btnMqttPause.classList.toggle('paused', paused);
    }
    // ทำให้การ์ด joint ทุกใบรู้ว่ากำลัง pause (CSS แสดงคำใบ้)
    document.querySelectorAll('.joint-card')
            .forEach(c => c.classList.toggle('paused-hint', paused));
}

// ============================================================
// Network Stats — วัดคุณภาพการรับข้อมูล (latency / rate / jitter / ข้อความหาย)
//
// วัดได้เฉพาะช่วงตัวส่ง (ur3_publisher.py / replay.py) → เบราว์เซอร์ เพราะสองฝั่งอยู่เครื่องเดียวกัน
// ใช้นาฬิกาตัวเดียวกัน จึงลบเวลากันได้ตรงๆ
// ส่วนช่วงหุ่น/URSim → ur3_publisher.py วัดเป็น ms ไม่ได้ (นาฬิกาใน VM คนละตัว)
// แต่ดูคุณภาพได้จาก jitter กับจำนวนข้อความหายแทน
// ⚠ latency กับข้อความหาย ต้องมีช่อง t_publish / pub_seq ใน payload
//   replay.py ใส่ให้ · ur3_publisher.py ไม่ได้ใส่ → แสดง — และ 0 (Hz กับ jitter ยังวัดได้)
// ============================================================

// ── recordNetStats — บันทึกสถิติของข้อความที่เพิ่งมาถึง ──
// ถูกเรียกทุกข้อความ (125 ครั้ง/วินาที) ต้องเบา ห้ามคำนวณอะไรหนักตรงนี้
function recordNetStats(payload) {
    const s = state.netStats;
    const now = Date.now();

    // จดเวลาที่มาถึง (ใช้นับ Hz และหา jitter)
    s.arrivals.push(now);

    // latency = เวลามาถึง − เวลาที่ส่ง (t_publish เป็นวินาที → × 1000 เป็น ms)
    if (Number.isFinite(payload?.t_publish)) {
        s.latencies.push(now - payload.t_publish * 1000);
    }

    // ข้อความหาย: ใช้ pub_seq (ตัวนับที่ตัวส่งเพิ่มทีละ 1 ทุกข้อความ)
    // ถ้าเลขกระโดด เช่น 10 → 13 แปลว่าหายไป 2 ข้อความ (11 กับ 12)
    const seq = Number(payload?.pub_seq);
    if (Number.isFinite(seq)) {
        if (s.lastSeq !== null && seq > s.lastSeq + 1) s.lost += seq - s.lastSeq - 1;
        s.lastSeq = seq;
    }

    // ตัดข้อมูลเก่ากว่า 5 วินาทีทิ้ง กันหน่วยความจำโตไม่หยุดตอนเปิดค้างไว้นานๆ
    const cutoff = now - 5000;
    while (s.arrivals.length && s.arrivals[0] < cutoff) s.arrivals.shift();
    // latency เก็บแค่ 200 ค่าล่าสุด
    if (s.latencies.length > 200) s.latencies.splice(0, s.latencies.length - 200);
}

// ── renderNetStats — วาดแถบสถิติ เรียกทุก 1 วินาที ──
function renderNetStats() {
    const el = dom.netStats;
    if (!el) return;

    if (!state.mqttConnected) {
        el.innerHTML = '<span>ไม่ได้เชื่อมต่อ</span>';
        return;
    }

    const s = state.netStats;
    const now = Date.now();

    // rate = จำนวนข้อความในช่วง 1 วินาทีล่าสุด
    const rate = s.arrivals.filter(t => t > now - 1000).length;

    // latency = เฉลี่ย 20 ข้อความล่าสุด (ค่าเดี่ยวแกว่งเกินกว่าจะอ่านได้)
    const lat = s.latencies.slice(-20);
    const latAvg = lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null;

    // jitter = ส่วนเบี่ยงเบนมาตรฐานของช่วงห่างระหว่างข้อความ
    // บอกว่าข้อมูล "มาสม่ำเสมอไหม" ซึ่งสำคัญกว่า latency เฉลี่ยสำหรับงาน realtime
    // — หน่วง 50 ms คงที่ยังดูลื่น แต่หน่วง 20-80 ms สลับไปมาจะเห็นภาพกระตุก
    // gaps = ระยะห่างระหว่างข้อความที่ติดกัน (ms)
    const gaps = [];
    for (let i = 1; i < s.arrivals.length; i++) gaps.push(s.arrivals[i] - s.arrivals[i - 1]);
    let jitter = null;
    if (gaps.length > 1) {
        // SD = √(เฉลี่ยของ (ค่า − ค่าเฉลี่ย)²)
        const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        jitter = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
    }

    // ไม่มีค่า → แสดง —
    const fmt = (v) => v === null ? '—' : v.toFixed(0);

    // ⚡ latency · 📶 ข้อความ/วินาที · 〰 jitter · ✉ ข้อความหาย (สีแดงถ้ามีหาย)
    el.innerHTML =
        `<span title="เวลาเดินทาง ur3_publisher.py / replay.py → เบราว์เซอร์">⚡ ${fmt(latAvg)} ms</span>` +
        `<span title="ข้อความที่ได้รับต่อวินาที">📶 ${rate} Hz</span>` +
        `<span title="ความสม่ำเสมอของช่วงห่างระหว่างข้อความ">〰 ±${fmt(jitter)} ms</span>` +
        `<span class="${s.lost > 0 ? 'net-bad' : ''}" title="ข้อความที่หายระหว่างทาง (ดูจาก seq)">✉ ${s.lost}</span>`;
}
// ── start/stopNetStats — เปิด/ปิดการวัด ──
// เรียกตอนต่อ broker สำเร็จ
function startNetStats() {
    const s = state.netStats;
    s.arrivals = []; s.latencies = []; s.lastSeq = null; s.lost = 0;   // เริ่มนับใหม่ทุกครั้งที่ต่อ
    // กัน timer ซ้อน แล้วตั้งให้วาดแถบทุก 1 วินาที
    clearInterval(s.timer);
    s.timer = setInterval(renderNetStats, 1000);
    renderNetStats();
}
// เรียกตอนตัดการเชื่อมต่อ — หยุด timer แล้ววาดครั้งสุดท้าย (ขึ้น "ไม่ได้เชื่อมต่อ")
function stopNetStats() {
    clearInterval(state.netStats.timer);
    state.netStats.timer = null;
    renderNetStats();
}

// ============================================================
// Joint Rendering — สร้าง HTML card สำหรับแต่ละ joint
// รวม slider, number input, step buttons, reset, remove, show-nodes
// วาดใหม่ทั้งหมดทุกครั้งที่เพิ่ม/ลบ/แก้ joint
// ============================================================
function renderJoints() {
    // ไม่มี joint → ข้อความแนะนำ
    if (state.joints.length === 0) {
        dom.jointsContainer.innerHTML = `
            <div class="empty-state">
                <span class="material-icons-round">precision_manufacturing</span>
                <p>Check nodes in the tree, then click + to create a joint that controls them together</p>
            </div>`;
        return;
    }

    dom.jointsContainer.innerHTML = '';

    for (const joint of state.joints) {
        // หาชื่อ node จาก nodeList (nodeList เก็บ name แยกไว้เพื่อ UI)
        const nodeNames = joint.nodeUUIDs.map(uuid => {
            const info = state.nodeList.find(n => n.uuid === uuid);
            return info ? info.name : '?';
        });
        const isRotation = joint.property.startsWith('rotation');
        const isContinuous = joint.jointType === 'continuous';

        // กล่องการ์ด 1 ใบต่อ 1 joint (id ใช้หาในภายหลังจาก syncJointUI)
        const card = document.createElement('div');
        card.className = 'joint-card';
        card.id = `card-${joint.id}`;
        if (joint.simPattern !== 'none') card.classList.add('has-sim');  // ขอบสีพิเศษ

        // แสดงองศาใต้ slider เฉพาะ rotation property
        const degDisplay = isRotation
            ? `<span class="joint-deg-display" id="deg-${joint.id}">${(joint.value * 180 / Math.PI).toFixed(1)}°</span>`
            : '';

        // badge แสดง sim pattern ถ้ามี
        const simBadge = joint.simPattern !== 'none'
            ? `<span class="joint-badge sim-badge"><span class="material-icons-round">sensors</span>${joint.simPattern} (${joint.simPeriod}s)</span>`
            : '';

        // badge แสดง joint type (ถ้าไม่ใช่ revolute ปกติ)
        const typeBadge = (joint.jointType && joint.jointType !== 'revolute')
            ? `<span class="joint-badge type-badge"><span class="material-icons-round">rotate_right</span>${joint.jointType}</span>`
            : '';

        // continuous joint ให้ slider ไม่มี limit
        const sliderMin = isContinuous ? -999999 : joint.min;
        const sliderMax = isContinuous ?  999999 : joint.max;

        // โครงการ์ด (HTML):
        //   หัว:   ชื่อ joint · ไอคอนเตือนใกล้ขีดจำกัด · ปุ่มแก้ (edit) · ปุ่มลบ
        //   กลาง:  ปุ่ม − · slider · ปุ่ม + / ช่องพิมพ์ค่า · องศา · ปุ่ม Calibrate · ปุ่ม Reset
        //          badge property/หน่วย · จำนวน node · ชนิด · sim
        //   ท้าย:  ชื่อ node ที่ผูก (คลิกแล้วกรอบสีม่วงขึ้นในภาพ 3D)
        // id ของแต่ละส่วนมี joint.id ต่อท้าย เช่น slider-joint_6 ให้ syncJointUI หาเจอ
        card.innerHTML = `
            <div class="joint-card-header">
                <span class="joint-title">
                    <span class="material-icons-round">settings</span>
                    ${escapeHtml(joint.name)}
                </span>
                  <span class="joint-limit-warn" id="limit-${joint.id}" style="display:none" title="ใกล้ขีดจำกัด!">
                    <span class="material-icons-round" style="font-size:14px;color:#f97316">warning</span>
                </span>
                <button class="btn btn-icon edit-joint" data-id="${joint.id}" title="Edit Joint">
                    <span class="material-icons-round" style="font-size:16px;">edit</span>
                </button>
                <button class="btn btn-danger btn-icon remove-joint" data-id="${joint.id}" title="Remove Joint">
                    <span class="material-icons-round" style="font-size:16px;">delete</span>
                </button>
            </div>
            <div class="joint-card-body">
                <div class="joint-slider-row">
                    <button class="btn-step" data-id="${joint.id}" data-dir="-1">−</button>
                    <input type="range"
                        id="slider-${joint.id}"
                        min="${sliderMin}" max="${sliderMax}" step="${joint.step}"
                        value="${joint.value}">
                    <button class="btn-step" data-id="${joint.id}" data-dir="1">+</button>
                </div>
                <div class="joint-value-row">
                    <input type="number" class="joint-num-input" id="num-${joint.id}"
                        value="${joint.value.toFixed(3)}" step="${joint.step}"
                        ${isContinuous ? '' : `min="${joint.min}" max="${joint.max}"`}>
                    ${degDisplay}
                    <button class="btn-calib-joint" data-id="${joint.id}" title="Calibrate — ตั้ง offset จากท่าปัจจุบัน">
                        <span class="material-icons-round" style="font-size:14px">my_location</span>
                    </button>
                    <button class="btn-reset-joint" data-id="${joint.id}" title="Reset เป็น 0">
                        <span class="material-icons-round" style="font-size:14px">restart_alt</span>
                    </button>
                </div>
                <div class="joint-card-meta">
                    <span class="joint-badge">
                        <span class="material-icons-round">adjust</span>${joint.property}${joint.unit ? ` · ${escapeHtml(joint.unit)}` : ''}
                    </span>
                    <span class="joint-badge">
                        <span class="material-icons-round">link</span>
                        ${joint.nodeUUIDs.length} node${joint.nodeUUIDs.length > 1 ? 's' : ''}
                    </span>
                    ${typeBadge}${simBadge}
                </div>
            </div>
            <div class="joint-card-footer">
                <span class="joint-nodes-summary show-nodes"
                    data-nodes="${joint.nodeUUIDs.join(',')}"
                    title="${escapeHtml(nodeNames.join(', '))}">
                    <span class="material-icons-round" style="font-size:14px;">visibility</span>
                    ${escapeHtml(truncate(nodeNames.join(', '), 28))}
                </span>
            </div>`;

        dom.jointsContainer.appendChild(card);

        // ── Event: slider drag → apply + sync ──
        const slider = card.querySelector(`#slider-${joint.id}`);
        slider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            applyJointValue(joint, val);
            syncJointUI(joint, joint.value);
        });

        // ── Event: number input (พิมพ์ค่าตรง) ──
        // ใช้ 'change' = ทำงานตอนกด Enter หรือออกจากช่อง
        const numInput = card.querySelector(`#num-${joint.id}`);
        numInput.addEventListener('change', (e) => {
            const val = parseFloat(e.target.value);
            if (!isNaN(val)) {
                applyJointValue(joint, val);
                syncJointUI(joint, joint.value);
                if (slider) slider.value = joint.value;
            }
        });

        // ── Event: ปุ่ม +/− step ──
        // data-dir = −1 หรือ +1 → ค่าใหม่ = ค่าเดิม ± step
        card.querySelectorAll('.btn-step').forEach(btn => {
            btn.addEventListener('click', () => {
                const dir = parseFloat(btn.dataset.dir);
                applyJointValue(joint, joint.value + dir * joint.step);
                syncJointUI(joint, joint.value);
                if (slider) slider.value = joint.value;
            });
        });

        // ── Event: calibrate → คำนวณ offset จากท่าปัจจุบัน ──
        card.querySelector('.btn-calib-joint').addEventListener('click', () => calibrateJoint(joint.id));

        // ── Event: reset → ค่ากลับ 0 ──
        card.querySelector('.btn-reset-joint').addEventListener('click', () => {
            applyJointValue(joint, 0);
            syncJointUI(joint, 0);
            if (slider) slider.value = 0;
        });

        // ── Event: ลบ joint ──
        card.querySelector('.remove-joint').addEventListener('click', () => removeJoint(joint.id));

        // ── Event: แก้ไข joint ──
        card.querySelector('.edit-joint').addEventListener('click', () => openEditJointModal(joint.id));

        // ── Event: click "show nodes" → highlight node ทุกตัวใน viewport ──
        // data-nodes เก็บ uuid คั่นด้วยจุลภาค → แยกกลับเป็น array
        card.querySelector('.show-nodes').addEventListener('click', (e) => {
            highlightMultipleNodes(e.currentTarget.dataset.nodes.split(','));
        });
    }
}

// ============================================================
// Tab Switching — สลับแสดง tab content (Joints / Presets / Animation)
// ============================================================
function switchTab(tabId) {
    // toggle 'active' บน tab button
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabId);
    });
    // toggle 'hidden' บน tab content
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.toggle('hidden', content.id !== tabId);
    });
}

// ============================================================
// Presets — บันทึก/โหลด/ลบ สถานะ joint (snapshot ของทุก joint value)
// ============================================================

// ── savePreset — บันทึกค่า joint ปัจจุบันทั้งหมดเป็น preset ──
function savePreset() {
    if (state.joints.length === 0) return;
    // ถามชื่อ (prompt = กล่องพิมพ์ของเบราว์เซอร์)
    const name = prompt('Preset name:', `State ${state.presetIdCounter + 1}`);
    if (name === null) return;   // user กด cancel
    const finalName = name.trim() || `State ${state.presetIdCounter + 1}`;
    // { joint_6: 0.5, joint_7: -1.2, ... }
    const values = {};
    for (const joint of state.joints) values[joint.id] = joint.value;  // snapshot ค่า joint ทั้งหมด
    state.presets.push({
        id: `preset_${state.presetIdCounter++}`,
        name: finalName,
        values,
        savedAt: new Date().toLocaleTimeString(),
        jointCount: state.joints.length,
    });
    renderPresets();
}

// ── loadPreset — apply ค่า joint ทุกตัวตาม preset ──
function loadPreset(preset) {
    for (const joint of state.joints) {
        const val = preset.values[joint.id] ?? 0;   // ถ้าไม่มีค่าใน preset ใช้ 0
        applyJointValue(joint, val);
        syncJointUI(joint, joint.value);
    }
}

// ── deletePreset — ลบ preset ออกจาก list ──
function deletePreset(id) {
    state.presets = state.presets.filter(p => p.id !== id);
    renderPresets();
}

// ── renderPresets — สร้าง HTML card สำหรับแต่ละ preset ──
function renderPresets() {
    if (!dom.presetsContainer) return;
    // ไม่มี preset → ข้อความแนะนำ
    if (state.presets.length === 0) {
        dom.presetsContainer.innerHTML = `
            <div class="empty-state">
                <span class="material-icons-round">bookmark_border</span>
                <p>Set joints to a desired pose, then click Save State to capture it</p>
            </div>`;
        return;
    }
    dom.presetsContainer.innerHTML = '';
    state.presets.forEach(preset => {
        // การ์ด: ชื่อ · จำนวน joint · เวลาที่บันทึก · ปุ่ม Load / → KF / ลบ
        const card = document.createElement('div');
        card.className = 'preset-card';
        card.innerHTML = `
            <span class="material-icons-round preset-icon">bookmark</span>
            <div class="preset-info">
                <div class="preset-name">${escapeHtml(preset.name)}</div>
                <div class="preset-meta">${preset.jointCount} joints &middot; ${preset.savedAt}</div>
            </div>
            <div class="preset-actions">
                <button class="btn btn-secondary btn-sm btn-load-preset">
                    <span class="material-icons-round">play_circle</span>Load
                </button>
                <button class="btn btn-secondary btn-sm btn-preset-to-kf" title="Load preset แล้วบันทึกเป็น Keyframe">
                    <span class="material-icons-round">add_circle</span>→ KF
                </button>
                <button class="btn btn-danger btn-icon btn-del-preset">
                    <span class="material-icons-round" style="font-size:16px;">delete</span>
                </button>
            </div>`;

        // Load: apply preset ลง joints
        card.querySelector('.btn-load-preset').addEventListener('click', () => loadPreset(preset));

        // → KF: load preset แล้วบันทึกเป็น keyframe ทันที (shortcut workflow)
        card.querySelector('.btn-preset-to-kf').addEventListener('click', () => {
            loadPreset(preset);   // apply ค่า preset ลง joints ก่อน
            addKeyframe();        // capture joint values เป็น keyframe ทันที
        });

        // ลบ preset
        card.querySelector('.btn-del-preset').addEventListener('click', () => deletePreset(preset.id));
        dom.presetsContainer.appendChild(card);
    });
}
// ── updatePresetControls — enable/disable ปุ่ม Save/Export ตาม state ──
function updatePresetControls() {
    // บันทึกท่าได้เมื่อมี joint อย่างน้อย 1
    if (dom.btnSavePreset) dom.btnSavePreset.disabled = state.joints.length === 0;
    // Export ได้เมื่อมีอะไรให้บันทึกสักอย่าง
    if (dom.btnExportProject) dom.btnExportProject.disabled =
        state.joints.length === 0 && state.presets.length === 0 && state.keyframes.length === 0;
}

// ============================================================
// Project Export / Import — บันทึก/โหลดไฟล์ .dtwp (JSON)
// .dtwp เก็บ: รายการโมเดลในฉาก (entities) · joints (พร้อม nodeNames) · presets · keyframes
// ไม่ได้เก็บตัวไฟล์ .glb — เก็บแค่ชื่อไฟล์ ตอนเปิดต้องมีไฟล์อยู่ในโฟลเดอร์เว็บหรือบน server
// ============================================================

// ── buildProjectData — ประกอบข้อมูล project จาก state ปัจจุบัน ──
// แยกออกมาเพื่อให้ Export ไฟล์ กับ Save ขึ้น server ใช้ตัวเดียวกัน
// ถ้าไม่แยก เวลาเพิ่ม field ใหม่ (แบบที่เพิ่งเพิ่ม unit ไป) จะต้องแก้ 2 ที่
// แล้วลืมที่หนึ่ง กลายเป็นบั๊กที่หายากมาก
function buildProjectData() {
    return {
        // v2: เพิ่มรายการโมเดลในฉาก + joint.entity — ไฟล์ v1 เดิมยังเปิดได้ (ผูกกับหุ่นหลัก)
        version: 2,
        exportedAt: new Date().toISOString(),
        // โมเดลในฉาก: id · ชื่อไฟล์ · เป็นหุ่นหลักไหม · id บน server · หน่วย · ตำแหน่ง/หมุน/ขนาด
        entities: state.entities.map((e, i) => ({
            id: e.id, name: e.name, file: e.file, main: i === 0,
            model_id: e.modelId || null,
            units_per_meter: e.unitsPerMeter,
            position: e.position, rotation_deg: e.rotationDeg, scale: e.scale,
        })),
        // ตัวนับ id — เปิดไฟล์แล้วสร้างของใหม่ต่อ id จะไม่ชนของเดิม
        jointIdCounter: state.jointIdCounter,
        presetIdCounter: state.presetIdCounter,
        keyframeIdCounter: state.keyframeIdCounter,
        // joint ทุกตัว — แปลงให้เป็น JSON ได้ (ตัด Object3D / Map ทิ้ง เก็บแค่ค่า)
        joints: state.joints.map(j => ({
            id: j.id, name: j.name,
            entity: j.entity ?? null,
            nodeUUIDs: j.nodeUUIDs,
            // บันทึก nodeNames ด้วย เพราะ UUID เปลี่ยนทุกครั้งที่โหลด GLB ใหม่
            // importJoint จะ lookup node ด้วย name แทน UUID
            nodeNames: j.nodeUUIDs.map(uuid => state.nodeMap.get(uuid)?.name ?? null),
            pivotNodeUUID: j._pivotNodeUUID || 'centroid',
            pivotNodeName: (j._pivotNodeUUID && j._pivotNodeUUID !== 'centroid')
                ? (state.nodeMap.get(j._pivotNodeUUID)?.name ?? 'centroid') : 'centroid',
            property: j.property,
            min: j.min, max: j.max, step: j.step,
            value: j.value,
            simPattern: j.simPattern, simPeriod: j.simPeriod,
            jointType: j.jointType || 'revolute',
            coupledTarget: j.coupledTarget || null,
            coupledRatio: j.coupledRatio || 1,
            // ค่าการรับข้อมูล MQTT
            srcTopic: j.srcTopic || '',
            srcPath:  j.srcPath  || '',
            scale:    j.scale  ?? 1,
            offset:   j.offset ?? 0,
            invert:   !!j.invert,
            unit:     j.unit ?? '',
            // Map → object ธรรมดา (JSON เก็บ Map ไม่ได้)
            baseValues: j.baseValues ? Object.fromEntries(j.baseValues) : {},
            // baseValuesByName: lookup base value ด้วยชื่อ node (UUID-independent)
            baseValuesByName: j.baseValues
                ? Object.fromEntries([...j.baseValues.entries()].map(([uuid, val]) =>
                    [state.nodeMap.get(uuid)?.name ?? uuid, val]))
                : {},
        })),
        presets: state.presets,
        keyframes: state.keyframes,
    };
}

// ── exportProject — ดาวน์โหลดเป็นไฟล์ .dtwp ──
function exportProject() {
    const data = buildProjectData();
    // แปลงเป็นข้อความ JSON จัดย่อหน้า 2 ช่อง แล้วห่อเป็นไฟล์ในหน่วยความจำ
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    // สร้างลิงก์ชั่วคราวแล้วสั่งคลิก = เบราว์เซอร์ดาวน์โหลดไฟล์
    const a = document.createElement('a');
    a.href = url; a.download = 'digital-twin-project.dtwp'; a.click();
    URL.revokeObjectURL(url);
}

// ── applyProjectData — ใส่ joint/preset/keyframe จาก object ลง state ──
// รับ object ตรงๆ ไม่ผูกกับการอ่านไฟล์
// ใช้ร่วมกันทั้ง Import จากไฟล์ และ Open จาก server และ autoSetupJoints
// คืน { total, ok, failed } ให้ผู้เรียกไปแจ้งผลเอง
// opts.append = true  → เพิ่ม joint ต่อจากของเดิม ไม่ลบ ไม่แตะ preset/keyframe (ใช้ตอนตั้ง joint ให้โมเดลที่เพิ่มทีหลัง)
// opts.entity         → ผูก joint ทั้งหมดกับโมเดลนี้ (ไม่ระบุ = ตาม joint.entity ในไฟล์ หรือหุ่นหลัก)
function applyProjectData(data, opts = {}) {
    // ข้อมูลต้องมี joints เป็น array
    if (!data || !Array.isArray(data.joints)) throw new Error('รูปแบบข้อมูล project ไม่ถูกต้อง');
    const append = !!opts.append;
    let joints = data.joints;

    if (append) {
        // ตั้ง id ใหม่ไม่ให้ชนกับ joint ที่มีอยู่ — coupledTarget ชี้ตาม id ใหม่
        // ชื่อซ้ำกับของหุ่นตัวอื่น (เช่น UR3 ตัวที่สอง) ต่อท้ายด้วย id โมเดลให้แยกออก
        // idMap: id ในไฟล์ → id ใหม่
        const idMap = new Map(joints.map(j => [j.id, `joint_${state.jointIdCounter++}`]));
        const taken = new Set(state.joints.map(j => j.name));
        // { ...j } = คัดลอกทุกช่อง แล้วทับเฉพาะ id / name / coupledTarget
        joints = joints.map(j => ({ ...j, id: idMap.get(j.id),
            name: taken.has(j.name) && opts.entity ? `${j.name} (${opts.entity})` : j.name,
            coupledTarget: j.coupledTarget ? (idMap.get(j.coupledTarget) ?? null) : null }));
    } else {
        // ── ลบ joint เก่าทั้งหมดก่อน import ใหม่ ──
        const ids = state.joints.map(j => j.id);
        for (const id of ids) removeJoint(id);

        // ── Restore counter จากไฟล์ เพื่อให้ id ต่อเนื่อง ──
        if (data.jointIdCounter)    state.jointIdCounter    = data.jointIdCounter;
        if (data.presetIdCounter)   state.presetIdCounter   = data.presetIdCounter;
        if (data.keyframeIdCounter) state.keyframeIdCounter = data.keyframeIdCounter;
    }
    // id ของหุ่นหลัก — ใช้กับไฟล์ v1 ที่ joint ไม่ได้บอกว่าอยู่โมเดลไหน
    const mainId = state.entities[0]?.id ?? null;

    // ── เรียง joint จากมาก → น้อย nodeUUIDs (parent joint ก่อน child joint) ──
    // เหตุผล: joint ที่มี node มากกว่าคือ parent
    // ถ้า import child ก่อน parent จะพยายาม attach node ที่ยังไม่มี pivotGroup parent
    // ทำให้ตำแหน่งผิด
    const sortedJoints = [...joints].sort(
        (a, b) => (b.nodeUUIDs?.length || 0) - (a.nodeUUIDs?.length || 0)
    );
    // สร้าง joint ทีละตัว นับตัวที่ไม่สำเร็จ (หา node ไม่เจอ)
    let failed = 0;
    for (const cfg of sortedJoints) {
        if (!importJoint(cfg, opts.entity ?? cfg.entity ?? mainId)) failed++;
    }

    // ไม่ใช่โหมดต่อท้าย → ใช้ preset / keyframe จากไฟล์
    if (!append) {
        state.presets   = data.presets   || [];
        state.keyframes = data.keyframes || [];
    }

    // วาดทุกแผงใหม่
    markBoundNodes(); renderJoints(); renderPresets(); renderKeyframes();
    updateSelectionCount(); updatePresetControls(); updateAnimControls();
    renderSceneList();                       // จำนวน joint ต่อโมเดลเปลี่ยน

    const total = joints.length;
    return { total, ok: total - failed, failed };
}

// ── importProject — อ่านไฟล์ .dtwp แล้วส่งต่อให้ applyProjectData ──
function importProject(file) {
    // ต้องมีโมเดลก่อน — joint หา node ด้วยชื่อในโมเดล
    if (!state.model) { alert('Please load a 3D model first, then import the project file.'); return; }
    // FileReader อ่านไฟล์ในเครื่องเป็นข้อความ (ทำงานแบบ async → onload)
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = JSON.parse(e.target.result);
            // v2 มีรายการโมเดล — ตัวที่ยังไม่อยู่ในฉากลองดึงจากโฟลเดอร์เดียวกับเว็บ (เช่น ./simple_rubber_conveyor.glb)
            const missing = data.entities?.length
                ? await syncEntities(data.entities, spec => fetchFileBlob(`./${encodeURIComponent(spec.file)}`))
                : [];
            const { total, ok, failed } = applyProjectData(data);
            // แจ้งผล + รายชื่อโมเดลที่หาไม่เจอ (ถ้ามี)
            alert((failed === 0
                ? `Imported: ${ok} joint(s), ${state.presets.length} preset(s), ${state.keyframes.length} keyframe(s).`
                : `Imported ${ok}/${total} joints (${failed} failed). Presets and keyframes restored.`)
                + (missing.length ? `\n\nหาไฟล์โมเดลไม่เจอ: ${missing.join(', ')}\n`
                    + 'วางไฟล์ไว้ในโฟลเดอร์เดียวกับเว็บ หรือกด "เพิ่มโมเดล" เองแล้ว Import อีกครั้ง' : ''));
        } catch (err) { alert('Failed to read project file: ' + err.message); }
    };
    reader.readAsText(file);
}

// ============================================================
// Server — บันทึก/เปิด project จาก backend
//
// แก้ปัญหาที่ต้องพก .glb 9.5 MB กับ .dtwp ไปไหนมาไหน
// และปัญหาที่จำไม่ได้ว่าไฟล์คู่ไหนไปด้วยกัน — model_id ผูกให้แล้วที่ฝั่ง DB
// API อยู่ที่ backend/index.js (container dt-api)
// ============================================================

// เว็บเสิร์ฟจาก :3000 แต่ API อยู่ :3001 — คนละ origin ต้องระบุเต็ม
// วันหน้าถ้าเอาขึ้น server จริงแก้ที่เดียวตรงนี้
const API_BASE = 'http://localhost:3001';

// ── askSaveMode — ถามว่าจะบันทึกทับโปรเจกต์เดิม หรือสร้างโปรเจกต์ใหม่ ──
// คืน Promise: 'overwrite' · 'new' · null (ยกเลิก)
// สร้างหน้าต่างด้วย JS ใช้ class เดียวกับหน้าต่าง Add Joint จึงหน้าตาเหมือนกัน ไม่ต้องแก้ index.html
function askSaveMode(currentName) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal" style="max-width:440px">
                <div class="modal-header"><h3>บันทึกโปรเจกต์</h3></div>
                <div class="modal-body">
                    <p>ฉากนี้ผูกกับโปรเจกต์ "${escapeHtml(currentName || '')}" อยู่</p>
                    <p>ต้องการบันทึกทับของเดิม หรือสร้างเป็นโปรเจกต์ใหม่?</p>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" data-choice="">ยกเลิก</button>
                    <button class="btn btn-secondary" data-choice="new">สร้างใหม่</button>
                    <button class="btn btn-primary" data-choice="overwrite">บันทึกทับ</button>
                </div>
            </div>`;
        // คลิกปุ่มไหน → ปิดหน้าต่าง แล้วคืนค่าของปุ่มนั้น ('' = ยกเลิก → null)
        overlay.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-choice]');
            if (!btn) return;
            overlay.remove();
            resolve(btn.dataset.choice || null);
        });
        document.body.appendChild(overlay);
    });
}

// ── saveToServer — อัปโมเดล (ถ้ายังไม่เคยอัป) แล้วบันทึก project ──
async function saveToServer() {
    if (!state.entities.length) { alert('ยังไม่ได้โหลดโมเดล'); return; }

    // เคยบันทึก/เปิดโปรเจกต์อยู่แล้ว → ให้เลือกว่าจะทับของเดิมหรือสร้างใหม่
    // saveId = id ที่จะส่งไป · null = ให้ server สร้างโปรเจกต์ใหม่
    let saveId = state.projectId;
    if (saveId) {
        const mode = await askSaveMode(state.projectName);
        if (!mode) return;                       // กดยกเลิก
        if (mode === 'new') saveId = null;
    }

    // ถามชื่อ project — ทับของเดิมใช้ชื่อเดิม · สร้างใหม่เติม "(สำเนา)" กันชื่อซ้ำ
    const defName = saveId ? state.projectName
                  : state.projectName ? `${state.projectName} (สำเนา)` : 'UR3';
    const name = prompt('ชื่อ project', defName);
    if (!name) return;

    try {
        // ── 1. อัปทุกโมเดลในฉากที่ยังไม่เคยอัป ──
        // server เช็ค sha256 ให้ ถ้าไฟล์เดิมจะคืน id เก่ามาไม่เก็บซ้ำ
        for (const ent of state.entities) {
            if (ent.modelId) continue;
            if (!ent.blob) throw new Error(`ไม่พบไฟล์ของ ${ent.name} — ลองเพิ่มโมเดลใหม่อีกครั้ง`);
            // FormData = ส่งไฟล์แบบฟอร์ม (multipart) ชื่อช่อง "file" ตามที่ API รอรับ
            const fd = new FormData();
            fd.append('file', ent.blob, ent.file || 'model.glb');
            const r = await fetch(`${API_BASE}/api/models`, { method: 'POST', body: fd });
            if (!r.ok) throw new Error(`อัป ${ent.name} ไม่สำเร็จ (${r.status})`);
            const m = await r.json();
            ent.modelId = m.id;
            console.log(m.reused ? '[SRV] ใช้โมเดลเดิมบน server' : '[SRV] อัปโมเดลใหม่', ent.name, m.id);
        }
        // project ผูกกับหุ่นหลัก ส่วนโมเดลอื่นเก็บไว้ใน data.entities
        state.modelId = state.entities[0].modelId;

        // ── 2. บันทึก project ──
        // ส่ง saveId ไปด้วยถ้ามี → เขียนทับตัวเดิม · ไม่มี → server สร้างโปรเจกต์ใหม่
        const r2 = await fetch(`${API_BASE}/api/projects`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id:       saveId || undefined,
                name,
                model_id: state.modelId,
                data:     buildProjectData(),
            }),
        });
        if (!r2.ok) throw new Error(`บันทึก project ไม่สำเร็จ (${r2.status})`);
        const p = await r2.json();

        // จำ id กับชื่อไว้ — กด Save ครั้งหน้าจะทับตัวเดิม
        state.projectId   = p.id;
        state.projectName = p.name;
        alert(`บันทึกแล้ว: ${p.name}`);
    } catch (e) {
        alert('บันทึกไม่สำเร็จ: ' + e.message);
    }
}

// ── openServerDialog — ดึงรายชื่อ project มาแสดงให้เลือก ──
async function openServerDialog() {
    try {
        const r = await fetch(`${API_BASE}/api/projects`);
        if (!r.ok) throw new Error(`ดึงรายการไม่สำเร็จ (${r.status})`);
        const rows = await r.json();

        dom.serverList.innerHTML = '';
        if (rows.length === 0) {
            dom.serverList.innerHTML = '<span class="form-hint">ยังไม่มี project บน server — กด ☁️⬆️ เพื่อบันทึกอันแรก</span>';
        }
        // 1 แถวต่อ project: ชื่อ · ไฟล์โมเดล · เวลาแก้ล่าสุด — คลิกแล้วเปิด
        for (const p of rows) {
            const row = document.createElement('div');
            row.className = 'srv-row';
            row.innerHTML =
                `<span class="srv-name">${escapeHtml(p.name)}</span>` +
                `<span class="srv-meta">${escapeHtml(p.model_filename || 'ไม่มีโมเดล')}<br>` +
                `${new Date(p.updated_at).toLocaleString()}</span>`;
            row.addEventListener('click', () => loadFromServer(p.id));
            dom.serverList.appendChild(row);
        }
        dom.serverOverlay.classList.remove('hidden');
    } catch (e) {
        alert('เปิดรายการไม่สำเร็จ: ' + e.message);
    }
}
// ── loadFromServer — โหลดโมเดล แล้วค่อยใส่ joint ──
// ลำดับ: ดึง project → ดึงไฟล์หุ่นหลัก → โหลดเข้าฉาก → ดึงโมเดลอื่นใน data.entities → ใส่ joint
async function loadFromServer(projectId) {
    try {
        // ปิดกล่องรายการ
        dom.serverOverlay.classList.add('hidden');

        // ดึงข้อมูล project (ชื่อ · model_id · data = เนื้อหา .dtwp)
        const r = await fetch(`${API_BASE}/api/projects/${projectId}`);
        if (!r.ok) throw new Error(`ดึง project ไม่สำเร็จ (${r.status})`);
        const p = await r.json();

        if (!p.model_id) { alert('project นี้ไม่มีโมเดลผูกอยู่'); return; }

        // ── โหลดไฟล์ .glb มาเป็น Blob ──
        // loadModel ใช้ URL.createObjectURL อยู่แล้ว ซึ่งรับ Blob ได้ ไม่ต้องแก้อะไร
        const rf = await fetch(`${API_BASE}/api/models/${p.model_id}/file`);
        if (!rf.ok) throw new Error(`โหลดโมเดลไม่สำเร็จ (${rf.status})`);
        const blob = await rf.blob();

        // ── ใส่ joint ใน callback เท่านั้น ──
        // ถ้าใส่นอก callback จะทำงานก่อนโมเดลโหลดเสร็จ แล้ว importJoint
        // หา node ตามชื่อไม่เจอ → import ล้มทั้งหมดโดยไม่มี error ชัดเจน
        // ตั้งชื่อไฟล์ตามที่บันทึกไว้ — syncEntities จับคู่โมเดลด้วยชื่อไฟล์
        const ents = p.data?.entities || [];
        const mainSpec = ents.find(e => e.main) || ents[0];
        // ห่อ Blob เป็น File เพื่อให้มีชื่อไฟล์
        const mainFile = new File([blob], mainSpec?.file || 'model.glb');

        loadModel(mainFile, async (ent) => {
            ent.modelId       = p.model_id;
            state.modelId     = p.model_id;      // loadModel เคลียร์เป็น null ไป ต้องตั้งกลับ
            state.projectId   = p.id;
            state.projectName = p.name;
            try {
                // โมเดลอื่นในฉาก ดึงจาก server ด้วย model_id ของแต่ละตัว
                const missing = ents.length
                    ? await syncEntities(ents, spec => spec.model_id
                        ? fetchFileBlob(`${API_BASE}/api/models/${spec.model_id}/file`)
                        : Promise.reject(new Error('ไม่มี model_id')))
                    : [];
                // ใส่ joint / preset / keyframe
                const { total, ok, failed } = applyProjectData(p.data);
                alert((failed === 0
                    ? `เปิด "${p.name}" แล้ว — ${state.entities.length} โมเดล · ${ok} joint`
                    : `เปิด "${p.name}" — ${ok}/${total} joint (ล้มเหลว ${failed})`)
                    + (missing.length ? `\nโหลดโมเดลไม่ได้: ${missing.join(', ')}` : ''));
            } catch (e) {
                alert('ใส่ joint ไม่สำเร็จ: ' + e.message);
            }
        });
    } catch (e) {
        alert('เปิด project ไม่สำเร็จ: ' + e.message);
    }
}

// ── importJoint — สร้าง joint เดียวจาก config object ที่อ่านจาก .dtwp ──
// คืน true ถ้า import สำเร็จ, false ถ้า node หาไม่เจอ
// ทำงานแบบเดียวกับ addJoint แต่ค่ามาจากไฟล์แทนฟอร์ม
function importJoint(cfg, entityId = null) {
    // ── สร้าง nameToNode map สำหรับ lookup node ด้วยชื่อ ──
    // UUID เปลี่ยนทุกครั้งที่โหลด GLB ใหม่ แต่ชื่อ node คงที่
    // หาเฉพาะในโมเดลของ joint นี้ — โหลด UR3 สองตัว ชื่อกระดูกซ้ำกันจะได้ไม่ผูกผิดตัว
    const ent = entityId ? state.entities.find(e => e.id === entityId) : null;
    if (entityId && !ent) return false;                 // โมเดลของ joint นี้ไม่อยู่ในฉาก
    const nameToNode = new Map();
    // ไล่ทุก node ของโมเดล เก็บ ชื่อ → node (ชื่อซ้ำในโมเดลเดียวกัน ใช้ตัวแรกที่เจอ)
    (ent ? ent.root : state.model)?.traverse((node) => {
        if (node.name && !nameToNode.has(node.name)) nameToNode.set(node.name, node);
    });

    // ── Resolve nodes ด้วยชื่อก่อน (UUID เป็น fallback) ──
    const nodeNames = cfg.nodeNames || [];
    const resolvedNodes = [];
    for (let i = 0; i < nodeNames.length; i++) {
        const name = nodeNames[i];
        // มีชื่อ → หาด้วยชื่อ · ไม่มีชื่อ → ลอง uuid ตำแหน่งเดียวกัน
        const node = name ? nameToNode.get(name) : state.nodeMap.get(cfg.nodeUUIDs?.[i]);
        if (!node) return false;   // node หาไม่เจอ → import ไม่ได้
        resolvedNodes.push(node);
    }
    // ถ้า nodeNames ว่าง ลอง UUID แทน
    if (resolvedNodes.length === 0) {
        for (const uuid of (cfg.nodeUUIDs || [])) {
            const node = state.nodeMap.get(uuid);
            if (!node) return false;
            resolvedNodes.push(node);
        }
    }
    if (resolvedNodes.length === 0) return false;

    // uuid ของ node ที่หาเจอในการโหลดครั้งนี้
    const nodeUUIDs = resolvedNodes.map(n => n.uuid);
    // หลาย node → ใช้ pivotGroup · node เดียว → หมุน node ตรงๆ (UR3 เป็นแบบนี้ทุกข้อ)
    const usesPivot = nodeUUIDs.length > 1 && cfg.property !== 'visible';
    let pivotGroup = null, pivotBasePosition = null, originalParentData = null, baseValues = null;

    if (usesPivot) {
        // ── คำนวณ centroid เหมือน addJoint ──
        const centroid = new THREE.Vector3();
        const pivotNodeName = cfg.pivotNodeName || 'centroid';
        if (pivotNodeName !== 'centroid') {
            // ใช้ node เฉพาะเป็น pivot center
            const pn = nameToNode.get(pivotNodeName);
            if (pn) centroid.copy(getNodeCenter(pn));
            else {
                // fallback: centroid อัตโนมัติ
                let c = 0;
                for (const n of resolvedNodes) { centroid.add(getNodeCenter(n)); c++; }
                if (c > 0) centroid.divideScalar(c);
            }
        } else {
            // เฉลี่ยจุดกลางของทุก node
            let c = 0;
            for (const n of resolvedNodes) { centroid.add(getNodeCenter(n)); c++; }
            if (c > 0) centroid.divideScalar(c);
        }

        pivotGroup = new THREE.Group();
        pivotGroup.name = `__pivot_${cfg.id}`;

        // ── หา topmost nodes ──
        // ตัดตัวที่มีบรรพบุรุษอยู่ในกลุ่มเดียวกันออก (ติดตามบรรพบุรุษไปเองอยู่แล้ว)
        const selectedSet = new Set(nodeUUIDs);
        const topmostNodes = resolvedNodes.filter(node => {
            let p = node.parent;
            while (p) { if (selectedSet.has(p.uuid)) return false; p = p.parent; }
            return true;
        });

        // ── แทรก pivotGroup เข้า hierarchy เดิม (เหมือน addJoint) ──
        let pivotParent = state.scene;
        if (topmostNodes.length > 0 && topmostNodes[0].parent) pivotParent = topmostNodes[0].parent;
        // แปลงจุดหมุนจากพิกัดโลก → พิกัดของ parent
        pivotParent.updateWorldMatrix(true, false);
        const localCentroid = pivotParent.worldToLocal(centroid.clone());
        pivotParent.add(pivotGroup);
        pivotGroup.position.copy(localCentroid);
        pivotGroup.updateWorldMatrix(true, false);
        pivotBasePosition = localCentroid.clone();

        // ย้าย node ระดับบนสุดเข้าไปอยู่ใต้ pivotGroup (attach = ตำแหน่งในโลกไม่เปลี่ยน)
        originalParentData = new Map();
        for (const node of topmostNodes) {
            if (node.parent) {
                originalParentData.set(node.uuid, { parent: node.parent });
                node.updateWorldMatrix(true, false);
                pivotGroup.updateWorldMatrix(true, false);
                pivotGroup.attach(node);
            }
        }
    } else {
        // ── single-node joint: restore base values ด้วยชื่อ (UUID-independent) ──
        // ใช้ค่าตั้งต้นจากไฟล์ ถ้าไม่มีอ่านจาก node ตอนนี้
        baseValues = new Map();
        const byName = cfg.baseValuesByName || {};
        for (const node of resolvedNodes) {
            const saved = byName[node.name] ?? cfg.baseValues?.[node.uuid];
            baseValues.set(node.uuid, saved !== undefined ? saved : getNodePropertyValue(node, cfg.property));
        }
    }

    // ── สร้าง joint object แล้ว push ลง state ──
    const joint = {
        id: cfg.id, name: cfg.name, nodeUUIDs,
        _pivotNodeUUID: 'centroid',
        property: cfg.property,
        min: cfg.min, max: cfg.max, step: cfg.step,
        value: 0,
        baseValues, pivotGroup, pivotBasePosition, originalParentData,
        simPattern: cfg.simPattern || 'none',
        simPeriod: cfg.simPeriod || 3,
        jointType: cfg.jointType || 'revolute',
        coupledTarget: cfg.coupledTarget || null,
        coupledRatio: cfg.coupledRatio || 1,

        // ── default สำหรับ .dtwp เก่าที่ยังไม่มี field พวกนี้ ──
        // scale=1, invert=false, offset=0 → ค่าผ่านตรงๆ เหมือนเดิม ไฟล์เก่าจึงไม่พัง
        srcTopic: cfg.srcTopic || '',
        srcPath:  cfg.srcPath  || '',
        scale:    cfg.scale  ?? 1,
        offset:   cfg.offset ?? 0,
        invert:   !!cfg.invert,
        // .dtwp เก่าไม่มี unit → เดาจาก property ให้ เพื่อไม่ให้การแสดงองศาหายไป
        unit:     cfg.unit ?? defaultUnitFor(cfg.property),
        // อยู่โมเดลไหน (ระบุมา หรือไล่หาจาก node แรก)
        entity:   ent?.id ?? entityIdOfNode(resolvedNodes[0]),
    };


    state.joints.push(joint);
    applyJointValue(joint, cfg.value || 0);  // restore ค่า joint ที่บันทึกไว้
    return true;
}

// ============================================================
// Keyframe Animation — บันทึก/เล่น animation แบบ keyframe
//
// แนวคิด: แต่ละ keyframe เก็บ { time, values: { jointId → value } }
// เมื่อเล่น animation จะ interpolate (lerp) ระหว่าง keyframe คู่ที่ elapsed time อยู่
// ============================================================

// ── addKeyframe — บันทึก joint values ปัจจุบันเป็น keyframe ใหม่ ──
// time = เวลาของ keyframe ล่าสุด + 1 วินาที (เพิ่มทีละ 1s อัตโนมัติ)
function addKeyframe() {
    if (state.joints.length === 0) return;
    const kfs = state.keyframes;
    // ยังไม่มี keyframe → lastTime = −1 → ตัวแรกอยู่ที่ 0 วินาที
    const lastTime = kfs.length > 0 ? kfs[kfs.length - 1].time : -1;
    const time = parseFloat((lastTime + 1).toFixed(2));
    // เก็บค่าทุก joint ณ ตอนนี้
    const values = {};
    for (const joint of state.joints) values[joint.id] = joint.value;
    state.keyframes.push({ id: `kf_${state.keyframeIdCounter++}`, time, values });
    renderKeyframes();
    updateAnimControls();
    updateTimecodeDisplay();
}

// ── deleteKeyframe — ลบ keyframe และหยุด playback ถ้าเหลือ < 2 keyframe ──
function deleteKeyframe(id) {
    state.keyframes = state.keyframes.filter(kf => kf.id !== id);
    if (state.keyframes.length < 2) stopAnimationPlayback();  // ต้องมีอย่างน้อย 2 keyframe จึงเล่นได้
    renderKeyframes();
    updateAnimControls();
    updateTimecodeDisplay();
}

// ── renderKeyframes — สร้าง HTML สำหรับแต่ละ keyframe ──
// แสดงเวลา, ค่า joint แต่ละตัว, ปุ่ม preview / ลบ
function renderKeyframes() {
    if (!dom.animationContainer) return;
    // ไม่มี keyframe → ข้อความแนะนำ
    if (state.keyframes.length === 0) {
        dom.animationContainer.innerHTML = `
            <div class="empty-state">
                <span class="material-icons-round">movie</span>
                <p>Pose joints, click Add Keyframe. Repeat for each step, then Play.</p>
            </div>`;
        return;
    }
    dom.animationContainer.innerHTML = '';
    // เรียงตามเวลา (คัดลอกก่อนเรียง ไม่แก้ลำดับของจริง)
    const sorted = [...state.keyframes].sort((a, b) => a.time - b.time);
    sorted.forEach((kf, idx) => {
        const item = document.createElement('div');
        item.className = 'keyframe-item';
        item.id = `kf-item-${kf.id}`;

        // chips แสดงค่า joint แต่ละตัวใน keyframe นี้
        // joint หมุน → แสดงเป็นองศา · อื่นๆ → ทศนิยม 2 ตำแหน่ง
        const chips = Object.entries(kf.values).map(([jid, val]) => {
            const joint = state.joints.find(j => j.id === jid);
            if (!joint) return '';
            const disp = joint.property.startsWith('rotation')
                ? `${(val * 180 / Math.PI).toFixed(0)}°` : val.toFixed(2);
            return `<span class="keyframe-joint-chip">${escapeHtml(joint.name)}: ${disp}</span>`;
        }).join('');

        // หัว: ลำดับ KF · ช่องแก้เวลา · ปุ่มดูท่า · ปุ่มลบ / ล่าง: ค่าแต่ละ joint
        item.innerHTML = `
            <div class="keyframe-item-header">
                <span class="keyframe-index">KF ${idx + 1}</span>
                <div class="keyframe-time-group">
                    <label>t =</label>
                    <input class="keyframe-time-input" type="number" value="${kf.time}" min="0" step="0.1">
                    <label>s</label>
                </div>
                <button class="btn btn-secondary btn-sm btn-goto-kf" title="Preview this keyframe">
                    <span class="material-icons-round" style="font-size:14px;">visibility</span>
                </button>
                <button class="btn btn-danger btn-icon btn-del-kf">
                    <span class="material-icons-round" style="font-size:15px;">delete</span>
                </button>
            </div>
            <div class="keyframe-joints">${chips}</div>`;

        // แก้ไขเวลา keyframe ได้ตรงๆ (re-sort หลัง edit)
        item.querySelector('.keyframe-time-input').addEventListener('change', (e) => {
            kf.time = parseFloat(e.target.value) || 0;
            state.keyframes.sort((a, b) => a.time - b.time);
            renderKeyframes(); updateTimecodeDisplay();
        });

        // Preview: apply ค่าของ keyframe นี้ลง joints ให้ดูท่า
        item.querySelector('.btn-goto-kf').addEventListener('click', () => {
            for (const joint of state.joints) {
                const val = kf.values[joint.id] ?? 0;
                applyJointValue(joint, val);
                syncJointUI(joint, joint.value);
            }
        });

        // ลบ keyframe
        item.querySelector('.btn-del-kf').addEventListener('click', () => deleteKeyframe(kf.id));
        dom.animationContainer.appendChild(item);
    });
}
// ── updateAnimControls — enable/disable ปุ่ม Add Keyframe และ Play ──
function updateAnimControls() {
    if (dom.btnAddKeyframe) dom.btnAddKeyframe.disabled = state.joints.length === 0;
    if (dom.btnPlayAnim) dom.btnPlayAnim.disabled = state.keyframes.length < 2;  // ต้องมีอย่างน้อย 2 KF
}

// ── getTotalDuration — หา duration รวมของ animation (เวลาของ keyframe สุดท้าย) ──
function getTotalDuration() {
    if (state.keyframes.length < 2) return 0;
    // เวลาที่มากที่สุดในทุก keyframe
    return Math.max(...state.keyframes.map(kf => kf.time));
}

// ── updateTimecodeDisplay — อัปเดต "0.00s / 5.00s" ใน animation tab ──
function updateTimecodeDisplay() {
    if (dom.animTimecode) dom.animTimecode.textContent = `0.00s / ${getTotalDuration().toFixed(2)}s`;
}

// ── playAnimationPlayback — เริ่มเล่น animation ──
// ตั้ง animPlaying = true แล้ว animate() เรียก updateAnimationPlayback ทุกเฟรมเอง
function playAnimationPlayback() {
    if (state.keyframes.length < 2) return;
    state.animPlaying = true;
    state.animStartTime = performance.now() / 1000;  // บันทึกเวลาเริ่มต้น
    // เปลี่ยนปุ่มเป็น ⏸ และไฮไลต์ตัวนับเวลา
    dom.btnPlayAnim.classList.add('running');
    dom.btnPlayAnim.querySelector('.material-icons-round').textContent = 'pause';
    dom.animTimecode.classList.add('playing');
    if (state.simRunning) stopSimulation();   // หยุด sim ก่อนเล่น animation
}

// ── stopAnimationPlayback — หยุดเล่น animation ──
function stopAnimationPlayback() {
    state.animPlaying = false;
    // คืนปุ่มเป็น ▶ (เช็คก่อนเพราะอาจเรียกตอนหน้าเว็บยังไม่พร้อม)
    if (dom.btnPlayAnim) {
        dom.btnPlayAnim.classList.remove('running');
        dom.btnPlayAnim.querySelector('.material-icons-round').textContent = 'play_arrow';
    }
    if (dom.animTimecode) dom.animTimecode.classList.remove('playing');
    // ลบ highlight active keyframe
    document.querySelectorAll('.keyframe-item.active-kf').forEach(el => el.classList.remove('active-kf'));
}

// ── toggleAnimationPlayback — สลับ play/pause ──
function toggleAnimationPlayback() {
    if (state.animPlaying) stopAnimationPlayback();
    else playAnimationPlayback();
}

// ── updateAnimationPlayback — เรียกทุก frame เมื่อ animPlaying = true ──
// คำนวณ elapsed time → หา keyframe คู่ที่อยู่รอบ elapsed → lerp ค่า joint
function updateAnimationPlayback() {
    // เรียงตามเวลา แล้วเอาเวลาของตัวสุดท้ายเป็นความยาวทั้งหมด
    const kfs = [...state.keyframes].sort((a, b) => a.time - b.time);
    const totalDuration = kfs[kfs.length - 1].time;
    if (totalDuration <= 0) { stopAnimationPlayback(); return; }

    // เล่นมาแล้วกี่วินาที
    const now = performance.now() / 1000;
    let elapsed = now - state.animStartTime;

    // ── จัดการเมื่อ animation ถึงจุดสิ้นสุด ──
    if (elapsed >= totalDuration) {
        if (state.animLoop) {
            // loop: ต่อจากต้นใหม่ โดยเลื่อน startTime ไปข้างหน้า
            state.animStartTime += totalDuration;
            elapsed = elapsed % totalDuration;
        } else {
            // ไม่ loop: หยุดที่ keyframe สุดท้าย
            applyKeyframeValues(kfs[kfs.length - 1]);
            stopAnimationPlayback();
            if (dom.animTimecode) dom.animTimecode.textContent = `${totalDuration.toFixed(2)}s / ${totalDuration.toFixed(2)}s`;
            return;
        }
    }

    // ── หา keyframe คู่ kfA–kfB ที่ elapsed อยู่ระหว่าง ──
    let kfA = kfs[0], kfB = kfs[1];
    for (let i = 0; i < kfs.length - 1; i++) {
        if (elapsed >= kfs[i].time && elapsed <= kfs[i + 1].time) {
            kfA = kfs[i]; kfB = kfs[i + 1]; break;
        }
    }

    // ── Linear interpolation (lerp) ระหว่าง kfA และ kfB ──
    // alpha = 0 → kfA, alpha = 1 → kfB
    // เช่น kfA ที่ 1 วิ · kfB ที่ 3 วิ · ตอนนี้ 2 วิ → alpha = 0.5 (ครึ่งทาง)
    const segDur = kfB.time - kfA.time;
    const alpha = segDur > 0 ? (elapsed - kfA.time) / segDur : 1;

    for (const joint of state.joints) {
        const valA = kfA.values[joint.id] ?? 0;
        const valB = kfB.values[joint.id] ?? 0;
        const val = valA + (valB - valA) * alpha;   // lerp formula: a + (b-a)*t
        applyJointValue(joint, val);
        syncJointUI(joint, joint.value);
    }

    // อัปเดตตัวนับเวลา
    if (dom.animTimecode) dom.animTimecode.textContent = `${elapsed.toFixed(2)}s / ${totalDuration.toFixed(2)}s`;

    // highlight keyframe ปัจจุบัน (kfA) ใน list
    document.querySelectorAll('.keyframe-item').forEach(el => el.classList.remove('active-kf'));
    const activeEl = document.getElementById(`kf-item-${kfA.id}`);
    if (activeEl) activeEl.classList.add('active-kf');
}

// ── applyKeyframeValues — apply ค่า joint ทั้งหมดของ keyframe เดียว (ไม่มี lerp) ──
// ใช้ตอน preview keyframe และ snap ไป final keyframe เมื่อ animation จบ
function applyKeyframeValues(kf) {
    for (const joint of state.joints) {
        const val = kf.values[joint.id] ?? 0;
        applyJointValue(joint, val);
        syncJointUI(joint, joint.value);
    }
}

// ============================================================
// Sensor Simulation — จำลองสัญญาณ sensor ที่ขับเคลื่อน joint อัตโนมัติ
// แต่ละ joint มี simPattern (none/sine/triangle/sawtooth/square/random)
// และ simPeriod (ความยาว 1 รอบในวินาที)
//
// ⚠ ปุ่มเล่น simulation บนหัวเว็บถูกแทนด้วยแถบเครื่องมือจัดฉากแล้ว
//   startSimulation จึงไม่มีที่เรียก (dom.btnSimToggle / simStatus ไม่มีแล้ว)
//   โค้ดส่วนนี้คงไว้เผื่อใช้ต่อ — stopSimulation ยังถูกเรียกได้อย่างปลอดภัย
// ============================================================

// ── startSimulation — เริ่ม simulation ──
function startSimulation() {
    state.simRunning = true;
    state.simStartTime = performance.now() / 1000;
    dom.btnSimToggle.classList.add('running');
    dom.btnSimToggle.querySelector('.material-icons-round').textContent = 'pause';
    dom.btnSimToggle.title = 'Pause Simulation';
    dom.simStatus.className = 'sim-status active';
    dom.simStatus.innerHTML = '<span class="sim-dot"></span>Simulating';
}

// ── stopSimulation — หยุด simulation ──
function stopSimulation() {
    state.simRunning = false;
    // ไม่มีปุ่ม (ถูกเอาออกแล้ว) → จบตรงนี้ ไม่แตะ element ที่ไม่มี
    if (!dom.btnSimToggle) return;
    dom.btnSimToggle.classList.remove('running');
    dom.btnSimToggle.querySelector('.material-icons-round').textContent = 'play_arrow';
    dom.btnSimToggle.title = 'Start Simulation';
    dom.simStatus.className = 'sim-status';
    dom.simStatus.innerHTML = '<span class="sim-dot"></span>Idle';
}

// ── toggleSimulation — สลับ start/stop ──
function toggleSimulation() {
    if (state.simRunning) stopSimulation();
    else startSimulation();
}

// ── updateSimulation — เรียกทุก frame เมื่อ simRunning = true ──
// คำนวณค่า joint จาก wave pattern และ elapsed time
function updateSimulation() {
    const now = performance.now() / 1000;
    const elapsed = (now - state.simStartTime) * state.simSpeed;  // คูณ speed factor

    for (const joint of state.joints) {

        // ── Coupled joint: ค่า = source joint × ratio ──
        // ไม่ใช้ wave pattern เพราะค่าถูกกำหนดโดย joint อื่น
        if (joint.jointType === 'coupled') {
            if (joint.coupledTarget) {
                const source = state.joints.find(j => j.id === joint.coupledTarget);
                if (source) {
                    const val = source.value * (joint.coupledRatio ?? 1);
                    applyJointValue(joint, val);
                    syncJointUI(joint, joint.value);
                }
            }
            continue;   // ข้าม wave pattern processing
        }

        if (joint.simPattern === 'none') continue;  // manual-only joint ไม่อัปเดต

        // t = กี่รอบผ่านไปแล้ว (0.0 = เริ่ม, 1.0 = ครบ 1 รอบ)
        const t = elapsed / joint.simPeriod;
        const range = joint.max - joint.min;
        let normalized = 0;   // ค่า 0–1 ตาม pattern

        switch (joint.simPattern) {
            case 'sine':
                // sin ให้ค่า -1 ถึง 1 → แปลงเป็น 0–1
                normalized = (Math.sin(t * Math.PI * 2) + 1) / 2;
                break;
            case 'triangle':
                // ขึ้น-ลงเป็นเส้นตรง
                normalized = 1 - Math.abs(((t % 1) * 2) - 1);
                break;
            case 'sawtooth':
                // เพิ่มต่อเนื่องแล้ว reset
                normalized = t % 1;
                break;
            case 'square':
                // สลับ 0/1 ทุกครึ่งรอบ
                normalized = (t % 1) < 0.5 ? 0 : 1;
                break;
            case 'random':
                // pseudo-random โดยใช้ sin/cos หลาย frequency ซ้อน
                normalized = (Math.sin(t * 7.13) * Math.cos(t * 3.71) + 1) / 2;
                break;
        }

        // ── Continuous joint: หมุนต่อเนื่องไม่หยุด ──
        // ค่า = elapsed × speed (ไม่ใช้ normalized)
        let value;
        if (joint.jointType === 'continuous') {
            value = elapsed * (joint.max > 0 ? joint.max : 1);
        } else {
            // แปลง normalized 0–1 → ค่าจริงใน range [min, max]
            value = joint.min + normalized * range;
        }

        applyJointValue(joint, value);
        syncJointUI(joint, joint.value);
    }
}

// ============================================================
// MQTT — ผูก joint กับข้อมูล realtime จาก broker
//
// ไม่มี topic หรือ payload format ตายตัวในโค้ด — แต่ละ joint กำหนดเองผ่าน
//   srcTopic  : topic ที่ฟัง (รองรับ wildcard + และ #)
//   srcPath   : ตำแหน่งค่าใน payload เช่น "actual_q[0]"
//   scale / invert / offset : แปลงหน่วยและจุดศูนย์ให้ตรงกับ node ในโมเดล
//
// Flow: broker publish → หา joint ที่ topic ตรง → resolvePath → แปลงค่า → 3D ขยับ
// UR3: ตั้งจาก ur3_default.dtwp → srcTopic = ur/telemetry · srcPath = actual_q[0] ถึง actual_q[5]
// ============================================================

// ── resolvePath — อ่านค่าจาก payload ตาม path string ──
//   "actual_q[0]" → payload.actual_q[0]
//   "data.j1"     → payload.data.j1
//   ""            → payload ทั้งก้อน (กรณี payload เป็นตัวเลขเดี่ยว)
function resolvePath(obj, path) {
    if (!path) return obj;
    // ตัดด้วย . [ ] → ["actual_q", "0"] แล้วเดินเข้าไปทีละชั้น (เจอ null/undefined กลางทาง → undefined)
    return path.split(/[.\[\]]+/).filter(Boolean)
               .reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
// ── topicMatches — เทียบ topic กับ pattern แบบ MQTT wildcard ──
//   "+" = แทน 1 ระดับ   |   "#" = แทนทุกระดับที่เหลือ (ต้องอยู่ท้ายสุด)
// เช่น pattern "ur/+" ตรงกับ "ur/telemetry" · pattern "#" ตรงกับทุก topic
function topicMatches(pattern, topic) {
    if (!pattern) return false;
    // แยกเป็นระดับด้วย / แล้วเทียบทีละระดับ
    const p = pattern.split('/'), t = topic.split('/');
    for (let i = 0; i < p.length; i++) {
        if (p[i] === '#') return true;
        if (i >= t.length) return false;
        if (p[i] === '+') continue;
        if (p[i] !== t[i]) return false;
    }
    // จำนวนระดับต้องเท่ากันพอดี
    return p.length === t.length;
}

// ── jointTopics — รวบ topic ที่ต้อง subscribe จาก joint ทั้งหมด (ตัดซ้ำ) ──
function jointTopics() {
    // Set ตัดตัวซ้ำ · filter(Boolean) ตัดค่าว่าง
    return [...new Set(state.joints.map(j => j.srcTopic).filter(Boolean))];
}

// ── resubscribeJoints — subscribe เพิ่มหลังผู้ใช้แก้ topic ระหว่างที่ต่ออยู่ ──
function resubscribeJoints() {
    if (!state.mqttClient || !state.mqttConnected) return;
    const topics = jointTopics();
    if (topics.length === 0) return;
    state.mqttClient.subscribe(topics, (err, granted) => {
        if (err) { console.error('MQTT subscribe error:', err); return; }
        console.log('MQTT subscribed:', granted);
    });
}

// กัน console ท่วมเวลามีข้อความเข้ามาแต่ไม่มี joint ตัวไหนรับ — เตือนครั้งเดียวต่อ topic
const warnedTopics = new Set();

// ── flattenPaths — แตก payload เป็นรายการ path → ค่า ──
// { actual_q:[1,2], robot:"ur3" }
//   → [["actual_q[0]",1], ["actual_q[1]",2], ["robot","ur3"]]
// path ที่ได้ใช้กับ resolvePath() ได้ตรงๆ — เป็นคู่ผกผันกัน
// ใช้ใน Payload Inspector ให้ผู้ใช้คลิกเลือก path แทนการพิมพ์
function flattenPaths(obj, prefix = '', out = []) {
    if (out.length > 200) return out;                     // กัน payload ยักษ์ทำเบราว์เซอร์ค้าง
    // เจอค่าธรรมดา (ตัวเลข/ข้อความ/null) → เก็บคู่ path กับค่า
    if (obj === null || typeof obj !== 'object') { out.push([prefix, obj]); return out; }
    if (Array.isArray(obj)) {
        // array → ต่อ path เป็น [0], [1], …
        obj.forEach((v, i) => flattenPaths(v, `${prefix}[${i}]`, out));
    } else {
        // object → ต่อ path ด้วย .ชื่อคีย์
        for (const [k, v] of Object.entries(obj)) {
            flattenPaths(v, prefix ? `${prefix}.${k}` : k, out);
        }
    }
    return out;
}



// ── FORECAST — ทำนายว่าเดินต่อเนื่องไปอีกนานๆ จะเกิดอะไรขึ้น ──
//
// วิธี: วัดสภาพปัจจุบันจากการเดินจริง 1 รอบ แล้วอนุมานด้วยสมการความร้อนอันดับหนึ่ง
//   T(t) = T∞ − (T∞ − T₀) · e^(−t/τ)
//   T₀ = อุณหภูมิตอนเริ่ม · T∞ = เพดาน (ห้อง + ค่าที่ร้อนขึ้นได้สูงสุด) · τ = เวลาที่ไต่ไปได้ 63%
//
// ค่าคงที่ทุกตัวมาจากข้อมูลหุ่นจริง 2.45 ล้านแถว ไม่มีตัวไหนสมมติ:
//   tau      ฟิตจาก long_run 44 นาทีต่อเนื่อง 327,866 แถว  RMSE 0.008-0.013°C
//   t_inf    อุณหภูมิสูงสุดที่วัดได้จริงตลอด 8 วันทำงาน (7-9 ชม./วัน)
//   speeds   วัดจาก 20 runs ต่อความเร็ว
//   trackErr ค่าคลาดเคลื่อนฐานรายข้อของ run ปกติ
//
// ⚠ ความเร็วไม่มีผลต่อความร้อน — วัดแล้วกระแสเท่ากันทั้ง 3 ความเร็ว (1.736-1.741 A)
//   เพราะกระแสเกือบทั้งหมดใช้ต้านแรงโน้มถ่วง ไม่ใช่เร่งความเร็ว
//   ความเร็วมีผลกับ "ปริมาณงานต่อชั่วโมง" และ "การสึกหรอเชิงกล" เท่านั้น
// ค่าทั้งหมดมาจาก config/params.json — ดูที่มาของแต่ละตัวได้ในช่อง "_" ของไฟล์นั้น
const FORECAST_CAL = {
    tauMin:       PARAMS.thermal.tau_min,           // นาที
    riseC:        PARAMS.thermal.rise_c,            // °C เหนืออุณหภูมิห้อง
    ambientRef:   PARAMS.thermal.ambient_ref_c,     // ค่าเริ่มต้นถ้าผู้ใช้ไม่ระบุ
    trackErrUrad: PARAMS.diagnosis.base_err_urad,   // คลาดเคลื่อนปกติรายข้อ (µrad)
    // ค่าที่วัดได้ของแต่ละความเร็ว (30 / 50 / 100%)
    speeds: PARAMS.measured.speeds.map(s => ({
        pct:    s.pct,
        runSec: s.run_sec,                          // วินาทีต่อ 1 รอบงาน
        // ไม่ได้เก็บไว้ คำนวณเอง: หมุนต่อรอบ ÷ เวลาต่อรอบ × 3600
        // แก้ run_sec หรือ rot_rad_per_cycle ใน params.json แล้วตัวนี้เปลี่ยนตาม
        rotPerHr: s.rot_rad_per_cycle / s.run_sec * 3600,
        iRms:   s.i_rms,                            // กระแสรวมเฉลี่ย (A)
    })),
};

// เกณฑ์อุณหภูมิของ Universal Robots — params.json → ur_limits
// temp_warn_c = 50 °C (เตือน) · temp_shutdown_c = 85 °C (ตัดการทำงาน)
const UR_LIMITS = PARAMS.ur_limits;

// ── ช่วงค่าที่ยอมรับของแต่ละช่อง — params.json → forecast_inputs ──
// ช่องเป็น text แล้ว ผู้ใช้พิมพ์อะไรก็ได้ ต้องบีบเองก่อนเอาไปคำนวณ
const FC_LIMITS = PARAMS.forecast_inputs;

// ── fcNum — อ่านช่อง text แล้วบีบให้อยู่ในช่วง ──
// ถ้าค่าถูกแก้ จะเขียนกลับลงช่องพร้อมขอบสีเหลือง ผู้ใช้จะเห็นว่าโดนปรับ
function fcNum(id) {
    // lim = { min, max, def } ของช่องนี้
    const lim = FC_LIMITS[id];
    const el  = document.getElementById(id);
    if (!el) return lim.def;
    const raw = el.value.trim();
    // ไม่ใช่ตัวเลข → ค่าเริ่มต้น
    let v = parseFloat(raw);
    if (!Number.isFinite(v)) v = lim.def;
    // บีบให้อยู่ระหว่าง min ถึง max
    v = Math.min(lim.max, Math.max(lim.min, v));
    // ค่าที่ใช้ต่างจากที่พิมพ์ → เขียนกลับ + class fixed (ขอบเหลือง)
    const changed = String(v) !== raw;
    if (changed) el.value = v;
    el.classList.toggle('fixed', changed);
    return v;
}

// ── fcDuration — รวมช่อง ชม. กับ นาที เป็นนาทีรวม ──
// พิมพ์ 90 ในช่องนาทีได้ ระบบทดเป็น 1 ชม. 30 นาที แล้วเขียนกลับให้เห็น
function fcDuration() {
    const h = fcNum('fc-hr');
    const m = fcNum('fc-min');
    // อย่างน้อย 1 นาที
    const total = Math.max(1, h * 60 + m);

    // แปลงนาทีรวมกลับเป็น ชม. + นาที
    const nh = Math.floor(total / 60);
    const nm = Math.round(total % 60);
    // มีการทด → เขียนค่าใหม่ลงช่องพร้อมขอบเหลือง
    const carried = (nh !== h || nm !== m);
    const eh = document.getElementById('fc-hr');
    const em = document.getElementById('fc-min');
    if (eh) { eh.value = nh; eh.classList.toggle('fixed', carried); }
    if (em) { em.value = nm; em.classList.toggle('fixed', carried); }
    return total;
}

// ── fmtDur — 150 → "2 ชม. 30 นาที" ──
function fmtDur(min) {
    const h = Math.floor(min / 60), m = Math.round(min % 60);
    if (h && m) return `${h} ชม. ${m} นาที`;
    if (h)      return `${h} ชั่วโมง`;
    return `${m} นาที`;
}

// ── fmtSec — 120 → "2 นาที", 75 → "1 นาที 15 วิ" ──
function fmtSec(sec) {
    const total = Math.round(sec);
    const m = Math.floor(total / 60), s = total % 60;
    return m && s ? `${m} นาที ${s} วิ` : m ? `${m} นาที` : `${s} วิ`;
}

// ============================================================
// โหมดเร่งเวลา — เหมือน fast-forward คลิป YouTube
// ผู้ใช้บอกแค่เวลาที่อยากรู้ ระบบคูณเอง แล้วดูจบใน FF_WATCH_SEC วินาที
//   ตัวคูณ = เวลาที่ขอ ÷ เวลาที่ใช้ดู   (2 ชม. ÷ 2 นาที = 60×)
// ปุ่มบนเว็บส่งคำสั่งไป replay.py → replay.py ส่งข้อมูลหุ่นจริงแบบข้ามแถวกลับมา
// ============================================================
const FF_WATCH_SEC = PARAMS.timelapse.watch_sec;    // params.json → timelapse.watch_sec
// มีข้อมูลเดินต่อเนื่องจริงแค่ความเร็วที่วัดไว้ — ค่าอื่นปัดไปตัวที่ใกล้สุด
const FF_SPEEDS = PARAMS.measured.speeds.map(s => s.pct);
// เช่นขอ 40% → ได้ 30% (ใกล้สุด)
const ffSpeed = (pct) =>
    FF_SPEEDS.reduce((a, b) => (Math.abs(b - pct) < Math.abs(a - pct) ? b : a));

// ── renderPlan — บอกก่อนกดปุ่มว่าจะเร่งกี่เท่า ──
function renderPlan() {
    const el = document.getElementById('fc-plan');
    if (!el) return;
    // want = ที่ผู้ใช้พิมพ์ · pct = ความเร็วที่มีข้อมูลจริงที่ใกล้สุด
    const want = fcNum('fc-speed'), pct = ffSpeed(want);
    const T = fcDuration();
    const sp = interpSpeed(pct);
    // ขอสั้นกว่าเวลาดู → ดูตามจริง (ไม่เร่ง)
    const watch = Math.min(FF_WATCH_SEC, T * 60);
    // จำนวนรอบ = วินาทีทั้งหมด ÷ วินาทีต่อรอบ · ตัวคูณ = วินาทีทั้งหมด ÷ เวลาดู
    el.innerHTML =
        `${fmtDur(T)} = <b>${(T * 60 / sp.runSec).toFixed(1)} รอบ</b> ที่ ${pct}%<br>`
      + `ดูจบใน <b>${fmtSec(watch)}</b> · เร่ง <b>${(T * 60 / watch).toFixed(1)}×</b>`
      + (pct !== want
         ? `<br><span class="fc-warn">มีข้อมูลจริงแค่ 30 / 50 / 100% ใช้ ${pct}% แทน</span>`
         : '');
}

// ── applyTimelapse — เรียกทุกข้อความ telemetry ก่อนวาดแผงสถานะ ──
// ช่วง ff_real=false อุณหภูมิในข้อมูลวนซ้ำ (รอบที่เอามาเล่นซ้ำอัดตอนเครื่องเย็น)
// แทนด้วยสมการความร้อนต่อจากค่าจริงล่าสุด — แก้เฉพาะที่เว็บแสดง ข้อมูลต้นทางไม่ถูกแตะ
function applyTimelapse(p) {
    const ff = state.ff;
    // ไม่ได้อยู่ในโหมดเร่ง หรือข้อความไม่มีอุณหภูมิ → ไม่ทำอะไร
    if (!ff || !p || p.ff == null || !Array.isArray(p.joint_temperatures)) return;

    if (p.ff_real) {
        // ช่วงข้อมูลจริง → จำอุณหภูมิล่าสุดกับเวลาไว้เป็นจุดตั้งต้นของสมการ
        ff.lastReal = p.joint_temperatures.map(Number);
        ff.lastRealSec = p.ff_sim_sec;
        if (!ff.startTemps) ff.startTemps = ff.lastReal.slice();
    } else if (ff.lastReal) {
        // ช่วงเล่นซ้ำ → คำนวณจากสมการ: เวลาที่ผ่านไปหลังข้อมูลจริงหมด (นาที)
        const tMin = (p.ff_sim_sec - ff.lastRealSec) / 60;
        // แทนอุณหภูมิ 6 ข้อด้วย T(t) = T∞ − (T∞ − T₀)·e^(−t/τ)
        p.joint_temperatures = ff.lastReal.map((T0, i) => {
            const tInf = ff.amb + FORECAST_CAL.riseC[i];
            return tInf - (tInf - T0) * Math.exp(-tMin / FORECAST_CAL.tauMin[i]);
        });
    }
    // จำสถานะล่าสุดไว้วาดตัวนับ
    ff.simSec = p.ff_sim_sec;
    ff.real = !!p.ff_real;
    ff.temps = p.joint_temperatures.map(Number);
    renderFFLive();
}

// ── renderFFLive — ตัวนับวิ่งระหว่างเร่ง วาด 10 ครั้ง/วิ พอ ──
function renderFFLive() {
    const ff = state.ff, now = performance.now();
    // จบแล้ว หรือยังไม่ครบ 100 ms จากครั้งก่อน → ข้าม
    if (ff.done || now - (ff.drawn || 0) < 100) return;
    ff.drawn = now;
    const sp = interpSpeed(ff.pct);
    // ข้อที่ร้อนที่สุด (ตำแหน่ง 0–5)
    const h = ff.temps.indexOf(Math.max(...ff.temps));
    // แสดง: เวลาที่เล่นไป / ทั้งหมด · ตัวคูณ · จำนวนรอบ · หมุนสะสม · อุณหภูมิข้อที่ร้อนสุด (จริง/อนุมาน)
    document.getElementById('fc-out').innerHTML =
        `<div class="fc-head">⏩ ${fmtDur(ff.simSec / 60)} / ${fmtDur(ff.T / 60)} · `
      + `${ff.mult.toFixed(1)}×</div>`
      + `<div class="fc-line">รอบ <b>${(ff.simSec / sp.runSec).toFixed(1)}</b> · หมุนสะสม `
      + `<b>${Math.round(sp.rotPerHr * ff.simSec / 3600).toLocaleString()} rad</b></div>`
      + `<div class="fc-line">J${h + 1} <b>${ff.temps[h].toFixed(1)}°C</b> `
      + (ff.real ? '<span class="fc-tag real">ข้อมูลจริง</span>'
                 : '<span class="fc-tag est">อนุมาน</span>') + `</div>`
      + (ff.mult > 1 ? '<div class="fc-note">AI หยุดทายระหว่างเร่ง — '
                     + 'โมเดลต้องใช้ข้อมูลความเร็วปกติครบ 1 วินาที</div>' : '');
}

// ── renderFFResult — สรุปตอนเร่งจบ ──
function renderFFResult() {
    const ff = state.ff;
    const out = document.getElementById('fc-out');
    if (!ff.temps) {
        out.innerHTML = '<div class="fc-note">ไม่ได้รับข้อมูลระหว่างเร่ง</div>';
        return;
    }
    const sp = interpSpeed(ff.pct);
    // ข้อที่ร้อนที่สุดตอนจบ · อุณหภูมิตอนเริ่มและตอนจบของข้อนั้น · เพดานของข้อนั้น
    const h = ff.temps.indexOf(Math.max(...ff.temps));
    const end = ff.temps[h], start = ff.startTemps?.[h];
    const tInf = ff.amb + FORECAST_CAL.riseC[h];
    // เกณฑ์ Universal Robots: เตือน 50°C · ตัดการทำงาน 85°C
    const level = end >= UR_LIMITS.temp_shutdown_c ? 'bad'
                : end >= UR_LIMITS.temp_warn_c     ? 'warn' : 'ok';
    // กี่นาทีที่เป็นค่าอนุมาน (เวลาที่ขอ − ช่วงข้อมูลจริง)
    const estMin = Math.max(0, ff.T - ff.realSec) / 60;
    // สรุป: หัวสีตามระดับ · อุณหภูมิเริ่ม → จบ · เพดาน/เกณฑ์ · ปริมาณงาน · ที่มาของข้อมูล
    out.innerHTML =
        `<div class="fc-head ${level}">${level === 'ok' ? '✓' : '⚠'} `
      + `เดินต่อเนื่อง ${fmtDur(ff.T / 60)} `
      + `<span class="fc-dim">(ดูใน ${fmtSec(ff.watch)} · ${ff.mult.toFixed(1)}×)</span></div>`
      + `<div class="fc-line">อุณหภูมิ J${h + 1} <b>`
      + (start != null ? `${start.toFixed(1)}°C → ` : '') + `${end.toFixed(1)}°C</b> `
      + `(เพดาน ${tInf.toFixed(1)}°C · เตือน ${UR_LIMITS.temp_warn_c} `
      + `· ตัด ${UR_LIMITS.temp_shutdown_c})</div>`
      + `<div class="fc-line">ปริมาณงาน <b>${(ff.T / sp.runSec).toFixed(1)} รอบ</b> · หมุนสะสม `
      + `<b>${Math.round(sp.rotPerHr * ff.T / 3600).toLocaleString()} rad</b></div>`
      + `<div class="fc-note">ข้อมูลจริง ${fmtDur(ff.realSec / 60)} แรก (${ff.block})`
      + (estMin > 0
         ? `<br>อีก ${fmtDur(estMin)} ท่าจาก ${ff.filler} เล่นซ้ำ · อุณหภูมิอนุมานจากสมการ`
         : '')
      + `</div>`;
}
// ── interpSpeed — หาค่าอ้างอิงของความเร็วที่ขอ ──
// มีข้อมูลจริงแค่ 3 จุด (30 / 50 / 100%) ค่าอื่นต้องประมาณเชิงเส้น
// คืน exact=true เฉพาะเมื่อตรงจุดที่วัดจริง — ใช้ติดป้ายใน UI
function interpSpeed(pct) {
    const S = FORECAST_CAL.speeds;
    // ตรงจุดที่วัดไว้ → ใช้ค่านั้นเลย
    const hit = S.find(s => s.pct === pct);
    if (hit) return { ...hit, exact: true };

    // นอกช่วงที่มีข้อมูล → ใช้ตัวที่ใกล้สุด พร้อมบอกว่าถูกบีบ
    if (pct <= S[0].pct) return { ...S[0], pct, exact: false, clamped: 'ต่ำกว่าข้อมูลที่มี' };
    if (pct >= S[2].pct) return { ...S[2], pct, exact: false, clamped: 'สูงกว่าข้อมูลที่มี' };

    // อยู่ระหว่าง 30–50 (i=0) หรือ 50–100 (i=1) → ลากเส้นตรงระหว่างสองจุด
    const i = pct < S[1].pct ? 0 : 1;
    const a = S[i], b = S[i + 1];
    // w = สัดส่วนระยะจาก a ไป b (0 = ที่ a · 1 = ที่ b)
    const w = (pct - a.pct) / (b.pct - a.pct);
    const mix = (x, y) => x + (y - x) * w;
    return {
        pct, exact: false,
        runSec:    mix(a.runSec,    b.runSec),
        rotPerHr:  mix(a.rotPerHr,  b.rotPerHr),
        iRms:      mix(a.iRms,      b.iRms),
    };
}

// ── forecastRun — คำนวณผลการเดินต่อเนื่อง ──
//   speedPct     ความเร็วที่ user ตั้ง (%)
//   durationMin  ระยะเวลาที่ถาม (นาที)
//   temps0       อุณหภูมิ 6 ข้อ ณ ตอนนี้ (วัดสดจากรอบที่เพิ่งเดิน)
//   iRms         กระแสรวมที่วัดได้จริง (ไว้เทียบกับค่าอ้างอิง)
//   ambientC     อุณหภูมิห้อง (ไม่ใส่ = ค่าอ้างอิงใน params.json)
function forecastRun({ speedPct, durationMin, temps0, iRms, ambientC }) {
    const cal = FORECAST_CAL;
    const sp = interpSpeed(speedPct);
    const t = durationMin;
    const amb = Number.isFinite(ambientC) ? ambientC : cal.ambientRef;

    // อุณหภูมิรายข้อที่เวลา t
    // เพดานเลื่อนตามอุณหภูมิห้อง — ห้องร้อนขึ้น 5° เพดานขึ้น 5° ตามกันทุกข้อ
    const joints = temps0.map((T0, i) => {
        const tInf = amb + cal.riseC[i], tau = cal.tauMin[i];
        // สมการความร้อนอันดับหนึ่ง
        const at = tInf - (tInf - T0) * Math.exp(-t / tau);
        return {
            joint: i + 1, now: T0, at: at, tInf,
            rise: at - T0,
            // ถึง 95% ของการไต่ที่ 3τ
            settleMin: 3 * tau,
        };
    });

    // ข้อที่จะร้อนที่สุดตอนจบ
    const hottest = joints.reduce((a, b) => (b.at > a.at ? b : a));
    const hours = t / 60;
    // จำนวนรอบงาน = วินาทีทั้งหมด ÷ วินาทีต่อรอบ
    const runs = (t * 60) / sp.runSec;
    // หมุนสะสมทั้งหมด (rad) = หมุนต่อชั่วโมง × ชั่วโมง
    const rotation = sp.rotPerHr * hours;

    // เทียบกับความเร็วปกติ 50% เป็นฐาน
    const base = cal.speeds[1];
    const workRatio = sp.rotPerHr / base.rotPerHr;

    // ข้อความเตือนประกอบผล
    const notes = [];
    if (!sp.exact) {
        notes.push(sp.clamped
            ? `ความเร็ว ${speedPct}% ${sp.clamped} (วัดจริงแค่ 30 / 50 / 100%) ใช้ค่าที่ใกล้ที่สุด`
            : `ความเร็ว ${speedPct}% ไม่มีข้อมูลตรง ประมาณเชิงเส้นจาก 30 / 50 / 100%`);
    }
    // กระแสที่วัดได้ต่างจากค่าอ้างอิงเกิน 15% → ภาระต่างจากที่ใช้ฟิตสมการ
    if (Number.isFinite(iRms)) {
        const d = Math.abs(iRms - sp.iRms) / sp.iRms;
        if (d > 0.15) {
            notes.push(`กระแสเฉลี่ยของรอบ ${iRms.toFixed(2)} A ต่างจากค่าอ้างอิง `
                     + `${sp.iRms.toFixed(2)} A เกิน 15% — คำทำนายอุณหภูมิอาจคลาดเคลื่อน`);
        }
    }
    // ข้อมูลเพื่อนต่อเนื่องยาวสุด 43.7 นาที (long_run) เลยจากนี้ไม่มีข้อมูลจริงยืนยัน
    if (t > 43.7) {
        notes.push(`เกิน 43.7 นาทีที่มีข้อมูลจริงต่อเนื่อง — อุณหภูมิช่วง `
                 + `${(t - 43.7).toFixed(0)} นาทีหลังเป็นค่าอนุมาน`);
    }

    // ปลอดภัย = ข้อที่ร้อนสุดยังต่ำกว่าเกณฑ์เตือนของ UR (50 °C)
    const safe = hottest.at < UR_LIMITS.temp_warn_c;
    return {
        speed: sp, durationMin: t, ambientC: amb,
        joints, hottest,
        runs, rotation, workRatio,
        settleMin: hottest.settleMin,
        safe,
        verdict: safe
            ? `เดินต่อเนื่อง ${(t / 60).toFixed(1)} ชั่วโมงได้ปลอดภัย — `
            + `อุณหภูมิเข้าสมดุลที่ ${hottest.at.toFixed(1)}°C ไม่ไต่หนี ไม่พบสัญญาณเสื่อมสภาพ`
            : `อุณหภูมิคาดว่าจะถึง ${hottest.at.toFixed(1)}°C ควรตรวจสอบเพิ่มเติม`,
        notes,
    };
}

// ── onReplayStatus — รับสถานะจาก replay.py (topic ur/replay_status) ──
// ปุ่ม "เริ่มวิเคราะห์" ส่งคำสั่งเร่งเวลา (cmd 'ff') → replay.py ตอบกลับเป็นลำดับ
//   start → playing (ความคืบหน้า) → done   หรือ error / busy
// โหมด ff จบแล้วสรุปด้วย renderFFResult · โหมดเล่น 1 รอบ (cmd 'run') จบแล้วใช้ renderForecast
function onReplayStatus(s) {
    // element ในแผง FORECAST: แถบโหลด · กล่องผล · ปุ่ม
    const bar = document.getElementById('fc-bar');
    const out = document.getElementById('fc-out');
    const btn = document.getElementById('fc-go');
    if (!bar || !out || !btn) return;

    if (s.state === 'start') {
        // เริ่มรอบใหม่: ล้างตัวสะสมกระแส สถิติเตือน และค่าเฉลี่ยวินิจฉัย
        state.iAcc = { sum: 0, n: 0 };
        resetAlertStats();                   // เริ่มรอบใหม่ ล้างช่วงมุม/เร็วสุด
        hpEma.err = null; hpEma.n = 0;       // ล้างค่าเฉลี่ยวินิจฉัย ไม่ให้ค่ารอบก่อนค้างมา
        // แสดงแถบโหลดที่ 0%
        bar.classList.remove('hidden');
        bar.firstElementChild.style.width = '0%';
        out.innerHTML = `<div class="fc-line">กำลังเดิน <b>${s.run_id}</b> `
                      + `${s.run_seconds} วินาที</div>`;
        // โหมดเร่งเวลา: เตรียมตัวนับให้ applyTimelapse ใช้
        state.ff = s.mode === 'ff' ? {
            pct: s.speed_pct, T: s.duration_sec, watch: s.watch_sec, mult: s.mult,
            realSec: s.real_sec, block: s.block, filler: s.filler,
            amb: fcNum('fc-amb'), simSec: 0, real: true, done: false,
        } : null;
        if (state.ff) out.innerHTML = `<div class="fc-line">⏩ เริ่มเร่ง ${s.mult}× …</div>`;
    } else if (s.state === 'playing') {
        // ขยับแถบโหลดตาม progress (0–1 → 0–100%)
        bar.firstElementChild.style.width = (s.progress * 100).toFixed(0) + '%';
    } else if (s.state === 'done') {
        // จบ → ซ่อนแถบ เปิดปุ่ม แล้วสรุปผล
        bar.classList.add('hidden');
        btn.disabled = false;
        if (s.mode === 'ff' && state.ff) {
            state.ff.done = true;       // เฟรมที่มาช้ายังแทนอุณหภูมิต่อ แต่ไม่วาดทับผลสรุป
            renderFFResult();
        } else {
            renderForecast(s);
        }
    } else if (s.state === 'error' || s.state === 'busy') {
        // ผิดพลาด / replay.py กำลังเล่นอย่างอื่นอยู่ → แสดงข้อความ
        bar.classList.add('hidden');
        btn.disabled = false;
        out.innerHTML = `<div class="fc-note">${s.message || s.state}</div>`;
    }
}

// ── renderForecast — replay 1 รอบจบ → เอาอุณหภูมิที่วัดได้ล่าสุดเข้า forecastRun แล้ววาดผล ──
// (โหมดเร่งเวลาใช้ renderFFResult แทน · ปุ่มบนเว็บตอนนี้ส่งโหมดเร่งเวลาอย่างเดียว)
function renderForecast(s) {
    const out = document.getElementById('fc-out');
    // อุณหภูมิล่าสุดที่ renderHealthPanel เก็บไว้
    const temps = state.lastTemps;
    if (!temps) {
        out.innerHTML = '<div class="fc-note">ยังไม่ได้รับอุณหภูมิ — ต่อ broker แล้วลองใหม่</div>';
        return;
    }
    const dur = fcDuration();
    // กระแส: ค่าเฉลี่ยทั้งรอบถ้ามี ไม่งั้นค่าล่าสุด
    const r = forecastRun({
        speedPct: fcNum('fc-speed'),
        durationMin: dur,
        temps0: temps,
        iRms: state.iAcc?.n ? state.iAcc.sum / state.iAcc.n : state.lastIRms,
        ambientC: fcNum('fc-amb'),
    });

    // ผล: หัวสีตามความปลอดภัย · อุณหภูมิตอนนี้ → ปลายทาง · นาทีที่เกือบถึงเพดาน · ปริมาณงาน · ที่มาของค่า
    out.innerHTML =
        `<div class="fc-head ${r.safe ? 'ok' : 'bad'}">`
      + `${r.safe ? '✓' : '⚠'} เดินต่อเนื่อง ${fmtDur(dur)}</div>`
      + `<div class="fc-line">อุณหภูมิ J${r.hottest.joint} `
      + `<b>${r.hottest.now.toFixed(1)}°C → ${r.hottest.at.toFixed(1)}°C</b> `
      + `(เพดาน ${r.hottest.tInf}°C)</div>`
      // ที่ 3τ ไต่ไปแล้ว 95% เสมอ แต่ระยะที่เหลือเป็นองศาขึ้นกับจุดเริ่ม เลยบอกเป็น %
      + `<div class="fc-line">อุณหภูมิเกือบถึงเพดาน (ไต่ไปแล้ว 95%) `
      + `นาทีที่ <b>${Math.round(r.settleMin)}</b></div>`
      + `<div class="fc-line">ปริมาณงาน <b>${Math.round(r.runs)} รอบ</b> · `
      + `หมุนสะสม <b>${Math.round(r.rotation)} rad</b></div>`
      + `<div class="fc-line">เทียบความเร็วปกติ <b>${r.workRatio.toFixed(2)} เท่า</b></div>`
      + `<div class="fc-note">วัดสด: อุณหภูมิเริ่มต้น · กระแสเฉลี่ยของรอบ<br>`
      + `จากข้อมูลเพื่อน: เวลาต่อรอบ · หมุนต่อรอบ · τ · เพดาน<br>`
      + `อนุมาน: อุณหภูมิปลายทาง (τ จากข้อมูลจริง 43.7 นาที)`
      + (r.notes.length ? '<br>' + r.notes.join('<br>') : '') + `</div>`;
}

// ── initForecastPanel — ผูกช่องกรอก + ปุ่ม "เริ่มวิเคราะห์" ของแผง FORECAST ──
// กดปุ่ม → publish ur/command {cmd:'ff'} ให้ replay.py เล่นแบบเร่งเวลา
function initForecastPanel() {
    const btn = document.getElementById('fc-go');
    if (!btn) return;

    // กล่องแผนคำนวณใหม่ตอนกด Enter หรือคลิกออกจากช่อง
    // ไม่ใช้ 'input' เพราะ fcNum บีบค่ากลางคันตอนยังพิมพ์ไม่จบ
    for (const id of ['fc-speed', 'fc-hr', 'fc-min']) {
        document.getElementById(id)?.addEventListener('change', renderPlan);
    }
    renderPlan();

    btn.addEventListener('click', () => {
        // ต้องต่อ broker ก่อน ถึงจะส่งคำสั่งได้
        if (!state.mqttClient || !state.mqttConnected) {
            document.getElementById('fc-out').innerHTML =
                '<div class="fc-note">ยังไม่ได้ต่อ broker — กด Connect ก่อน</div>';
            return;
        }
        renderPlan();
        // ปิดปุ่มกันกดซ้ำ (เปิดคืนตอน done / error)
        btn.disabled = true;
        document.getElementById('fc-out').innerHTML =
            '<div class="fc-line">กำลังส่งคำสั่ง…</div>';
        // บอกแค่เวลา ตัวคูณให้ replay.py คิดเอง (สูตรเดียวกับ renderPlan)
        state.mqttClient.publish('ur/command', JSON.stringify({
            cmd: 'ff',
            speed_pct:    ffSpeed(fcNum('fc-speed')),
            duration_min: fcDuration(),
            watch_sec:    FF_WATCH_SEC,
        }));
    });
}
// ผูกทันทีตอนโหลดไฟล์ (element ของแผงอยู่ใน index.html แล้ว)
initForecastPanel();


// เปิดให้เรียกจาก DevTools Console — app.js โหลดเป็น ES module
window.forecastRun = forecastRun;
window.FORECAST_CAL = FORECAST_CAL;
// ── MODEL_RELIANCE — โมเดลพึ่งช่องสัญญาณไหนตัดสินแต่ละคลาส ──
//
// วัดด้วยวิธี occlusion: ปิดบังทีละช่องจาก 23 ช่อง แล้วดูว่าความมั่นใจตกเท่าไหร่
// ทำบนข้อมูลหุ่นจริง 72 หน้าต่าง (8 คลาส × 3 รอบ × 3 ตำแหน่ง)
// ฝังค่าไว้ตายตัวเพราะคำนวณสดไม่ไหว — ต้องยิงโมเดล 23 ครั้งต่อการทำนาย 1 ครั้ง
//
// ⚠ ต้องตรงกับ Model_RF_v2 (8 คลาส) ที่ predict_mqtt.py ใช้อยู่
//   ตัวเก่า 9 คลาสมี payload_normal ซึ่งถูกยุบเข้า normal ไปแล้ว
//
// top   = 4 ช่องที่พึ่งมากสุด
// force = สัดส่วนที่พึ่งกลุ่มแรง (tcp_force + fx fy fz tx ty tz) หน่วยเปอร์เซ็นต์
// ชื่อช่อง: q1-q6 มุม · i1-i6 กระแส · fx..tz แรง/แรงบิด · tcp_speed/tcp_force ค่ารวมปลายแขน
const MODEL_RELIANCE = {
    friction:            { top: ['tcp_speed', 'tz', 'fx', 'ty'],          force: 48 },
    normal:              { top: ['tcp_speed', 'fz', 'tcp_force', 'i3'],   force: 41 },
    payload_heavy:       { top: ['fz', 'i2', 'tcp_force', 'tz'],          force: 50 },
    payload_forced_drop: { top: ['tcp_speed', 'tz', 'i3', 'tcp_force'],   force: 31 },
    payload_heavy_drop:  { top: ['q1', 'ty', 'tcp_force', 'fy'],          force: 67 },
    gripper_low:         { top: ['tz', 'tcp_speed', 'fz', 'i4'],          force: 47 },
    speed_30:            { top: ['tcp_force', 'fz', 'tz', 'q4'],          force: 40 },
    speed_100:           { top: ['tcp_speed', 'ty', 'tcp_force', 'fz'],   force: 37 },
};

// ── renderDiagnosis — สรุปว่าอะไรผิดปกติ และผิดเพราะอะไร ──
//
// รวมหลักฐาน 3 ทาง: คำทำนายของโมเดล + ค่าเซนเซอร์ + ลายเซ็นการเบี่ยงรายข้อ
// กฎทั้งหมดมาจากตารางที่วัดจากข้อมูลจริง (เทียบกับค่าฐานของ run ปกติ):
//   ขึ้น/ลงพร้อมกันทุกข้อ  → ปัญหาความเร็ว ไม่ใช่ข้อใดข้อหนึ่งเสีย
//   J5 เบี่ยงเดี่ยว +43%   → น้ำหนักบรรทุก (ข้อมือรับโมเมนต์ของที่ถือโดยตรง)
//   J1 เบี่ยงเดี่ยว +15%   → แรงเสียดทานที่ฐาน
//   gripper_low            → เบี่ยงแค่ 0-7% แยกด้วยวิธีนี้ไม่ได้ ต้องพึ่งโมเดลอย่างเดียว
// p = payload ล่าสุด · temps = อุณหภูมิ 6 ข้อ — เรียกจาก renderHealthPanel 5 ครั้ง/วินาที
function renderDiagnosis(p, temps) {
    const box = document.getElementById('diag-panel');
    if (!box) return;
    box.classList.remove('hidden');

    // หัวแผง (ผลสรุป) และเนื้อแผง (เหตุผล + แท่งรายข้อ)
    const head = document.getElementById('diag-head');
    const body = document.getElementById('diag-body');

    // ตัวกรองยังเก็บข้อมูลไม่พอ 1 รอบการทำงาน — ยังสรุปไม่ได้
    // 1500 ข้อความ ÷ 125 Hz = 12 วินาที (ราว 1 รอบ pick-place)
    if (!hpEma.err || hpEma.n < 1500) {
        head.className = 'diag-head';
        head.textContent = 'กำลังเก็บข้อมูล…';
        // ความคืบหน้า % = n ÷ 15 (1500 ÷ 100)
        body.innerHTML = `<div class="diag-line">ต้องการ ~12 วินาที `
                       + `(${Math.min(100, Math.round(hpEma.n / 15))}%)</div>`;
        return;
    }

    // หุ่นหยุดนิ่ง (เช่นเล่นจบแล้ว) — ไม่วิเคราะห์ ค่าเฉลี่ยล่าสุดเก็บไว้ ขยับเมื่อไหร่วิเคราะห์ต่อ
    if (hpEma.stopped) {
        head.className = 'diag-head';
        head.textContent = '⏸ หุ่นหยุดนิ่ง';
        body.innerHTML = `<div class="diag-line">หุ่นไม่ขยับมาเกิน `
                       + `${PARAMS.diagnosis.stopped_after_sec} วินาที — พักการวิเคราะห์ ขยับเมื่อไหร่วิเคราะห์ต่อ</div>`;
        return;
    }

    // ความเร็วที่ตั้งไว้ — หุ่นส่งมาเองในช่อง target_speed_fraction (0.3 / 0.5 / 1.0)
    // เทียบค่าคลาดเคลื่อนกับค่าปกติ "ของความเร็วนั้น" กฎของหนัก/ฝืดจึงใช้ได้ทุกความเร็ว
    const D    = PARAMS.diagnosis;
    const frac = Number(p.target_speed_fraction);
    // แปลงเป็น % (0.5 → 50) · ไม่มีช่องนี้ → null
    const pct  = Number.isFinite(frac) && frac > 0 ? frac * 100 : null;
    // ค่าคลาดเคลื่อนปกติรายข้อของความเร็วนี้ (ไม่รู้ความเร็ว → ใช้ค่าฐานของ 50%)
    const base = pct != null ? baseErrFor(pct) : HP_BASE_ERR;
    // เบี่ยงกี่ % จากค่าปกติ ต่อข้อ: (ค่าเฉลี่ยที่วัดได้ ÷ ค่าปกติ − 1) × 100
    const devs = hpEma.err.map((v, i) => (v / base[i] - 1) * 100);
    const maxDev = Math.max(...devs), minDev = Math.min(...devs);
    // ข้อที่เบี่ยงมากสุด (0 = J1 … 5 = J6)
    const top = devs.indexOf(maxDev);
    const sorted = [...devs].sort((a, b) => b - a);
    const gap = sorted[0] - sorted[1];          // ข้อที่เบี่ยงสุดโดดกว่าอันดับสองเท่าไหร่
    // จัดรูปตัวเลข % มีเครื่องหมาย เช่น +12% / −5% (|| 0 กัน "-0%")
    const sg = v => { const r = Math.round(v) || 0; return (r > 0 ? '+' : '') + r + '%'; };
    const speedLine = pct == null ? null
        : `ความเร็วที่ตั้ง ${pct.toFixed(0)}% (ปกติ ${D.normal_speed_pct}%) — เทียบกับค่าปกติของความเร็วนี้`;

    // หลักฐานอื่น: แรงปลายแขน · ผลทายล่าสุดจาก AI · อุณหภูมิข้อที่ร้อนสุด
    const force = Number(p.tcp_force_scalar);
    const pred  = state.lastPrediction;
    const hot   = Math.max(...temps);

    // verdict = ผลสรุป · level = ok/warn/bad (สีหัวแผง) · why = รายการเหตุผล
    let verdict, level, why = [];

    // กฎความผิดปกติรายข้อมาก่อน — ใช้ค่าที่เทียบตามความเร็วแล้ว จึงไม่ถูกความเร็วกลบ
    // กฎ 1: J5 (index 4) เบี่ยงมากสุดเกินเกณฑ์ และโดดกว่าข้ออื่นชัด → ของหนักเกิน
    if (top === 4 && maxDev > RULES.payload_j5_above && gap > RULES.payload_gap) {
        verdict = 'น้ำหนักบรรทุกเกิน'; level = 'bad';
        why.push(`J5 เบี่ยง ${sg(maxDev)} โดดกว่าข้ออื่น ${gap.toFixed(0)}%`);
        why.push('J5 คือข้อมือที่รับโมเมนต์จากของที่ถือโดยตรง ยิ่งหนักยิ่งเบี่ยง');
        if (speedLine) why.push(speedLine);
    // กฎ 2: J1 (index 0) เบี่ยงมากสุดเกินเกณฑ์ และโดดกว่าข้ออื่น → ฝืดที่ฐาน
    } else if (top === 0 && maxDev > RULES.friction_j1_above && gap > RULES.friction_gap) {
        verdict = 'แรงเสียดทานที่ฐาน'; level = 'bad';
        why.push(`J1 เบี่ยง ${sg(maxDev)} โดดกว่าข้ออื่น ${gap.toFixed(0)}%`);
        why.push('J1 คือข้อหมุนฐาน เบี่ยงเดี่ยวแปลว่าฝืดที่ฐาน');
        if (speedLine) why.push(speedLine);
    // กฎ 3: ความเร็วที่ตั้งต่างจากปกติเกินค่าที่ยอมได้ → เร็ว/ช้ากว่าปกติ
    } else if (pct != null && Math.abs(pct - D.normal_speed_pct) > D.speed_tol_pct) {
        // หุ่นบอกความเร็วที่ตั้งมาเอง — ไม่ต้องเดาจากค่าคลาดเคลื่อน
        verdict = pct > D.normal_speed_pct ? 'เดินเร็วกว่าปกติ' : 'เดินช้ากว่าปกติ'; level = 'warn';
        why.push(`ตั้งความเร็วไว้ ${pct.toFixed(0)}% (ปกติ ${D.normal_speed_pct}%) — หุ่นรายงานเอง`);
        why.push(`เทียบกับค่าปกติของ ${pct.toFixed(0)}% ทุกข้อเบี่ยง ${sg(minDev)} ถึง ${sg(maxDev)}`
               + ' — ข้อต่อทำงานปกติ');
    // กฎ 4–5 (ใช้เมื่อไม่รู้ความเร็ว): ทุกข้อเบี่ยงขึ้น/ลงพร้อมกัน → ความเร็วรวมเปลี่ยน
    } else if (pct == null && minDev > RULES.fast_all_above) {
        // ข้อมูลไม่มีช่องความเร็ว — เดาจากรูปแบบการเบี่ยงแบบเดิม
        verdict = 'เดินเร็วกว่าปกติ'; level = 'warn';
        why.push(`ทุกข้อเบี่ยงขึ้นพร้อมกัน ${sg(minDev)} ถึง ${sg(maxDev)}`);
        why.push('ขึ้นยกแผงแบบนี้คือความเร็วรวม ไม่ใช่ข้อใดข้อหนึ่งเสีย');
    } else if (pct == null && maxDev < RULES.slow_all_below) {
        verdict = 'เดินช้ากว่าปกติ'; level = 'warn';
        why.push(`ทุกข้อเบี่ยงลงพร้อมกัน ${sg(maxDev)} ถึง ${sg(minDev)}`);
        why.push('ลงยกแผงแบบนี้คือความเร็วรวม ไม่ใช่ความเสียหาย');
    // กฎ 6: แรงปลายแขนเกินเกณฑ์ แต่ระบุข้อไม่ได้
    } else if (Number.isFinite(force) && force >= HP_BANDS.force.bad) {
        verdict = 'แรงสูงผิดปกติ'; level = 'bad';
        why.push('แต่รูปแบบการเบี่ยงรายข้อไม่ชัดพอจะระบุตำแหน่ง');
    // ไม่เข้ากฎใดเลย → ปกติ
    } else {
        verdict = 'ทำงานปกติ'; level = 'ok';
        why.push(`ทุกข้อเบี่ยงอยู่ในช่วง ${sg(minDev)} ถึง ${sg(maxDev)}`);
        if (speedLine) why.push(speedLine);
    }

    // แรงเกินเกณฑ์ → บอกว่ากี่เท่าของเกณฑ์
    if (Number.isFinite(force)) {
        const ratio = force / HP_BANDS.force.bad;
        if (force >= HP_BANDS.force.bad) {
            why.push(`แรงที่ปลายแขน ${force.toFixed(2)} N = ${ratio.toFixed(1)} เท่าของเกณฑ์ `
                   + `(ปกติ ≤ ${HP_BANDS.force.bad})`);
        }
    }

    // อุณหภูมิ: เกินเพดานที่เคยวัดได้ในข้อมูลจริงไหม
    if (hot >= HP_BANDS.temp.warn) {
        why.push(`อุณหภูมิ ${hot.toFixed(1)}°C เกินเพดานที่เคยวัดได้ (45.8°C)`);
    } else {
        why.push(`อุณหภูมิ ${hot.toFixed(1)}°C อยู่ในช่วงสมดุลปกติ ไม่มีสัญญาณเสื่อม`);
    }

    // โมเดลกับหลักฐานขัดกันหรือไม่ — จุดนี้สำคัญ บอกว่าเมื่อไหร่ไม่ควรเชื่อโมเดล
    if (pred && pred.prediction) {
        // ผลสรุปจากกฎ ตรงกับคลาสที่ AI ทายไหม
        const agree = (verdict === 'น้ำหนักบรรทุกเกิน'   && pred.prediction.startsWith('payload'))
                   || (verdict === 'แรงเสียดทานที่ฐาน'   && pred.prediction.startsWith('friction'))
                   || (verdict === 'เดินเร็วกว่าปกติ'     && pred.prediction === 'speed_100')
                   || (verdict === 'เดินช้ากว่าปกติ'      && pred.prediction === 'speed_30')
                   || (verdict === 'ทำงานปกติ'           && pred.prediction === 'normal');
        const conf = Number(pred.confidence);
        why.push(agree
            ? `โมเดลเห็นตรงกัน: ${pred.prediction} (${conf.toFixed(2)})`
            : `⚠ โมเดลบอก ${pred.prediction} (${conf.toFixed(2)}) ไม่ตรงกับหลักฐาน — ควรตรวจซ้ำ`);
        if (Number.isFinite(conf) && conf < 0.5) {
            why.push('โมเดลมั่นใจต่ำกว่า 0.5 เชื่อตัวเลขเซนเซอร์มากกว่า');
        }

        // ── โมเดลดูจากช่องไหน + ช่องนั้นยังใช้ได้อยู่หรือเปล่า ──
        const rel = MODEL_RELIANCE[pred.prediction];
        if (rel) {
            why.push(`โมเดลดูจาก: ${rel.top.join(' · ')}  (กลุ่มแรง ${rel.force}%)`);
            // URSim คืนแรงเป็นศูนย์ตลอด — ถ้าเจอแบบนั้นแปลว่าโมเดลตัดสินโดยขาดฐานหลัก
            const f = Array.isArray(p.actual_tcp_force) ? p.actual_tcp_force.map(Number) : null;
            // ทุกค่าเป็นศูนย์ (เล็กกว่า 1e-9)
            const dead = f && f.every(x => Number.isFinite(x) && Math.abs(x) < 1e-9);
            if (dead && rel.force >= 30) {
                why.push(`⚠ ช่องแรงเป็นศูนย์ทั้งหมด — โมเดลขาดฐานตัดสิน ${rel.force}% `
                       + 'อย่าเชื่อผลนี้ (เกิดกับข้อมูลจาก URSim)');
            }
        }
    }

    // หัวแผง: สีตาม level + ✓ / ⚠
    head.className = 'diag-head diag-' + level;
    head.textContent = (level === 'ok' ? '✓ ' : '⚠ ') + verdict;

    // esc = แปลง < > & เป็นรหัส HTML กันข้อความไปเป็นแท็ก
    const esc = s => String(s).replace(/[<>&]/g,
        c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    // เนื้อแผง: เหตุผลทีละบรรทัด + แท่ง 6 ข้อ (ยาว = % ที่เบี่ยง สูงสุด 100 · สีตามระดับ >10% เหลือง >20% แดง)
    body.innerHTML = why.map(w => `<div class="diag-line">${esc(w)}</div>`).join('')
        + '<div class="diag-bars">' + devs.map((d, i) => {
            const w = Math.min(100, Math.abs(d));
            const c = d > 20 ? 'db-bad' : d > 10 ? 'db-warn' : 'db-ok';
            return `<div class="diag-bar"><span>J${i + 1}</span>`
                 + `<i class="${c}" style="width:${w}%"></i>`
                 + `<em>${d > 0 ? '+' : ''}${d.toFixed(0)}%</em></div>`;
        }).join('') + '</div>';
}

// ── renderHealthPanel — สถานะกายภาพสด อ่านจาก payload ตรงๆ ไม่ต้องพึ่ง Python ──
// เกณฑ์ทุกตัวมาจาก percentile ของ run ที่ติดป้าย normal ในข้อมูลหุ่นจริง 2.45 ล้านแถว
//   แรง TCP     p50 0.73  p95 1.69  p99 2.19
//   กระแสหุ่น    p50 0.77  p95 0.89  p99 0.94
//   คลาดเคลื่อน  p50 184   p95 401   p99 495   µrad
//   อุณหภูมิ     สูงสุดที่เคยวัดได้ 45.75 ตลอด 8 วันทำงาน จึงเตือนที่ 46
const HP_BANDS = PARAMS.diagnosis.bands;          // params.json → diagnosis.bands
// เกณฑ์วินิจฉัย (+25% ทุกข้อ = เร็ว ฯลฯ) — params.json → diagnosis.rules
const RULES = PARAMS.diagnosis.rules;
// เวลาที่วาดแผงครั้งล่าสุด (ใช้หรี่การวาด)
let hpLast = 0;

// ── ค่าฐานรายข้อจาก run ที่ติดป้าย normal (ค่าเฉลี่ยทั้ง run) ──
// คลาดเคลื่อนตำแหน่ง หน่วย µrad — ใช้เทียบว่าข้อไหนเบี่ยงผิดปกติ
const HP_BASE_ERR = PARAMS.diagnosis.base_err_urad;
// ตัวกรอง EMA: รอบ pick-place ยาว ~11 วิ ต้องเฉลี่ยข้ามรอบไม่งั้นแท่งกระพริบตามจังหวะแขน
// alpha ไม่ได้เก็บไว้ คำนวณ = 1 ÷ (ema_sec × hz) → 1 ÷ (11.4 × 125) ≈ 0.0007
// แก้ hz หรือ ema_sec ใน params.json แล้ว alpha เปลี่ยนตามเอง
const HP_ALPHA = 1 / (PARAMS.diagnosis.ema_sec * PARAMS.sampling.hz);
// สถานะตัวกรอง: err = ค่าเฉลี่ยคลาดเคลื่อน 6 ข้อ · n = นับข้อความ · lastMove = เวลาที่ขยับล่าสุด · stopped = หยุดนิ่งอยู่ไหม
const hpEma = { err: null, n: 0, lastMove: 0, stopped: false };

// ── baseErrFor — ค่าคลาดเคลื่อนปกติของความเร็วที่ตั้ง ──
// วัดจริงที่ 30 / 50 / 100% (params.json → diagnosis.base_err_by_speed) ค่าระหว่างกลางลากเส้นตรง
// แปลง { "30": [...], "50": [...], "100": [...], "_": "คำอธิบาย" } → [[30,[...]], [50,[...]], [100,[...]]]
const BASE_BY_SPEED = Object.entries(PARAMS.diagnosis.base_err_by_speed)
    .filter(([k]) => k !== '_')
    .map(([k, v]) => [Number(k), v])
    .sort((a, b) => a[0] - b[0]);
// ตัวอย่าง: 40% → อยู่ระหว่าง 30% กับ 50% ห่างจาก 30% ครึ่งทาง → ค่ากลางระหว่างสองชุด
function baseErrFor(pct) {
    const S = BASE_BY_SPEED;
    // ต่ำกว่า/สูงกว่าช่วงที่วัด → ใช้ชุดที่ปลาย
    if (pct <= S[0][0]) return S[0][1];
    if (pct >= S[S.length - 1][0]) return S[S.length - 1][1];
    // หาคู่ที่คร่อม pct แล้วผสมตามสัดส่วนระยะ w
    const i = S.findIndex(([p]) => p >= pct);
    const [p0, a] = S[i - 1], [p1, b] = S[i];
    const w = (pct - p0) / (p1 - p0);
    return a.map((x, j) => x + (b[j] - x) * w);
}

// ── renderHealthPanel — เรียกทุกข้อความ telemetry ──
// 1) เช็คว่าหุ่นขยับอยู่ไหม  2) อัปเดตค่าเฉลี่ยคลาดเคลื่อนรายข้อ (EMA)
// 3) วาดแผงสถานะ 5 ครั้ง/วิ  4) ส่งต่อให้ renderDiagnosis สรุปสาเหตุ
function renderHealthPanel(p) {
    // ไม่ใช่ข้อมูลหุ่น (ไม่มีอุณหภูมิ) → ข้าม
    if (!p || typeof p !== 'object' || !Array.isArray(p.joint_temperatures)) return;

    // ── หุ่นขยับอยู่ไหม — ข้อไหนหมุนเร็วกว่า moving_deg_s ถือว่าขยับ ──
    // หยุดนิ่งเกิน stopped_after_sec (เช่นเล่นจบ) พักตัวกรองไว้
    // ไม่งั้นค่าคลาดเคลื่อนตอนหยุดเกือบเป็นศูนย์ ค่าเฉลี่ยจะตกจนดูเหมือน "เดินช้า"
    // payload ไม่มี actual_qd ให้ถือว่าขยับตลอด (ทำงานแบบเดิม)
    // ความเร็วข้อต่อ rad/s → องศา/วินาที
    const qdDeg = Array.isArray(p.actual_qd) ? p.actual_qd.map(v => Math.abs(Number(v)) * 180 / Math.PI) : null;
    if (!qdDeg || qdDeg.some(v => v > PARAMS.diagnosis.moving_deg_s)) hpEma.lastMove = performance.now();
    hpEma.stopped = performance.now() - hpEma.lastMove > PARAMS.diagnosis.stopped_after_sec * 1000;

    // ── อัปเดตตัวกรองทุกข้อความ (125 Hz) แม้จะยังไม่ถึงรอบวาดจอ ──
    if (!hpEma.stopped && Array.isArray(p.actual_q) && Array.isArray(p.target_q)) {
        // คลาดเคลื่อนรายข้อ = |มุมจริง − มุมเป้าหมาย| × 1,000,000 (rad → µrad)
        const e = p.actual_q.map((v, i) => Math.abs(Number(v) - Number(p.target_q[i])) * 1e6);
        if (e.every(Number.isFinite)) {
            // EMA: ค่าใหม่ = ค่าเดิม + alpha × (ค่าที่วัดได้ − ค่าเดิม)  (ครั้งแรกใช้ค่าที่วัดได้เลย)
            hpEma.err = hpEma.err === null
                ? e
                : hpEma.err.map((prev, i) => prev + HP_ALPHA * (e[i] - prev));
            hpEma.n++;
        }
    }

    // ข้อมูลเข้ามา 125 ครั้ง/วินาที — วาด DOM ทุกครั้งเบราว์เซอร์ไม่ไหว เอาแค่ 5 ครั้ง/วินาที
    const now = performance.now();
    if (now - hpLast < 200) return;
    hpLast = now;

    const box = document.getElementById('health-panel');
    if (!box) return;
    box.classList.remove('hidden');

    // ── ค่าที่แสดงบนแผง (ค่าขณะนั้น ไม่ใช่ค่าเฉลี่ย) ──
    // คลาดเคลื่อนตำแหน่ง = ข้อที่หลุดจากเป้าหมายมากสุด แปลงเป็น µrad
    let err = null;
    if (Array.isArray(p.actual_q) && Array.isArray(p.target_q)) {
        err = Math.max(...p.actual_q.map((v, i) =>
                  Math.abs(Number(v) - Number(p.target_q[i])))) * 1e6;
    }

    // เก็บอุณหภูมิ/กระแสล่าสุดไว้ให้ FORECAST ใช้เป็นจุดเริ่มต้นของสมการ
    const temps = p.joint_temperatures.map(Number);
        state.lastTemps = temps;
    if (Array.isArray(p.actual_current)) {
        const c = p.actual_current.map(Number);
        if (c.every(Number.isFinite)) {
            // กระแสรวม = √(ผลรวมกำลังสองของกระแส 6 ข้อ)
            const i = Math.sqrt(c.reduce((s, v) => s + v * v, 0));
            state.lastIRms = i;
            // สะสมไว้หาค่าเฉลี่ยทั้งรอบ ค่าอ้างอิง 1.74 A เป็นค่าเฉลี่ย ต้องเทียบกับค่าเฉลี่ย
            // onReplayStatus ล้างตัวสะสมทุกครั้งที่เริ่มรอบใหม่
            if (state.iAcc) { state.iAcc.sum += i; state.iAcc.n++; }
        }
    }
    // 1 แถวบนแผง: สีเขียว/เหลือง/แดง ตามเกณฑ์ warn/bad ใน params.json → diagnosis.bands
    const row = (name, raw, unit, band, digits) => {
        const v = Number(raw);
        // ไม่มีค่า → ไม่แสดงแถวนี้
        if (!Number.isFinite(v)) return '';
        const cls = v >= band.bad ? 'hp-bad' : v >= band.warn ? 'hp-warn' : 'hp-ok';
        return `<div class="hp-row ${cls}"><b>${name}</b>`
             + `<u>${v.toFixed(digits)}</u><s>${unit}</s></div>`;
    };

    // 4 แถว: แรงปลายแขน · กระแสรวม · คลาดเคลื่อน · ข้อที่ร้อนสุด
    document.getElementById('hp-rows').innerHTML =
          row('แรงที่ปลายแขน', p.tcp_force_scalar,     'N',    HP_BANDS.force,   2)
        + row('กระแสรวม',      p.actual_robot_current, 'A',    HP_BANDS.current, 3)
        + row('คลาดเคลื่อน',   err,                    'µrad', HP_BANDS.err,     0)
        + row('ข้อที่ร้อนสุด',  Math.max(...temps),     '°C',   HP_BANDS.temp,    1);

    // อุณหภูมิทุกข้อ J1–J6
    document.getElementById('hp-temps').innerHTML = temps.map((t, i) =>
        Number.isFinite(t) ? `<div>J${i + 1}<em>${t.toFixed(1)}</em></div>` : '').join('');

    // ต่อด้วยแผงวินิจฉัย
    renderDiagnosis(p, temps);
}
// ============================================================
// ALERTS — เตือนมุม · ความเร็ว · อุณหภูมิ + ค่าที่หาได้ระหว่างทำงาน
//
// มุม/ความเร็ว: เทียบสเปก UR3 และช่วงที่งานนี้ใช้ปกติ       (params.json → joint_limits)
// อุณหภูมิ:     เทียบเกณฑ์ UR · เพดานตามสมการ · อัตราขึ้นที่สมการคาด (params.json → temp_alerts)
// ค่าที่หาได้:  ช่วงมุมที่ใช้ · เร็วสุด · เวลาที่จะถึงเส้นเตือน
// ============================================================
// ชื่อย่อของหมวดค่าตั้ง + ตัวคูณ rad → องศา
const JL  = PARAMS.joint_limits;
const TA  = PARAMS.temp_alerts;
const DEG = 180 / Math.PI;

// สถิติสะสมตั้งแต่เริ่มรอบ — ล้างใหม่ทุกครั้งที่ replay เริ่ม (onReplayStatus)
// last = เวลาที่วาดแผงครั้งล่าสุด
const al = { last: 0 };
// ── resetAlertStats — ล้างสถิติสะสม (ช่วงมุม · เร็วสุด · ประวัติอุณหภูมิ) ──
function resetAlertStats() {
    Object.assign(al, {
        min: null, max: null,        // ช่วงมุมที่เห็น (องศา)
        peak: [0, 0, 0, 0, 0, 0],    // เร็วสุดที่เห็น (องศา/วิ)
        tHist: [],                   // [เวลา(วิ), อุณหภูมิ 6 ข้อ] เก็บวินาทีละจุด ไว้หาอัตราขึ้น
    });
}
// ตั้งค่าเริ่มต้นตอนโหลดหน้า
resetAlertStats();

// อุณหภูมิห้องจากช่องกรอก — อ่านเฉยๆ ไม่เขียนกลับ (fcNum เขียนกลับ จะทับตอนผู้ใช้กำลังพิมพ์)
function readAmbient() {
    const v = parseFloat(document.getElementById('fc-amb')?.value);
    return Number.isFinite(v) ? v : FORECAST_CAL.ambientRef;
}

// ── updateAlerts — เรียกทุกข้อความ telemetry (125 Hz) วาดจอ 5 ครั้ง/วิ ──
function updateAlerts(p) {
    // ต้องมีมุมข้อต่อ 6 ข้อที่เป็นตัวเลข
    if (!p || !Array.isArray(p.actual_q)) return;
    const q = p.actual_q.map(Number);
    if (!q.every(Number.isFinite)) return;
    // โหมดเร่งเวลา: เฟรมข้ามมาหลายแถว อัตราขึ้นของอุณหภูมิคำนวณไม่ได้
    const ff = Number(p.ff) > 1;

    // มุม rad → องศา แล้วขยายช่วงต่ำสุด/สูงสุดที่เคยเห็น
    const deg = q.map(v => v * DEG);
    al.min = al.min ? al.min.map((m, i) => Math.min(m, deg[i])) : deg.slice();
    al.max = al.max ? al.max.map((m, i) => Math.max(m, deg[i])) : deg.slice();

    // ความเร็วเป็นค่าที่หุ่นวัดเอง ใช้ได้แม้ตอนเร่งเวลา
    // rad/s → องศา/วินาที (ค่าสัมบูรณ์) แล้วจำค่าสูงสุดรายข้อ
    const qd = Array.isArray(p.actual_qd) ? p.actual_qd.map(v => Math.abs(Number(v)) * DEG) : null;
    qd?.forEach((v, i) => { if (Number.isFinite(v) && v > al.peak[i]) al.peak[i] = v; });

    // เก็บประวัติอุณหภูมิวินาทีละจุด ย้อนหลัง rate_window_sec วินาที ไว้หาอัตราขึ้น
    const temps = Array.isArray(p.joint_temperatures) ? p.joint_temperatures.map(Number) : null;
    // ใช้เวลาจากข้อมูล (timestamp) ถ้ามี — replay เล่นเร็วก็ยังได้อัตราตามเวลาจริงของข้อมูล
    const t = Number.isFinite(Number(p.timestamp)) ? Number(p.timestamp) : Date.now() / 1000;
    if (temps && !ff) {
        const lastT = al.tHist.length ? al.tHist[al.tHist.length - 1][0] : -Infinity;
        if (t < lastT) al.tHist = [];                  // เวลาย้อน = replay เปลี่ยน run
        if (t - lastT >= 1) al.tHist.push([t, temps]);
        // ตัดจุดที่เก่ากว่าหน้าต่างทิ้ง
        while (al.tHist.length && t - al.tHist[0][0] > TA.rate_window_sec) al.tHist.shift();
    }

    // วาดแผงไม่เกิน 5 ครั้ง/วินาที
    const now = performance.now();
    if (now - al.last < 200) return;
    al.last = now;
    renderAlerts(deg, qd, temps, ff);
}

// ── renderAlerts — ไล่เช็คทุกเกณฑ์ เก็บคำเตือนเป็นรายการ { lv, msg } แล้ววาดแผง ──
// lv: 'bad' = เกินสเปก/เกณฑ์ UR (แดง) · 'warn' = ใกล้เกิน หรือผิดจากที่สมการคาด (เหลือง)
function renderAlerts(deg, qd, temps, ff) {
    const box = document.getElementById('alert-panel');
    if (!box) return;
    box.classList.remove('hidden');
    const out = [];                                    // { lv: 'warn' | 'bad', msg }

    // ── มุม: ขีดจำกัดกลไก (สเปก UR3) และช่วงที่งานนี้ใช้ปกติ ──
    deg.forEach((d, i) => {
        // mech = ขีดจำกัดของข้อนี้ (±360° สำหรับ J1–J5 · J6 ไม่จำกัด = null)
        const J = `J${i + 1}`, mech = JL.mech_deg[i];
        if (mech != null) {
            // ระยะที่เหลือก่อนชนขีดจำกัด
            const left = mech - Math.abs(d);
            if (left < 0)
                out.push({ lv: 'bad', msg: `${J} ${d.toFixed(0)}° เกินขีดจำกัดกลไก ±${mech}°` });
            else if (left < JL.mech_margin_deg)
                out.push({ lv: 'warn', msg: `${J} ใกล้ขีดจำกัดกลไก เหลือ ${left.toFixed(0)}°` });
        }
        // ช่วงที่งานนี้ใช้ปกติ (ตั้งไว้ใน params.json — ไม่ตั้ง = ไม่เช็ค)
        const lo = JL.work_min_deg?.[i], hi = JL.work_max_deg?.[i];
        if (lo != null && hi != null
            && (d < lo - JL.work_margin_deg || d > hi + JL.work_margin_deg))
            out.push({ lv: 'warn', msg: `${J} ${d.toFixed(0)}° นอกช่วงที่งานนี้ใช้ปกติ (${lo}° ถึง ${hi}°)` });
    });

    // ── ความเร็ว: สเปก UR3 ──
    // J1–J3 สูงสุด 180°/วิ · J4–J6 สูงสุด 360°/วิ · เกิน speed_warn_frac ของสเปก = ใกล้เกิน
    qd?.forEach((v, i) => {
        const max = JL.speed_max_deg_s[i];
        if (!Number.isFinite(v)) return;
        if (v > max)
            out.push({ lv: 'bad', msg: `J${i + 1} เร็ว ${v.toFixed(0)}°/วิ เกินสเปก ${max}°/วิ` });
        else if (v > max * JL.speed_warn_frac)
            out.push({ lv: 'warn', msg: `J${i + 1} เร็ว ${v.toFixed(0)}°/วิ ใกล้สเปก ${max}°/วิ` });
    });

    // ── อุณหภูมิ ──
    // W = เส้นเตือน 50 °C · S = เส้นตัดการทำงาน 85 °C · amb = อุณหภูมิห้อง
    const W = UR_LIMITS.temp_warn_c, S = UR_LIMITS.temp_shutdown_c, amb = readAmbient();
    // eta = ข้อที่จะถึงเส้นเตือนเร็วที่สุด และอีกกี่นาที
    let eta = null;
    if (temps) {
        temps.forEach((T, i) => {
            if (!Number.isFinite(T)) return;
            const J = `J${i + 1}`;
            // เพดานและค่าคงที่เวลาของข้อนี้
            const tInf = amb + FORECAST_CAL.riseC[i], tau = FORECAST_CAL.tauMin[i];
            if (T >= S)      out.push({ lv: 'bad', msg: `${J} ${T.toFixed(1)}°C ถึงเกณฑ์ตัดการทำงานของ UR (${S}°C)` });
            else if (T >= W) out.push({ lv: 'bad', msg: `${J} ${T.toFixed(1)}°C เกินเกณฑ์เตือนของ UR (${W}°C)` });
            // ภาระปกติร้อนได้ไม่เกินเพดาน ถ้าเกินแปลว่ามีอะไรทำให้ร้อนผิดปกติ
            if (T > tInf + TA.ceiling_margin_c)
                out.push({ lv: 'warn', msg: `${J} ${T.toFixed(1)}°C เกินเพดานที่ควรเป็น ${tInf.toFixed(1)}°C` });
            // เวลาที่จะถึงเส้นเตือนถ้าทำงานแบบนี้ต่อ: แก้สมการ T(t) = W หา t
            // (คิดเฉพาะเมื่อยังไม่ถึง W และเพดานสูงกว่า W — ไม่งั้นไม่มีวันถึง)
            if (T < W && tInf > W) {
                // T(t) = เพดาน − (เพดาน − ตอนนี้)·e^(−t/τ)  →  t = −τ·ln((เพดาน − W) ÷ (เพดาน − ตอนนี้))
                const m = -tau * Math.log((tInf - W) / (tInf - T));
                if (!eta || m < eta.min) eta = { joint: i + 1, min: m };
            }
        });

        // อัตราขึ้นจริงย้อนหลัง เทียบกับอัตราที่สมการคาด (เพดาน − ตอนนี้) ÷ τ
        if (!ff && al.tHist.length >= 2) {
            // จุดแรกกับจุดสุดท้ายในหน้าต่าง
            const [t0, A] = al.tHist[0], [t1, B] = al.tHist[al.tHist.length - 1];
            const dtMin = (t1 - t0) / 60;
            // ข้อมูลต้องยาวอย่างน้อย 80% ของหน้าต่าง ถึงจะเชื่อได้
            if (dtMin >= TA.rate_window_sec / 60 * 0.8) {
                B.forEach((T, i) => {
                    // อัตราจริง (°C/นาที) เทียบกับอัตราที่สมการคาด
                    const rate = (T - A[i]) / dtMin;
                    const tInf = amb + FORECAST_CAL.riseC[i];
                    const expect = Math.max(0, (tInf - T) / FORECAST_CAL.tauMin[i]);
                    if (rate > expect + TA.rate_margin_c_per_min)
                        out.push({ lv: 'warn', msg: `J${i + 1} ร้อนขึ้น ${rate.toFixed(2)}°C/นาที `
                                                  + `เร็วกว่าที่ควร ${expect.toFixed(2)}°C/นาที` });
                });
            }
        }
    }

    // ── วาด ──
    // ระดับรวม: มี bad ตัวเดียวก็แดง · มีแค่ warn = เหลือง · ไม่มีเลย = ปกติ
    const lv = out.some(a => a.lv === 'bad') ? 'bad' : out.length ? 'warn' : 'ok';
    const head = document.getElementById('al-head');
    head.className = 'diag-head diag-' + lv;
    head.textContent = lv === 'ok' ? '✓ อยู่ในเกณฑ์ปกติ' : `⚠ ${out.length} คำเตือน`;

    // เกินเส้นเตือนไปแล้วไม่ต้องบอกเวลาที่จะถึง — มีบรรทัดเตือนสีแดงอยู่แล้ว
    const over = temps?.some(T => T >= W);
    const etaLine = !temps || over ? ''
        : eta ? `J${eta.joint} จะถึง ${W}°C ในอีก ~${fmtDur(eta.min)} ถ้าทำงานแบบนี้ต่อ`
              : `ไม่มีข้อไหนจะถึง ${W}°C — เพดานทุกข้อต่ำกว่า (ห้อง ${amb}°C)`;
    // รายการคำเตือน + บรรทัดเวลาที่จะถึงเส้นเตือน + หมายเหตุโหมดเร่ง
    document.getElementById('al-list').innerHTML =
          out.map(a => `<div class="al-line al-${a.lv}">${a.msg}</div>`).join('')
        + (etaLine ? `<div class="diag-line">${etaLine}</div>` : '')
        + (ff ? '<div class="diag-line">เร่งเวลาอยู่ — ไม่นับอัตราขึ้นของอุณหภูมิ</div>' : '');

    // ตารางค่าที่หาได้รายข้อ
    // คอลัมน์: ข้อ · มุมตอนนี้ · ช่วงมุมที่ใช้ (ต่ำสุด…สูงสุด) · ความเร็วสูงสุดที่เห็น
    document.getElementById('al-joints').innerHTML =
        '<div class="al-row al-th"><span></span><span>ตอนนี้</span><span>ช่วงที่ใช้</span>'
      + '<span>เร็วสุด</span></div>'
      + deg.map((d, i) => `<div class="al-row"><span>J${i + 1}</span>`
          + `<span>${d.toFixed(0)}°</span>`
          + `<span>${al.min[i].toFixed(0)}…${al.max[i].toFixed(0)}°</span>`
          + `<span>${al.peak[i].toFixed(0)}°/วิ</span></div>`).join('');
}

// ประวัติอุณหภูมิรายวันถอดออกจากหน้าเว็บไว้ก่อน (ข้อมูลตอนนี้เป็น replay ทั้งหมด ยังไม่ใช่สุขภาพหุ่นจริง)
// backend ยังสรุปลงตาราง daily_health ทุกชั่วโมง ดูได้ที่ GET /api/health/daily

// ── คลิกหัวแผง (FORECAST / ALERTS / DIAGNOSIS ...) เพื่อพับเก็บ ──
// จอเล็กแผงจะได้ไม่บังแขน 3D — คลิกอีกครั้งกางกลับ
// ผูกที่ document ทีเดียว (delegation) — แผงที่สร้าง/ซ่อนทีหลังก็ใช้ได้
document.addEventListener('click', (e) => {
    const label = e.target.closest('.panel-col .hp-label, .panel-col .ai-label');
    if (label) label.parentElement.classList.toggle('collapsed');
});

// ── renderAIPanel — แสดงผลทำนายสดจากโมเดล ──
// payload: { prediction, confidence, true_label, probs:{...} }
// true_label มีเฉพาะตอน replay ข้อมูลเพื่อน — ต่อหุ่นจริงจะไม่มี ช่องเฉลยจะว่างไว้
// ⚠ ตอนนี้ไม่มีที่เรียกฟังก์ชันนี้ — บรรทัดส่งต่อ ur/prediction ในตัวรับ MQTT (connectMQTT)
//   หายไปตั้งแต่ commit 70bc477 (ถูกแทนด้วยบรรทัด ur/replay_status)
//   ผล: แผง AI ไม่อัปเดต และ state.lastPrediction ไม่มีค่า DIAGNOSIS จึงไม่มีส่วน "โมเดลเห็นตรงกัน"
function renderAIPanel(p) {
    const box = document.getElementById('ai-panel');
    if (!box || !p || typeof p !== 'object') return;
    box.classList.remove('hidden');

    state.lastPrediction = p;   // เก็บไว้ให้ renderDiagnosis เอาไปรวมกับหลักฐานจากเซนเซอร์

    // แปลงอักขระพิเศษเป็นรหัส HTML (ชื่อคลาสมาจากภายนอก)
    const esc = s => String(s).replace(/[<>&"]/g,
        c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

    // คำทาย + ความมั่นใจ
    document.getElementById('ai-pred').textContent = p.prediction ?? '—';
    document.getElementById('ai-conf').textContent =
        Number.isFinite(p.confidence) ? p.confidence.toFixed(2) : '';

    // มีเฉลย → แสดงว่าทายถูก ✓ หรือผิด ✗
    const truth = document.getElementById('ai-truth');
    if (p.true_label) {
        const ok = p.prediction === p.true_label;
        truth.textContent = `เฉลย: ${p.true_label}  ${ok ? '✓' : '✗'}`;
        truth.className = 'ai-truth ' + (ok ? 'ok' : 'bad');
    } else {
        truth.textContent = '';
        truth.className = 'ai-truth';
    }

    // 4 คลาสที่ความน่าจะเป็นสูงสุด → แท่งความยาวตามค่า (0–1 → 0–100%)
    const top = Object.entries(p.probs || {})
                      .sort((a, b) => b[1] - a[1]).slice(0, 4);
    document.getElementById('ai-bars').innerHTML = top.map(([k, v]) =>
        `<div class="ai-bar"><span>${esc(k)}</span>`
      + `<i style="width:${(v * 100).toFixed(0)}%"></i>`
      + `<em>${v.toFixed(2)}</em></div>`).join('');
}

// ── renderPayloadInspector — แสดง payload สด ให้คลิกเลือก field ──
// อยู่ในหน้าต่างสร้าง/แก้ joint — คลิกแถวไหน ช่อง MQTT Topic / Path ถูกกรอกให้
function renderPayloadInspector() {
    const box = dom.payloadInspector;
    if (!box) return;

    // topic ทั้งหมดที่เคยได้รับ เรียงตามชื่อ
    const topics = Object.keys(state.lastPayloads).sort();
    if (topics.length === 0) {
        box.innerHTML = '<span class="form-hint">ยังไม่ได้รับข้อมูล — กด Connect โดยเปิด Discover ไว้ แล้วรอให้อุปกรณ์ส่งข้อมูลเข้ามา</span>';
        return;
    }

    box.innerHTML = '';
    for (const topic of topics) {
        const entry = state.lastPayloads[topic];

        // หัวกลุ่ม: ชื่อ topic + จำนวนข้อความที่ได้รับ
        const head = document.createElement('div');
        head.className = 'pi-topic';
        head.textContent = `${topic}  (${entry.count} msg)`;
        box.appendChild(head);

        // 1 แถวต่อ 1 ค่าใน payload (path + ค่าปัจจุบัน)
        for (const [path, value] of flattenPaths(entry.payload)) {
            const row = document.createElement('div');
            row.className = 'pi-row';
            row.title = 'คลิกเพื่อผูก joint นี้กับค่านี้';
            row.innerHTML =
                `<code>${escapeHtml(path || '(payload ทั้งก้อน)')}</code>` +
                `<span class="pi-val">${escapeHtml(String(value))}</span>`;

            // ไฮไลต์จากค่าที่อยู่ในช่องจริง ไม่ได้จำ state แยก
            // → วาดใหม่ทุก 800ms แล้วไฮไลต์ไม่หาย
            if (topic === dom.jointSrcTopic.value && path === dom.jointSrcPath.value) {
                row.classList.add('selected');
            }

            // คลิก → กรอก topic กับ path ลงฟอร์ม แล้ววาดใหม่ให้ไฮไลต์ย้ายตาม
            row.addEventListener('click', () => {
                dom.jointSrcTopic.value = topic;
                dom.jointSrcPath.value  = path;
                renderPayloadInspector();
            });
            box.appendChild(row);
        }
    }
}
// ── start/stopInspector — อัปเดตค่าสดเฉพาะตอน modal เปิดอยู่ ──
// ไม่ให้ timer วิ่งทิ้งไว้เปล่าๆ ตอนปิด modal
function startInspector() {
    renderPayloadInspector();
    // กัน timer ซ้อน แล้ววาดใหม่ทุก 0.8 วินาที
    clearInterval(state.inspectorTimer);
    state.inspectorTimer = setInterval(renderPayloadInspector, 800);
}
function stopInspector() {
    clearInterval(state.inspectorTimer);
    state.inspectorTimer = null;
}

// ── connectMQTT — เชื่อมต่อ broker ด้วย WebSocket (ws:// หรือ wss://) ──
// เบราว์เซอร์ต่อ TCP ตรงไม่ได้ → ใช้ port 9001 (WebSocket) ของ Mosquitto ใน docker
function connectMQTT() {
    // ค่าจากช่องกรอกในแผง MQTT
    const url  = dom.mqttUrl.value.trim();
    const user = dom.mqttUser.value.trim();
    const pass = dom.mqttPass.value.trim();

    if (!url) { alert('กรุณากรอก Broker URL\nเช่น wss://xxxx.s1.eu.hivemq.cloud:8884/mqtt'); return; }

    updateMQTTStatus('connecting');

    // สร้าง client ใหม่ทุกครั้งที่ connect
    // mqtt = ไลบรารี MQTT.js ที่โหลดจาก <script> ใน index.html
    state.mqttClient = mqtt.connect(url, {
        clientId:        `digital-twin-${Math.random().toString(16).slice(2)}`,   // สุ่ม กันชนกับแท็บอื่น
        username:        user || undefined,   // ถ้าว่างไม่ส่งไป
        password:        pass || undefined,
        clean:           true,                // ไม่เก็บข้อความค้างจากครั้งก่อน
        keepalive:       300,    // 5 นาที — เผื่อ Chrome หรี่ timer ตอนแท็บอยู่เบื้องหลัง
        reconnectPeriod: 3000,   // reconnect อัตโนมัติทุก 3 วินาทีถ้าหลุด
    });

    // ── เชื่อมต่อสำเร็จ ──
    state.mqttClient.on('connect', () => {
        state.mqttConnected = true;

        // subscribe ตาม srcTopic ของแต่ละ joint — ไม่มี topic ตายตัวในโค้ดอีกต่อไป
        // topic ที่ joint ผูกไว้ + "#" ถ้าเปิด Discover (ฟังทุก topic เพื่อสำรวจ)
        const bound  = jointTopics();

        // ur/prediction ไม่ได้ผูกกับ joint ไหน ต้อง subscribe เพิ่มเองเสมอ
        // ur/replay_status = สถานะจาก replay.py ให้แผง FORECAST
        const topics = dom.mqttDiscover?.checked
            ? [...new Set([...bound, '#'])]
            : [...new Set([...bound, 'ur/prediction', 'ur/replay_status'])];

        if (bound.length === 0) {
            console.warn('MQTT: ยังไม่มี joint ตัวไหนตั้ง MQTT Topic — 3D ยังไม่ขยับ แต่ Discover จะเก็บ payload ไว้ให้เลือกใน Add/Edit Joint');
        }
        if (topics.length === 0) {
            console.warn('MQTT: ไม่มี topic ให้ subscribe เลย');
        } else {
            state.mqttClient.subscribe(topics, (err, granted) => {
                if (err) { console.error('MQTT subscribe error:', err); return; }
                console.log('MQTT subscribed:', granted);
            });
        }

        // อัปเดตสถานะ เริ่มวัดคุณภาพสัญญาณ เปลี่ยนปุ่มเป็น Disconnect
        updateMQTTStatus('connected');
        startNetStats();
        dom.btnMqttConnect.innerHTML =
            '<span class="material-icons-round">link_off</span>Disconnect';
    });

    // ── รับ message จาก broker ── (หัวใจของ Digital Twin: ทุกข้อความจากหุ่นผ่านตรงนี้)
    // ไม่มีชื่อ topic หรือ field ของหุ่นรุ่นใดอยู่ในนี้เลย
    // ทุกอย่างมาจาก srcTopic / srcPath / scale / invert / offset ที่ตั้งไว้ในแต่ละ joint
    state.mqttClient.on('message', (topic, message) => {
        // message มาเป็น bytes → แปลงเป็นข้อความ
        const text = message.toString();

        // payload อาจเป็น JSON หรือตัวเลขเดี่ยว — รองรับทั้งสองแบบ
        let payload;
        try { payload = JSON.parse(text); }
        catch (e) { payload = parseFloat(text); }

        // ── สถานะจาก replay.py (เริ่ม/ความคืบหน้า/จบ) ไปที่แผง FORECAST — ไม่ใช่ค่า joint จบเลย ──
        // ⚠ ผลทายจาก AI (ur/prediction) ไม่มีบรรทัดส่งไป renderAIPanel แล้ว — ดูหมายเหตุที่ renderAIPanel
        if (topic === 'ur/replay_status') { onReplayStatus(payload); return; }

        // เก็บ payload ล่าสุดต่อ topic ไว้ให้ Payload Inspector
        const rec = state.lastPayloads[topic] || { count: 0 };
        rec.payload = payload;
        rec.count++;
        rec.ts = Date.now();
        state.lastPayloads[topic] = rec;

        // วิเคราะห์ทุกข้อความก่อนขยับโมเดล (แต่ละตัวหรี่การวาดจอเหลือ 5 ครั้ง/วิ เอง)
        //   applyTimelapse     โหมดเร่งเวลา: แทนอุณหภูมิช่วงเล่นซ้ำด้วยสมการความร้อน
        //   recordNetStats     วัด latency / Hz / ข้อความหาย
        //   renderHealthPanel  แผงสถานะ + DIAGNOSIS
        //   updateAlerts       แผง ALERTS (มุม · ความเร็ว · อุณหภูมิ)
        applyTimelapse(payload);
        recordNetStats(payload);
        renderHealthPanel(payload);
        updateAlerts(payload);

        // ── ส่งค่าเข้า joint: joint ไหนตั้ง srcTopic ตรงกับ topic นี้ ดึงค่าตาม srcPath ──
        let matched = 0;
        for (const joint of state.joints) {
            if (!topicMatches(joint.srcTopic, topic)) continue;

            // ดึงค่าดิบ เช่น payload.actual_q[0] (มุม J1 หน่วย rad)
            const raw = Number(resolvePath(payload, joint.srcPath));
            if (!Number.isFinite(raw)) continue;   // path ผิด หรือค่าไม่ใช่ตัวเลข

            // แปลงจากหน่วย/จุดศูนย์ของอุปกรณ์ → หน่วย/จุดศูนย์ของ node ในโมเดล
            // ค่าในโมเดล = ค่าดิบ × scale → กลับทิศถ้า invert → บวก offset
            let v = raw * (joint.scale ?? 1);
            if (joint.invert) v = -v;
            v += (joint.offset ?? 0);

                        joint._lastRaw = raw;   // เก็บค่าดิบไว้เสมอ แม้ตอน pause — Calibrate ต้องใช้
            matched++;

            if (state.mqttPaused) continue;   // pause = ไม่แตะโมเดล ผู้ใช้จะได้ลาก slider ได้

            // หมุนโมเดล 3D แล้วอัปเดต slider/ตัวเลขบนการ์ด
            applyJointValue(joint, v);
            syncJointUI(joint, joint.value);       // ใช้ joint.value เพราะโดน clamp มาแล้ว
        }

        // ไม่มี joint ไหนรับค่าจาก topic นี้ → เตือนใน console ครั้งเดียว
        if (matched === 0 && !warnedTopics.has(topic)) {
            warnedTopics.add(topic);
            console.warn(`MQTT: ได้ข้อความจาก "${topic}" แต่ไม่มี joint ตัวไหนรับค่า`, payload);
        }
    });


    // ── เกิด error ──
    state.mqttClient.on('error', (err) => {
        console.error('MQTT error:', err);
        updateMQTTStatus('error');
    });

    // ── หลุดการเชื่อมต่อ ── (mqtt.js จะลองต่อใหม่เองทุก 3 วินาที)
    state.mqttClient.on('close', () => {
        state.mqttConnected = false;
        updateMQTTStatus('disconnected');
        dom.btnMqttConnect.innerHTML =
            '<span class="material-icons-round">link</span>Connect';
    });
}

// ── disconnectMQTT — ตัดการเชื่อมต่อ broker ──
function disconnectMQTT() {
    if (state.mqttClient) {
        state.mqttClient.end();   // ปิด WebSocket cleanly
        state.mqttClient    = null;
        state.mqttConnected = false;
        stopNetStats();
        updateMQTTStatus('disconnected');
        dom.btnMqttConnect.innerHTML =
            '<span class="material-icons-round">link</span>Connect';
    }
}

// ── updateMQTTStatus — อัปเดต badge สีและข้อความสถานะ ──
function updateMQTTStatus(status) {
    // สถานะ → ข้อความ + สีจุด
    const map = {
        connecting:   { text: 'Connecting...', color: '#f59e0b' },   // เหลือง
        connected:    { text: 'Connected',     color: '#22c55e' },   // เขียว
        disconnected: { text: 'Disconnected',  color: '#6b7280' },   // เทา
        error:        { text: 'Error',         color: '#ef4444' },   // แดง
    };
    const s = map[status] || map.disconnected;
    if (dom.mqttStatus) {
        dom.mqttStatus.innerHTML =
            `<span class="sim-dot" style="background:${s.color}"></span>${s.text}`;
    }
}

// ============================================================
// Helpers — utility functions เล็กๆ
// ============================================================

// ── escapeHtml — ป้องกัน XSS เมื่อนำ string ไปใส่ innerHTML ──
// แปลง < > & " เป็น HTML entities ผ่าน textContent ของ div ชั่วคราว
function escapeHtml(str) {
    const div = document.createElement('div');
    // textContent เก็บเป็นข้อความล้วน → innerHTML คืนแบบที่แปลงอักขระพิเศษแล้ว
    div.textContent = str;
    return div.innerHTML;
}

// ── truncate — ตัด string ให้สั้นลงถ้ายาวเกิน len แล้วใส่ … ต่อท้าย ──
function truncate(str, len) {
    return str.length > len ? str.substring(0, len) + '…' : str;
}

// ============================================================
// autoSetupJoints — ตั้ง joint + offset ให้เองทันทีที่โหลดโมเดล UR3
//
// ตอบคำถามอาจารย์ข้อ 1: set offset ไว้ให้แต่แรกได้
// ค่ามาจาก ur3_default.dtwp ในโฟลเดอร์โปรเจกต์ (offset ที่หาจากข้อมูลหุ่นจริงแล้ว)
// ผู้ใช้โหลด .glb อย่างเดียว ไม่ต้องกด Open Project ไม่ต้องพิมพ์เลขเอง
// อยากได้ค่าใหม่: รัน analysis/fit_joint_mapping.py --write แล้วเอาไฟล์มาแทน
// ถูกเรียกหลังโหลดโมเดลทุกครั้ง (Upload / เพิ่มโมเดล / ลากไฟล์วาง) — ent = โมเดลที่เพิ่งเข้าฉาก
// ============================================================
const UR3_DEFAULT_PROJECT = './ur3_default.dtwp';

async function autoSetupJoints(ent) {
    // ทำเฉพาะโมเดล UR3 — ดูจากชื่อกระดูกที่ ur3.glb มี
    // โมเดลอื่นปล่อยว่างไว้ให้ผู้ใช้ตั้ง joint เองเหมือนเดิม
    ent = ent || state.entities[0];
    if (!ent) return;
    // รวบชื่อ node ทั้งหมดของโมเดลนี้
    const names = new Set();
    ent.root.traverse(n => names.add(n.name));
    if (!names.has('ShoulderBone') || !names.has('ToolBone')) return;
    if (state.joints.some(j => j.entity === ent.id)) return;   // โมเดลนี้มี joint แล้ว

    try {
        // no-store: แก้ไฟล์ .dtwp แล้วเห็นผลทันที ไม่ติด cache
        const r = await fetch(UR3_DEFAULT_PROJECT, { cache: 'no-store' });
        if (!r.ok) throw new Error(`ไม่พบ ${UR3_DEFAULT_PROJECT} (${r.status})`);
        // append = เพิ่มต่อจาก joint ที่มี (ไม่ลบของหุ่นตัวอื่น) · entity = ผูกกับโมเดลนี้
        const { total, ok, failed } = applyProjectData(await r.json(), { append: true, entity: ent.id });
        console.log(`[auto] ตั้ง joint UR3 (${ent.name}) จาก ${UR3_DEFAULT_PROJECT} แล้ว ${ok}/${total} ข้อ`);
        if (failed) alert(`ตั้ง joint อัตโนมัติได้ ${ok}/${total} ข้อ (ล้มเหลว ${failed})`);
    } catch (e) {
        // ไม่มีไฟล์ก็ไม่เป็นไร ผู้ใช้ยังตั้งเองหรือกด Open Project ได้
        console.warn('[auto] ตั้ง joint อัตโนมัติไม่สำเร็จ:', e.message);
    }
}


// ============================================================
// Event Bindings — ผูก event listener ทั้งหมดครั้งเดียวตอน init
// แยกออกมาจาก init เพื่อความอ่านง่าย
// ============================================================
function bindEvents() {
    // ── ซ่อน/แสดง Node Tree (หุบไปทางซ้าย) — จำค่าไว้ในเบราว์เซอร์ ──
    const setLeftCollapsed = (on) => {
        dom.panelLeft.classList.toggle('collapsed', on);
        dom.btnToggleLeft.title = on ? 'แสดง Node Tree' : 'ซ่อน Node Tree';
        // localStorage = ที่เก็บค่าในเบราว์เซอร์ (try กันเบราว์เซอร์ที่ปิดไว้)
        try { localStorage.setItem('dt.leftCollapsed', on ? '1' : '0'); } catch {}
    };
    // เปิดหน้าใหม่ → คืนสถานะที่จำไว้
    try { if (localStorage.getItem('dt.leftCollapsed') === '1') setLeftCollapsed(true); } catch {}
    dom.btnToggleLeft.addEventListener('click', (e) => {
        e.stopPropagation();                    // ไม่ให้ไปโดน click ของแผงข้างล่างซ้ำ
        setLeftCollapsed(!dom.panelLeft.classList.contains('collapsed'));
    });
    // หุบอยู่ คลิกตรงไหนของแถบก็กางออก
    dom.panelLeft.addEventListener('click', () => {
        if (dom.panelLeft.classList.contains('collapsed')) setLeftCollapsed(false);
    });
    // แผงกว้าง/แคบลง → viewport เปลี่ยนขนาด ต้องปรับ canvas ตาม ไม่งั้นภาพ 3D จะยืด
    dom.panelLeft.addEventListener('transitionend', (e) => {
        if (e.target === dom.panelLeft && e.propertyName === 'width') handleResize();
    });

    // ── Upload model button + file input ──
    // ปุ่มสวยกดแล้วไปคลิก <input type="file"> ที่ซ่อนอยู่แทน
    dom.btnUpload.addEventListener('click', () => dom.fileInput.click());
    dom.fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        // โหลดแทนทั้งฉาก แล้วตั้ง joint UR3 อัตโนมัติ
        if (file) loadModel(file, autoSetupJoints);
        e.target.value = '';   // reset ให้ select ไฟล์เดิมซ้ำได้
    });

    // ── เพิ่มโมเดลเข้าฉากเดิม (ไม่ลบของเก่า) ──
    dom.btnAddModel?.addEventListener('click', () => dom.addFileInput.click());
    dom.addFileInput?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) addModel(file, autoSetupJoints);
        e.target.value = '';
    });
    // ผูก event ของแผง SCENE
    bindSceneList();

    // ── Drag & Drop ไฟล์ GLB/GLTF ลง viewport ──
    // dragover ต้อง preventDefault ไม่งั้นเบราว์เซอร์ไม่ยอมให้วาง
    dom.viewportContainer.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    });
    dom.viewportContainer.addEventListener('drop', (e) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        // มีฉากอยู่แล้ว = เพิ่มเข้าฉาก · ยังไม่มี = เปิดเป็นฉากใหม่
        if (file && (file.name.endsWith('.glb') || file.name.endsWith('.gltf')))
            addModel(file, autoSetupJoints);
    });

    // ── Add Joint modal ──
    dom.btnAddJoint.addEventListener('click', openAddJointModal);
    dom.modalClose.addEventListener('click', closeModal);
    dom.modalCancel.addEventListener('click', closeModal);
    // ปุ่มยืนยัน — แยกทางตามโหมดที่ modal เปิดอยู่
    dom.modalConfirm.addEventListener('click', () => {
        if (state.editingJointId) saveJointEdit();
        else addJoint();
    });

    // ปิด modal ด้วย Escape หรือ click นอก modal
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
    dom.modalOverlay.addEventListener('click', (e) => { if (e.target === dom.modalOverlay) closeModal(); });

    // อัปเดต modal form เมื่อ property หรือ pattern เปลี่ยน
        dom.jointProperty.addEventListener('change', () => {
        // โหมดแก้ไข: ห้าม reset min/max ทับค่าที่ผู้ใช้ตั้งไว้
        if (!state.editingJointId) {
            updateMinMaxDefaults();
            // เปลี่ยน unit ตาม property ให้อัตโนมัติ — เฉพาะโหมดสร้างใหม่
            // โหมดแก้ไขไม่แตะ เพราะผู้ใช้อาจตั้งหน่วยแปลกๆ ไว้เอง
            if (dom.jointUnit) dom.jointUnit.value = defaultUnitFor(dom.jointProperty.value);
        }
        updatePivotVisibility();
    });
    dom.jointSimPattern.addEventListener('change', updateSimFreqVisibility);

    // ── แถบเครื่องมือจัดฉาก (ย้าย/หมุน/ย่อขยาย) ──
    initSceneTools();

    // ── Tab switching ── (data-tab ของปุ่ม = id ของเนื้อหาแท็บ)
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // ── Project export/import ──
    dom.btnExportProject.addEventListener('click', exportProject);
    dom.btnImportProject.addEventListener('click', () => dom.projectFileInput.click());
    dom.projectFileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) importProject(file);
        e.target.value = '';
    });

    // ── Preset ──
    dom.btnSavePreset.addEventListener('click', savePreset);

    // ── Animation ──
    dom.btnAddKeyframe.addEventListener('click', addKeyframe);
    dom.btnPlayAnim.addEventListener('click', toggleAnimationPlayback);
    dom.animLoopChk.addEventListener('change', (e) => { state.animLoop = e.target.checked; });

    // ── MQTT ──
    // ปุ่ม MQTT (header) → เปิด/ปิด panel กรอก credentials
    dom.btnMqttToggle.addEventListener('click', () => {
        dom.mqttPanel.classList.toggle('hidden');
    });

    // ปุ่ม Connect/Disconnect → สลับระหว่างเชื่อมต่อและตัดการเชื่อมต่อ
    dom.btnMqttConnect.addEventListener('click', () => {
        if (state.mqttConnected) disconnectMQTT();
        else connectMQTT();
    });

    // ปุ่ม Pause — หยุด apply ข้อมูลชั่วคราวเพื่อ Calibrate
    if (dom.btnMqttPause) {
        dom.btnMqttPause.addEventListener('click', () => setMqttPaused(!state.mqttPaused));
    }

    // ── Project บน server ──
    // ☁️⬆️ บันทึก · ☁️⬇️ เปิด · ปิดกล่องด้วยปุ่ม × หรือคลิกพื้นหลัง
    if (dom.btnSaveServer) dom.btnSaveServer.addEventListener('click', saveToServer);
    if (dom.btnOpenServer) dom.btnOpenServer.addEventListener('click', openServerDialog);
    if (dom.serverClose)   dom.serverClose.addEventListener('click', () => dom.serverOverlay.classList.add('hidden'));
    if (dom.serverOverlay) dom.serverOverlay.addEventListener('click', (e) => {
        if (e.target === dom.serverOverlay) dom.serverOverlay.classList.add('hidden');
    });
}
// ============================================================
// Initialize — entry point เรียกครั้งเดียวตอน script โหลด
// (ทำงานหลัง PARAMS โหลดเสร็จ เพราะ top-level await ด้านบนรอไว้แล้ว)
// ============================================================
function init() {
    initThree();    // สร้าง Three.js scene, camera, renderer, lights, grid
    bindEvents();   // ผูก event listener ทั้งหมด
}

// เริ่มแอป
init();
