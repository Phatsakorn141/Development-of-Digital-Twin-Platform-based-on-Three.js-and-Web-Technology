// ============================================================
// IMPORTS
// three        — Three.js core library สำหรับ 3D rendering
// OrbitControls — ให้ user หมุน/zoom กล้องด้วยเมาส์
// GLTFLoader   — โหลดไฟล์ .glb / .gltf เข้า scene
// ============================================================
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

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
    model: null,        // Object3D root ของ GLB ที่โหลดเข้ามา

    // ── Node management ──
    nodeMap: new Map(),             // uuid → Three.js Object3D (lookup เร็ว)
    nodeList: [],                   // array ของ { uuid, name, type } สำหรับ UI
    checkedNodeUUIDs: new Set(),    // uuid ที่ user check ✓ ใน Node Tree

    // ── Joint system ──
    joints: [],                     // array ของ joint object ทั้งหมด
    originalTransforms: new Map(),  // uuid → { position, rotation, visible } ค่าตอนโหลดครั้งแรก
    jointIdCounter: 0,              // auto-increment id ให้ joint ใหม่ (joint_0, joint_1 ...)

    // ── Sensor simulation ──
    simRunning: false,      // true = simulation กำลังเล่น
    simSpeed: 1.0,          // ตัวคูณความเร็ว sim (0.1× – 5×)
    simStartTime: 0,        // performance.now()/1000 ตอน start sim (ใช้คำนวณ elapsed)

    // ── Presets ──
    presets: [],            // array ของ preset object { id, name, values, savedAt }
    presetIdCounter: 0,     // auto-increment id ให้ preset ใหม่

    // ── Keyframe animation ──
    keyframes: [],          // array ของ keyframe { id, time, values }
    keyframeIdCounter: 0,   // auto-increment id ให้ keyframe ใหม่
    animPlaying: false,     // true = animation กำลังเล่น
    animStartTime: 0,       // timestamp ตอน play (ใช้คำนวณ elapsed)
    animLoop: false,        // true = loop ต่อเนื่องเมื่อถึง keyframe สุดท้าย

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
// ============================================================
const dom = {
    // viewport
    canvas: document.getElementById('three-canvas'),
    viewportContainer: document.getElementById('viewport-container'),
    viewportOverlay: document.getElementById('viewport-overlay'),       // overlay "No Model Loaded"

    // upload button + file input
    btnUpload: document.getElementById('btn-upload'),
    fileInput: document.getElementById('file-input'),

    // node tree panel
    nodeTreeContainer: document.getElementById('node-tree-container'),

    // joints panel
    jointsContainer: document.getElementById('joints-container'),
    btnAddJoint: document.getElementById('btn-add-joint'),
    selectionCount: document.getElementById('selection-count'),         // "N selected" badge

    // simulation controls (header center)
    simControls: document.getElementById('sim-controls'),
    btnSimToggle: document.getElementById('btn-sim-toggle'),
    simSpeedSlider: document.getElementById('sim-speed-slider'),
    simSpeedVal: document.getElementById('sim-speed-val'),
    simStatus: document.getElementById('sim-status'),

    // Add Joint modal
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
    simFreqGroup: document.getElementById('sim-freq-group'),            // แถว period (ซ่อนถ้า pattern=none)          // แถว period (ซ่อนถ้า pattern=none)
    jointPivotNode: document.getElementById('joint-pivot-node'),
    pivotGroup: document.getElementById('pivot-group'),                 // แถว pivot dropdown (ซ่อนถ้า single node)
    modalLinkedNodes: document.getElementById('modal-linked-nodes'),    // แสดง chip ของ node ที่เลือก

    // tabs
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
    // aspect=1 ชั่วคราว, จะ update ใน handleResize()
    state.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    state.camera.position.set(3, 2, 5);  // ตำแหน่งเริ่มต้น

    // ── Renderer ──
    state.renderer = new THREE.WebGLRenderer({ canvas: dom.canvas, antialias: true, alpha: false });
    state.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));  // ป้องกัน resolution เกินไป
    state.renderer.toneMapping = THREE.ACESFilmicToneMapping;            // tone mapping แบบ cinematic
    state.renderer.toneMappingExposure = 1.0;
    state.renderer.shadowMap.enabled = true;
    state.renderer.shadowMap.type = THREE.PCFSoftShadowMap;              // เงาแบบ soft

    // ── OrbitControls — หมุน / pan / zoom ด้วยเมาส์ ──
    state.controls = new OrbitControls(state.camera, dom.canvas);
    state.controls.enableDamping = true;        // ทำให้กล้องหยุดแบบ smooth
    state.controls.dampingFactor = 0.08;
    state.controls.minDistance = 0.5;           // ซูมเข้าได้ถึง 0.5 unit
    state.controls.maxDistance = 100;           // ซูมออกได้ถึง 100 unit

    // ── Lights ──
    // ambient: แสงรอบทิศทาง กันให้ model ไม่มืดเกิน
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    state.scene.add(ambientLight);

    // dirLight1: แสงหลัก (ขวาบนหน้า) cast shadow
    const dirLight1 = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight1.position.set(5, 8, 5);
    dirLight1.castShadow = true;
    dirLight1.shadow.mapSize.set(1024, 1024);
    state.scene.add(dirLight1);

    // dirLight2: แสงเติม (ซ้ายหลัง) ทำให้มีมิติ
    const dirLight2 = new THREE.DirectionalLight(0xb0c4de, 0.4);
    dirLight2.position.set(-3, 4, -5);
    state.scene.add(dirLight2);

    // ── Grid ── ช่วยให้เห็น scale และทิศทาง
    const grid = new THREE.GridHelper(20, 40, 0x2d3245, 0x1a1d27);
    grid.material.transparent = true;
    grid.material.opacity = 0.6;
    state.scene.add(grid);

    handleResize();                              // ตั้งค่า aspect ratio ครั้งแรก
    window.addEventListener('resize', handleResize);
    animate();                                   // เริ่ม render loop
}

// ── handleResize — ปรับ camera aspect + renderer size เมื่อหน้าต่างเปลี่ยนขนาด ──
function handleResize() {
    const rect = dom.viewportContainer.getBoundingClientRect();
    state.camera.aspect = rect.width / rect.height;
    state.camera.updateProjectionMatrix();       // ต้องเรียกทุกครั้งที่เปลี่ยน aspect
    state.renderer.setSize(rect.width, rect.height);
}

// ── animate — render loop หลัก เรียกตัวเองซ้ำทุก frame ผ่าน requestAnimationFrame ──
// ทุก frame:
//   1. อัปเดต simulation (ถ้ากำลังรัน)
//   2. อัปเดต animation playback (ถ้ากำลังเล่น)
//   3. อัปเดต OrbitControls (damping)
//   4. render scene
function animate() {
    requestAnimationFrame(animate);
    if (state.simRunning) updateSimulation();
    if (state.animPlaying) updateAnimationPlayback();
    state.controls.update();
    state.renderer.render(state.scene, state.camera);
}

// ============================================================
// Model Loading — โหลด GLB/GLTF จาก File object ที่ user เลือก
// ============================================================
function loadModel(file) {
    const loader = new GLTFLoader();
    const url = URL.createObjectURL(file);   // สร้าง blob URL ชั่วคราวจาก file

    loader.load(url, (gltf) => {
        // ── ถ้ามี model เก่าอยู่ ให้ลบออกและ dispose memory ก่อน ──
        if (state.model) {
            state.scene.remove(state.model);
            state.model.traverse((child) => {
                if (child.geometry) child.geometry.dispose();
                if (child.material) {
                    if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
                    else child.material.dispose();
                }
            });
        }

        // ── Reset state ทั้งหมด (หยุด sim, ล้าง joints, presets, keyframes) ──
        stopSimulation();
        stopAnimationPlayback();
        state.nodeMap.clear();
        state.nodeList = [];
        state.joints = [];
        state.jointIdCounter = 0;
        state.checkedNodeUUIDs.clear();
        state.originalTransforms.clear();
        state.presets = [];
        state.keyframes = [];

        const model = gltf.scene;
        state.model = model;

        // ── Auto-scale + center model ──
        // หา bounding box ของทั้ง model
        // scale ให้ขนาดใหญ่สุด = 3 units, ย้าย center ให้ตรง origin
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        const scale = 3 / maxDim;
        model.scale.multiplyScalar(scale);
        model.position.sub(center.multiplyScalar(scale));

        state.scene.add(model);

        // ── Reset กล้องกลับตำแหน่งเริ่มต้น ──
        state.camera.position.set(3, 2, 5);
        state.controls.target.set(0, 0, 0);
        state.controls.update();

        // ── Build node tree + อัปเดต UI ──
        parseNodeTree(model);
        updateStats();
        renderNodeTree();
        renderJoints();
        renderPresets();
        renderKeyframes();
        updateSelectionCount();
        updatePresetControls();
        updateAnimControls();

        dom.viewportOverlay.classList.add('hidden');     // ซ่อน "No Model Loaded" overlay
        dom.simControls.classList.remove('hidden');       // แสดง simulation controls
        URL.revokeObjectURL(url);                         // คืน memory blob URL
    }, undefined, (error) => {
        console.error('Error loading model:', error);
        alert('Failed to load model. Please check that the file is a valid GLTF/GLB.');
    });
}

// ============================================================
// Node Tree Parsing — traverse ทุก node ใน model
// สร้าง nodeMap (uuid→Object3D) และ nodeList (array สำหรับ UI)
// บันทึก originalTransforms ไว้ใช้ reset ทีหลัง
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
        state.originalTransforms.set(node.uuid, {
            position: node.position.clone(),
            rotation: new THREE.Euler(node.rotation.x, node.rotation.y, node.rotation.z, node.rotation.order),
            visible: node.visible,
        });
    });
}

// ── getNodeIcon — แปลง Three.js type string → icon name + CSS class สำหรับ UI ──
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
    if (!state.model) return;
    dom.nodeTreeContainer.innerHTML = '';
    dom.nodeTreeContainer.appendChild(createTreeNodeElement(state.model, 0));
}

// ── createTreeNodeElement — สร้าง div สำหรับ node เดียว + children แบบ recursive ──
// depth ใช้กำหนด padding-left ให้เห็น indent ของ hierarchy
function createTreeNodeElement(node, depth) {
    const container = document.createElement('div');
    container.className = 'tree-node';
    const hasChildren = node.children && node.children.length > 0;
    const iconInfo = getNodeIcon(node.type);
    const name = node.name || '[unnamed]';

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
function highlightNode(uuid) {
    // ลบ highlight เก่าก่อน
    highlightOutlines.forEach(h => state.scene.remove(h));
    highlightOutlines = [];

    const node = state.nodeMap.get(uuid);
    if (!node) return;

    const box = new THREE.Box3().setFromObject(node);
    if (box.isEmpty()) return;   // empty group ไม่มี bounding box

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
    highlightOutlines.forEach(h => state.scene.remove(h));
    highlightOutlines = [];
    for (const uuid of uuids) {
        const node = state.nodeMap.get(uuid);
        if (!node) continue;
        const box = new THREE.Box3().setFromObject(node);
        if (box.isEmpty()) continue;
        const helper = new THREE.Box3Helper(box, new THREE.Color(0x6366f1));
        state.scene.add(helper);
        highlightOutlines.push(helper);
    }
    setTimeout(() => {
        highlightOutlines.forEach(h => state.scene.remove(h));
        highlightOutlines = [];
    }, 3000);
}

// ============================================================
// Stats — นับ vertices / meshes / nodes แสดงที่ info bar ล่าง viewport
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
// ============================================================

// ── openAddJointModal — เปิด modal "Add Joint" และ populate ข้อมูล ──
function openAddJointModal() {
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
    dom.jointScale.value    = '1';
    dom.jointOffset.value   = '0';
    dom.jointInvert.checked = false;

    dom.coupledGroup.style.display = 'none';
    if (dom.pivotManualGroup) dom.pivotManualGroup.style.display = 'none';
    updateMinMaxDefaults();
    updateSimFreqVisibility();
    updatePivotVisibility();

    // ── Populate coupled target dropdown ด้วย joint ที่มีอยู่แล้ว ──
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
    dom.jointName.value         = joint.name;
    dom.jointType.value         = joint.jointType || 'revolute';
    dom.jointProperty.value     = joint.property;
    dom.jointMin.value          = joint.min;
    dom.jointMax.value          = joint.max;
    dom.jointStep.value         = joint.step;
    dom.jointSimPattern.value   = joint.simPattern || 'none';
    dom.jointSimFreq.value      = joint.simPeriod ?? 3;
    dom.jointCoupledRatio.value = joint.coupledRatio ?? 1;

    dom.jointSrcTopic.value = joint.srcTopic || '';
    dom.jointSrcPath.value  = joint.srcPath  || '';
    dom.jointScale.value    = joint.scale  ?? 1;
    dom.jointOffset.value   = joint.offset ?? 0;
    dom.jointInvert.checked = !!joint.invert;

    // ── dropdown coupled: ตัดตัวเองออก กัน joint ผูกกับตัวเองแล้ว loop ไม่รู้จบ ──

    // ── dropdown coupled: ตัดตัวเองออก กัน joint ผูกกับตัวเองแล้ว loop ไม่รู้จบ ──
    dom.jointCoupledTarget.innerHTML = '<option value="">-- เลือก Joint ต้นทาง --</option>';
    for (const j of state.joints) {
        if (j.id === jointId) continue;
        const opt = document.createElement('option');
        opt.value = j.id;
        opt.textContent = j.name;
        dom.jointCoupledTarget.appendChild(opt);
    }
    dom.jointCoupledTarget.value = joint.coupledTarget || '';

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

    startInspector();
    dom.modalOverlay.classList.remove('hidden');
    dom.jointName.focus();
}

// ── saveJointEdit — บันทึกค่าที่แก้ทับลง joint เดิม ──
// สำคัญ: แก้ property ของ object เดิม ไม่สร้าง object ใหม่และไม่ push
// ตำแหน่งใน state.joints จึงไม่ขยับ → mapping กับ actual_q[i] ไม่พัง
function saveJointEdit() {
    const joint = state.joints.find(j => j.id === state.editingJointId);
    if (!joint) { closeModal(); return; }

    const newProperty = dom.jointProperty.value;

    // ── ถ้าเปลี่ยน property ต้องคืนค่าแกนเดิมก่อน แล้วจับ base ของแกนใหม่ ──
    // ไม่งั้น node จะค้างมุมของแกนเก่าไว้ตลอด เช่นเปลี่ยน rotation.y → rotation.x
    // แล้ว rotation.y ยังค้างค่าสุดท้ายอยู่ ทำให้ท่าเพี้ยนถาวร
    // (joint ที่มี pivotGroup ไม่ต้องทำ เพราะ applyJointValue reset ทั้ง group ทุก frame อยู่แล้ว)
    if (newProperty !== joint.property && !joint.pivotGroup) {
        for (const uuid of joint.nodeUUIDs) {
            const node = state.nodeMap.get(uuid);
            if (!node) continue;
            const oldBase = joint.baseValues?.get(uuid);
            if (oldBase !== undefined) setNodePropertyValue(node, joint.property, oldBase);
        }
        const newBase = new Map();
        for (const uuid of joint.nodeUUIDs) {
            const node = state.nodeMap.get(uuid);
            if (node) newBase.set(uuid, getNodePropertyValue(node, newProperty));
        }
        joint.baseValues = newBase;
    }

    // ── เขียนค่าใหม่ทับ ──
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

    joint.srcTopic = dom.jointSrcTopic.value.trim();
    joint.srcPath  = dom.jointSrcPath.value.trim();
    const sc = parseFloat(dom.jointScale.value);
    const of = parseFloat(dom.jointOffset.value);
    joint.scale  = Number.isFinite(sc) ? sc : 1;
    joint.offset = Number.isFinite(of) ? of : 0;
    joint.invert = dom.jointInvert.checked;

    resubscribeJoints();   // เผื่อเพิ่ง/เปลี่ยน topic ระหว่างที่ต่อ broker อยู่

    // apply ซ้ำด้วยค่าเดิม เพื่อให้ค่าถูก clamp เข้า min/max ที่เพิ่งเปลี่ยน
    applyJointValue(joint, joint.value);

    closeModal();
    renderJoints();
    updatePresetControls();
    updateAnimControls();
}

// ── updateMinMaxDefaults — set min/max/step default ตาม property ที่เลือก ──
function updateMinMaxDefaults() {
    const prop = dom.jointProperty.value;
    if (prop.startsWith('rotation')) {
        dom.jointMin.value = '-3.14';   // -π rad ≈ -180°
        dom.jointMax.value = '3.14';    // +π rad ≈ +180°
        dom.jointStep.value = '0.01';
    } else if (prop.startsWith('position')) {
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
    if (dom.pivotManualGroup) {
        const isManual = dom.jointPivotNode.value === 'manual';
        dom.pivotManualGroup.style.display = (showPivot && isManual) ? 'flex' : 'none';
    }
}

// ── closeModal — ปิด Add Joint modal ──
// ── closeModal — ปิด modal และคืนสภาพกลับเป็นโหมด Add ──
function closeModal() {
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
    const name = dom.jointName.value.trim() || `Joint ${state.jointIdCounter + 1}`;
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
    const srcTopic = dom.jointSrcTopic.value.trim();
    const srcPath  = dom.jointSrcPath.value.trim();
    const scale    = parseFloat(dom.jointScale.value);
    const offset   = parseFloat(dom.jointOffset.value);
    const invert   = dom.jointInvert.checked;

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
        pivotGroup = new THREE.Group();
        pivotGroup.name = `__joint_pivot_${state.jointIdCounter}`;

        // ── คำนวณตำแหน่ง pivot (world space) ตามโหมดที่เลือก ──
        const centroid = new THREE.Vector3();

        if (pivotNodeUUID === 'manual') {
            // user กรอก XYZ เอง → ใช้ค่านั้นตรงๆ ไม่คำนวณอัตโนมัติ
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
        property,
        min, max, step,
        value: 0,               // ค่าปัจจุบัน (เริ่มที่ 0)
        baseValues,             // Map(uuid → ค่าเริ่มต้น) สำหรับ single-node joint
        pivotGroup,             // THREE.Group สำหรับ pivot (null ถ้า single node)
        pivotBasePosition,      // local position ของ pivotGroup ใช้ reset ทุก frame
        originalParentData,     // Map(uuid → { parent }) ใช้ restore เมื่อลบ joint
        simPattern,
        simPeriod,
        jointType,
        coupledTarget,
        coupledRatio,
        srcTopic, srcPath,
        scale:  Number.isFinite(scale)  ? scale  : 1,    // ช่องว่าง → 1 (ไม่แปลงหน่วย)
        offset: Number.isFinite(offset) ? offset : 0,
        invert,
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

    state.joints.splice(idx, 1);
    markBoundNodes();
    renderJoints();
    updatePresetControls();
    updateAnimControls();
}

// ── getNodePropertyValue — อ่านค่า property ปัจจุบันของ node ──
// property เป็น string เช่น "rotation.y", "position.x", "visible"
function getNodePropertyValue(node, property) {
    const [prop, axis] = property.split('.');
    if (prop === 'visible') return node.visible ? 1 : 0;
    return node[prop][axis];
}

// ── setNodePropertyValue — กำหนดค่า property ของ node ──
function setNodePropertyValue(node, property, value) {
    const [prop, axis] = property.split('.');
    if (prop === 'visible') { node.visible = value >= 0.5; return; }
    node[prop][axis] = value;
}

// ── applyJointValue — apply ค่า joint ลง 3D objects จริงๆ ──
// ทุกครั้งที่ slider เคลื่อน / sim update / animation playback เรียกฟังก์ชันนี้
function applyJointValue(joint, value) {
    // continuous joint หมุนต่อเนื่อง ไม่มี limit clamp
    const clamped = (joint.jointType === 'continuous')
        ? value
        : Math.min(joint.max, Math.max(joint.min, value));   // clamp ให้อยู่ใน min-max

    joint.value = clamped;

    if (joint.pivotGroup) {
        const [prop, axis] = joint.property.split('.');
        // ── Reset pivotGroup ทุก frame ก่อน apply ค่าใหม่ ──
        // ป้องกัน drift สะสมจาก floating point
        joint.pivotGroup.position.copy(joint.pivotBasePosition);
        joint.pivotGroup.rotation.set(0, 0, 0);
        if (prop === 'rotation') joint.pivotGroup.rotation[axis] = clamped;
        else if (prop === 'position') joint.pivotGroup.position[axis] += clamped;
    } else {
        // ── single-node joint: apply ค่า relative จาก base ──
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
    const slider  = document.getElementById(`slider-${joint.id}`);
    const numEl   = document.getElementById(`num-${joint.id}`);
    const valEl   = document.getElementById(`val-${joint.id}`);
    const degEl   = document.getElementById(`deg-${joint.id}`);     // แสดงเป็นองศา
    const cardEl  = document.getElementById(`card-${joint.id}`);
    const limitEl = document.getElementById(`limit-${joint.id}`);   // warning icon

    if (slider) slider.value = value;
    if (numEl)  numEl.value  = value.toFixed(3);
    if (valEl)  valEl.textContent = value.toFixed(3);
    if (degEl && joint.property.startsWith('rotation')) {
        // แปลง radian → degree สำหรับแสดง
        degEl.textContent = `${(value * 180 / Math.PI).toFixed(1)}°`;
    }
    // เพิ่ม class 'simulating' เมื่อ sim กำลังรัน (เปลี่ยนสี card)
    if (cardEl) cardEl.classList.toggle('simulating', state.simRunning);

    // แสดง warning icon เมื่อค่า >= 90% ของ range
    if (limitEl && joint.jointType !== 'continuous') {
        const range = joint.max - joint.min;
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
    document.querySelectorAll('.tree-node-row.bound').forEach(el => el.classList.remove('bound'));
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
function calibrateJoint(jointId) {
    const joint = state.joints.find(j => j.id === jointId);
    if (!joint) return;

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
// แค่ไม่ apply ลงโมเดล ผู้ใช้จึงลาก slider ได้โดยไม่โดนเขียนทับ 10 ครั้ง/วินาที
function setMqttPaused(paused) {
    state.mqttPaused = paused;
    if (dom.btnMqttPause) {
        dom.btnMqttPause.innerHTML = paused
            ? '<span class="material-icons-round">play_arrow</span>Resume'
            : '<span class="material-icons-round">pause</span>Pause';
        dom.btnMqttPause.classList.toggle('paused', paused);
    }
    document.querySelectorAll('.joint-card')
            .forEach(c => c.classList.toggle('paused-hint', paused));
}

// ============================================================
// Network Stats — วัดคุณภาพการรับข้อมูล (latency / rate / jitter / ข้อความหาย)
//
// วัดได้เฉพาะช่วง bridge.py → เบราว์เซอร์ เพราะสองฝั่งอยู่เครื่องเดียวกัน
// ใช้นาฬิกาตัวเดียวกัน จึงลบเวลากันได้ตรงๆ
// ส่วนช่วง URSim → bridge วัดเป็น ms ไม่ได้ (นาฬิกาใน VM คนละตัว)
// แต่ดูคุณภาพได้จาก jitter กับจำนวนข้อความหายแทน
// ============================================================

// ── recordNetStats — บันทึกสถิติของข้อความที่เพิ่งมาถึง ──
// ถูกเรียกทุกข้อความ (10 ครั้ง/วินาที) ต้องเบา ห้ามคำนวณอะไรหนักตรงนี้
function recordNetStats(payload) {
    const s = state.netStats;
    const now = Date.now();

    s.arrivals.push(now);

    if (Number.isFinite(payload?.t_publish)) {
        s.latencies.push(now - payload.t_publish * 1000);
    }

    // ข้อความหาย: ต้องใช้ pub_seq (ตัวนับฝั่ง publish) ไม่ใช่ src_seq ของ URScript
    // เพราะ URScript เดินที่ 20 Hz แต่ bridge publish แค่ 10 Hz
    // src_seq จึงกระโดดทีละ 2 โดยตั้งใจ ถ้าเอามานับจะกลายเป็นนับข้อความที่ทิ้งเองว่าหาย
    const seq = Number(payload?.pub_seq);
    if (Number.isFinite(seq)) {
        if (s.lastSeq !== null && seq > s.lastSeq + 1) s.lost += seq - s.lastSeq - 1;
        s.lastSeq = seq;
    }

    // ตัดข้อมูลเก่ากว่า 5 วินาทีทิ้ง กันหน่วยความจำโตไม่หยุดตอนเปิดค้างไว้นานๆ
    const cutoff = now - 5000;
    while (s.arrivals.length && s.arrivals[0] < cutoff) s.arrivals.shift();
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
    const gaps = [];
    for (let i = 1; i < s.arrivals.length; i++) gaps.push(s.arrivals[i] - s.arrivals[i - 1]);
    let jitter = null;
    if (gaps.length > 1) {
        const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        jitter = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
    }

    const fmt = (v) => v === null ? '—' : v.toFixed(0);

    el.innerHTML =
        `<span title="เวลาเดินทาง bridge.py → เบราว์เซอร์">⚡ ${fmt(latAvg)} ms</span>` +
        `<span title="ข้อความที่ได้รับต่อวินาที">📶 ${rate} Hz</span>` +
        `<span title="ความสม่ำเสมอของช่วงห่างระหว่างข้อความ">〰 ±${fmt(jitter)} ms</span>` +
        `<span class="${s.lost > 0 ? 'net-bad' : ''}" title="ข้อความที่หายระหว่างทาง (ดูจาก seq)">✉ ${s.lost}</span>`;
}

// ── start/stopNetStats — เปิด/ปิดการวัด ──
function startNetStats() {
    const s = state.netStats;
    s.arrivals = []; s.latencies = []; s.lastSeq = null; s.lost = 0;   // เริ่มนับใหม่ทุกครั้งที่ต่อ
    clearInterval(s.timer);
    s.timer = setInterval(renderNetStats, 1000);
    renderNetStats();
}
function stopNetStats() {
    clearInterval(state.netStats.timer);
    state.netStats.timer = null;
    renderNetStats();
}

// ============================================================
// Joint Rendering — สร้าง HTML card สำหรับแต่ละ joint
// รวม slider, number input, step buttons, reset, remove, show-nodes
// ============================================================
function renderJoints() {
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
                        <span class="material-icons-round">adjust</span>${joint.property}
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
    const name = prompt('Preset name:', `State ${state.presetIdCounter + 1}`);
    if (name === null) return;   // user กด cancel
    const finalName = name.trim() || `State ${state.presetIdCounter + 1}`;
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

        card.querySelector('.btn-del-preset').addEventListener('click', () => deletePreset(preset.id));
        dom.presetsContainer.appendChild(card);
    });
}

// ── updatePresetControls — enable/disable ปุ่ม Save/Export ตาม state ──
function updatePresetControls() {
    if (dom.btnSavePreset) dom.btnSavePreset.disabled = state.joints.length === 0;
    if (dom.btnExportProject) dom.btnExportProject.disabled =
        state.joints.length === 0 && state.presets.length === 0 && state.keyframes.length === 0;
}

// ============================================================
// Project Export / Import — บันทึก/โหลดไฟล์ .dtwp (JSON)
// .dtwp เก็บ: joints (พร้อม nodeNames), presets, keyframes
// ============================================================

// ── exportProject — serialize state เป็น JSON และ download ──
function exportProject() {
    const data = {
        version: 1,
        exportedAt: new Date().toISOString(),
        jointIdCounter: state.jointIdCounter,
        presetIdCounter: state.presetIdCounter,
        keyframeIdCounter: state.keyframeIdCounter,
        joints: state.joints.map(j => ({
            id: j.id, name: j.name,
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
            srcTopic: j.srcTopic || '',
            srcPath:  j.srcPath  || '',
            scale:    j.scale  ?? 1,
            offset:   j.offset ?? 0,
            invert:   !!j.invert,
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
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'digital-twin-project.dtwp'; a.click();
    URL.revokeObjectURL(url);
}

// ── importProject — อ่านไฟล์ .dtwp และ restore joints/presets/keyframes ──
function importProject(file) {
    if (!state.model) { alert('Please load a 3D model first, then import the project file.'); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);
            if (!data.version || !Array.isArray(data.joints)) { alert('Invalid project file.'); return; }

            // ── ลบ joint เก่าทั้งหมดก่อน import ใหม่ ──
            const ids = state.joints.map(j => j.id);
            for (const id of ids) removeJoint(id);

            // ── Restore counter จากไฟล์ เพื่อให้ id ต่อเนื่อง ──
            if (data.jointIdCounter) state.jointIdCounter = data.jointIdCounter;
            if (data.presetIdCounter) state.presetIdCounter = data.presetIdCounter;
            if (data.keyframeIdCounter) state.keyframeIdCounter = data.keyframeIdCounter;

            // ── เรียง joint จากมาก → น้อย nodeUUIDs (parent joint ก่อน child joint) ──
            // เหตุผล: joint ที่มี node มากกว่าคือ parent
            // ถ้า import child ก่อน parent จะพยายาม attach node ที่ยังไม่มี pivotGroup parent
            // ทำให้ตำแหน่งผิด
            const sortedJoints = [...data.joints].sort(
                (a, b) => (b.nodeUUIDs?.length || 0) - (a.nodeUUIDs?.length || 0)
            );
            let failed = 0;
            for (const cfg of sortedJoints) { if (!importJoint(cfg)) failed++; }

            state.presets = data.presets || [];
            state.keyframes = data.keyframes || [];

            markBoundNodes(); renderJoints(); renderPresets(); renderKeyframes();
            updateSelectionCount(); updatePresetControls(); updateAnimControls();

            const total = data.joints.length, ok = total - failed;
            alert(failed === 0
                ? `Imported: ${ok} joint(s), ${state.presets.length} preset(s), ${state.keyframes.length} keyframe(s).`
                : `Imported ${ok}/${total} joints (${failed} failed). Presets and keyframes restored.`);
        } catch (err) { alert('Failed to read project file: ' + err.message); }
    };
    reader.readAsText(file);
}

// ── importJoint — สร้าง joint เดียวจาก config object ที่อ่านจาก .dtwp ──
// คืน true ถ้า import สำเร็จ, false ถ้า node หาไม่เจอ
function importJoint(cfg) {
    // ── สร้าง nameToNode map สำหรับ lookup node ด้วยชื่อ ──
    // UUID เปลี่ยนทุกครั้งที่โหลด GLB ใหม่ แต่ชื่อ node คงที่
    const nameToNode = new Map();
    for (const [, node] of state.nodeMap) { if (node.name) nameToNode.set(node.name, node); }

    // ── Resolve nodes ด้วยชื่อก่อน (UUID เป็น fallback) ──
    const nodeNames = cfg.nodeNames || [];
    const resolvedNodes = [];
    for (let i = 0; i < nodeNames.length; i++) {
        const name = nodeNames[i];
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

    const nodeUUIDs = resolvedNodes.map(n => n.uuid);
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
            let c = 0;
            for (const n of resolvedNodes) { centroid.add(getNodeCenter(n)); c++; }
            if (c > 0) centroid.divideScalar(c);
        }

        pivotGroup = new THREE.Group();
        pivotGroup.name = `__pivot_${cfg.id}`;

        // ── หา topmost nodes ──
        const selectedSet = new Set(nodeUUIDs);
        const topmostNodes = resolvedNodes.filter(node => {
            let p = node.parent;
            while (p) { if (selectedSet.has(p.uuid)) return false; p = p.parent; }
            return true;
        });

        // ── แทรก pivotGroup เข้า hierarchy เดิม (เหมือน addJoint) ──
        let pivotParent = state.scene;
        if (topmostNodes.length > 0 && topmostNodes[0].parent) pivotParent = topmostNodes[0].parent;
        pivotParent.updateWorldMatrix(true, false);
        const localCentroid = pivotParent.worldToLocal(centroid.clone());
        pivotParent.add(pivotGroup);
        pivotGroup.position.copy(localCentroid);
        pivotGroup.updateWorldMatrix(true, false);
        pivotBasePosition = localCentroid.clone();

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
    const lastTime = kfs.length > 0 ? kfs[kfs.length - 1].time : -1;
    const time = parseFloat((lastTime + 1).toFixed(2));
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
    if (state.keyframes.length === 0) {
        dom.animationContainer.innerHTML = `
            <div class="empty-state">
                <span class="material-icons-round">movie</span>
                <p>Pose joints, click Add Keyframe. Repeat for each step, then Play.</p>
            </div>`;
        return;
    }
    dom.animationContainer.innerHTML = '';
    const sorted = [...state.keyframes].sort((a, b) => a.time - b.time);
    sorted.forEach((kf, idx) => {
        const item = document.createElement('div');
        item.className = 'keyframe-item';
        item.id = `kf-item-${kf.id}`;

        // chips แสดงค่า joint แต่ละตัวใน keyframe นี้
        const chips = Object.entries(kf.values).map(([jid, val]) => {
            const joint = state.joints.find(j => j.id === jid);
            if (!joint) return '';
            const disp = joint.property.startsWith('rotation')
                ? `${(val * 180 / Math.PI).toFixed(0)}°` : val.toFixed(2);
            return `<span class="keyframe-joint-chip">${escapeHtml(joint.name)}: ${disp}</span>`;
        }).join('');

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
    return Math.max(...state.keyframes.map(kf => kf.time));
}

// ── updateTimecodeDisplay — อัปเดต "0.00s / 5.00s" ใน animation tab ──
function updateTimecodeDisplay() {
    if (dom.animTimecode) dom.animTimecode.textContent = `0.00s / ${getTotalDuration().toFixed(2)}s`;
}

// ── playAnimationPlayback — เริ่มเล่น animation ──
function playAnimationPlayback() {
    if (state.keyframes.length < 2) return;
    state.animPlaying = true;
    state.animStartTime = performance.now() / 1000;  // บันทึกเวลาเริ่มต้น
    dom.btnPlayAnim.classList.add('running');
    dom.btnPlayAnim.querySelector('.material-icons-round').textContent = 'pause';
    dom.animTimecode.classList.add('playing');
    if (state.simRunning) stopSimulation();   // หยุด sim ก่อนเล่น animation
}

// ── stopAnimationPlayback — หยุดเล่น animation ──
function stopAnimationPlayback() {
    state.animPlaying = false;
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
    const kfs = [...state.keyframes].sort((a, b) => a.time - b.time);
    const totalDuration = kfs[kfs.length - 1].time;
    if (totalDuration <= 0) { stopAnimationPlayback(); return; }

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
    const segDur = kfB.time - kfA.time;
    const alpha = segDur > 0 ? (elapsed - kfA.time) / segDur : 1;

    for (const joint of state.joints) {
        const valA = kfA.values[joint.id] ?? 0;
        const valB = kfB.values[joint.id] ?? 0;
        const val = valA + (valB - valA) * alpha;   // lerp formula: a + (b-a)*t
        applyJointValue(joint, val);
        syncJointUI(joint, joint.value);
    }

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
// ============================================================

// ── resolvePath — อ่านค่าจาก payload ตาม path string ──
//   "actual_q[0]" → payload.actual_q[0]
//   "data.j1"     → payload.data.j1
//   ""            → payload ทั้งก้อน (กรณี payload เป็นตัวเลขเดี่ยว)
function resolvePath(obj, path) {
    if (!path) return obj;
    return path.split(/[.\[\]]+/).filter(Boolean)
               .reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// ── topicMatches — เทียบ topic กับ pattern แบบ MQTT wildcard ──
//   "+" = แทน 1 ระดับ   |   "#" = แทนทุกระดับที่เหลือ (ต้องอยู่ท้ายสุด)
function topicMatches(pattern, topic) {
    if (!pattern) return false;
    const p = pattern.split('/'), t = topic.split('/');
    for (let i = 0; i < p.length; i++) {
        if (p[i] === '#') return true;
        if (i >= t.length) return false;
        if (p[i] === '+') continue;
        if (p[i] !== t[i]) return false;
    }
    return p.length === t.length;
}

// ── jointTopics — รวบ topic ที่ต้อง subscribe จาก joint ทั้งหมด (ตัดซ้ำ) ──
function jointTopics() {
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
function flattenPaths(obj, prefix = '', out = []) {
    if (out.length > 200) return out;                     // กัน payload ยักษ์ทำเบราว์เซอร์ค้าง
    if (obj === null || typeof obj !== 'object') { out.push([prefix, obj]); return out; }
    if (Array.isArray(obj)) {
        obj.forEach((v, i) => flattenPaths(v, `${prefix}[${i}]`, out));
    } else {
        for (const [k, v] of Object.entries(obj)) {
            flattenPaths(v, prefix ? `${prefix}.${k}` : k, out);
        }
    }
    return out;
}

// ── renderPayloadInspector — แสดง payload สด ให้คลิกเลือก field ──
function renderPayloadInspector() {
    const box = dom.payloadInspector;
    if (!box) return;

    const topics = Object.keys(state.lastPayloads).sort();
    if (topics.length === 0) {
        box.innerHTML = '<span class="form-hint">ยังไม่ได้รับข้อมูล — กด Connect โดยเปิด Discover ไว้ แล้วรอให้อุปกรณ์ส่งข้อมูลเข้ามา</span>';
        return;
    }

    box.innerHTML = '';
    for (const topic of topics) {
        const entry = state.lastPayloads[topic];

        const head = document.createElement('div');
        head.className = 'pi-topic';
        head.textContent = `${topic}  (${entry.count} msg)`;
        box.appendChild(head);

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
    clearInterval(state.inspectorTimer);
    state.inspectorTimer = setInterval(renderPayloadInspector, 800);
}
function stopInspector() {
    clearInterval(state.inspectorTimer);
    state.inspectorTimer = null;
}

// ── connectMQTT — เชื่อมต่อ broker ด้วย WebSocket (wss://) ──
function connectMQTT() {
    const url  = dom.mqttUrl.value.trim();
    const user = dom.mqttUser.value.trim();
    const pass = dom.mqttPass.value.trim();

    if (!url) { alert('กรุณากรอก Broker URL\nเช่น wss://xxxx.s1.eu.hivemq.cloud:8884/mqtt'); return; }

    updateMQTTStatus('connecting');

    // สร้าง client ใหม่ทุกครั้งที่ connect
    state.mqttClient = mqtt.connect(url, {
        clientId:        `digital-twin-${Math.random().toString(16).slice(2)}`,
        username:        user || undefined,   // ถ้าว่างไม่ส่งไป
        password:        pass || undefined,
        clean:           true,
        keepalive:       300,    // 5 นาที — เผื่อ Chrome หรี่ timer ตอนแท็บอยู่เบื้องหลัง
        reconnectPeriod: 3000,   // reconnect อัตโนมัติทุก 3 วินาทีถ้าหลุด
    });

    // ── เชื่อมต่อสำเร็จ ──
    state.mqttClient.on('connect', () => {
        state.mqttConnected = true;

               
                // subscribe ตาม srcTopic ของแต่ละ joint — ไม่มี topic ตายตัวในโค้ดอีกต่อไป
               // topic ที่ joint ผูกไว้ + "#" ถ้าเปิด Discover (ฟังทุก topic เพื่อสำรวจ)
        const bound  = jointTopics();
        const topics = dom.mqttDiscover?.checked ? [...new Set([...bound, '#'])] : bound;

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

        updateMQTTStatus('connected');
        startNetStats();
        dom.btnMqttConnect.innerHTML =
            '<span class="material-icons-round">link_off</span>Disconnect';
    });

        // ── รับ message จาก broker ──
       // ── รับ message จาก broker ──
    // ไม่มีชื่อ topic หรือ field ของหุ่นรุ่นใดอยู่ในนี้เลย
    // ทุกอย่างมาจาก srcTopic / srcPath / scale / invert / offset ที่ตั้งไว้ในแต่ละ joint
    state.mqttClient.on('message', (topic, message) => {
        const text = message.toString();

        // payload อาจเป็น JSON หรือตัวเลขเดี่ยว — รองรับทั้งสองแบบ
        let payload;
        try { payload = JSON.parse(text); }
        catch (e) { payload = parseFloat(text); }

        // เก็บ payload ล่าสุดต่อ topic ไว้ให้ Payload Inspector
        const rec = state.lastPayloads[topic] || { count: 0 };
        rec.payload = payload;
        rec.count++;
        rec.ts = Date.now();
        state.lastPayloads[topic] = rec;

        recordNetStats(payload);

        let matched = 0;
        for (const joint of state.joints) {
            if (!topicMatches(joint.srcTopic, topic)) continue;

            const raw = Number(resolvePath(payload, joint.srcPath));
            if (!Number.isFinite(raw)) continue;   // path ผิด หรือค่าไม่ใช่ตัวเลข

            // แปลงจากหน่วย/จุดศูนย์ของอุปกรณ์ → หน่วย/จุดศูนย์ของ node ในโมเดล
            let v = raw * (joint.scale ?? 1);
            if (joint.invert) v = -v;
            v += (joint.offset ?? 0);

                        joint._lastRaw = raw;   // เก็บค่าดิบไว้เสมอ แม้ตอน pause — Calibrate ต้องใช้
            matched++;

            if (state.mqttPaused) continue;   // pause = ไม่แตะโมเดล ผู้ใช้จะได้ลาก slider ได้

            applyJointValue(joint, v);
            syncJointUI(joint, joint.value);       // ใช้ joint.value เพราะโดน clamp มาแล้ว
        }

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

    // ── หลุดการเชื่อมต่อ ──
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
    div.textContent = str;
    return div.innerHTML;
}

// ── truncate — ตัด string ให้สั้นลงถ้ายาวเกิน len แล้วใส่ … ต่อท้าย ──
function truncate(str, len) {
    return str.length > len ? str.substring(0, len) + '…' : str;
}

// ============================================================
// Event Bindings — ผูก event listener ทั้งหมดครั้งเดียวตอน init
// แยกออกมาจาก init เพื่อความอ่านง่าย
// ============================================================
function bindEvents() {
    // ── Upload model button + file input ──
    dom.btnUpload.addEventListener('click', () => dom.fileInput.click());
    dom.fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) loadModel(file);
        e.target.value = '';   // reset ให้ select ไฟล์เดิมซ้ำได้
    });

    // ── Drag & Drop ไฟล์ GLB/GLTF ลง viewport ──
    dom.viewportContainer.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    });
    dom.viewportContainer.addEventListener('drop', (e) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (file && (file.name.endsWith('.glb') || file.name.endsWith('.gltf'))) loadModel(file);
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
        if (!state.editingJointId) updateMinMaxDefaults();
        updatePivotVisibility();
    });
    dom.jointSimPattern.addEventListener('change', updateSimFreqVisibility);

    // ── Simulation controls ──
    dom.btnSimToggle.addEventListener('click', toggleSimulation);
    dom.simSpeedSlider.addEventListener('input', (e) => {
        state.simSpeed = parseFloat(e.target.value);
        dom.simSpeedVal.textContent = `${state.simSpeed.toFixed(1)}x`;
    });

    // ── Tab switching ──
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
}

// ============================================================
// Initialize — entry point เรียกครั้งเดียวตอน script โหลด
// ============================================================
function init() {
    initThree();    // สร้าง Three.js scene, camera, renderer, lights, grid
    bindEvents();   // ผูก event listener ทั้งหมด
}

init();
