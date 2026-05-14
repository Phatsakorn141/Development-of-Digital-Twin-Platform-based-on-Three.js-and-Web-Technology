import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ============================================================
// App State
// ============================================================
const state = {
    scene: null,
    camera: null,
    renderer: null,
    controls: null,
    model: null,
    nodeMap: new Map(),
    nodeList: [],
    checkedNodeUUIDs: new Set(),
    joints: [],
    originalTransforms: new Map(),
    jointIdCounter: 0,
    simRunning: false,
    simSpeed: 1.0,
    simStartTime: 0,
    presets: [],
    presetIdCounter: 0,
    keyframes: [],
    keyframeIdCounter: 0,
    animPlaying: false,
    animStartTime: 0,
    animLoop: false,
};

// ============================================================
// DOM References
// ============================================================
const dom = {
    canvas: document.getElementById('three-canvas'),
    viewportContainer: document.getElementById('viewport-container'),
    viewportOverlay: document.getElementById('viewport-overlay'),
    btnUpload: document.getElementById('btn-upload'),
    fileInput: document.getElementById('file-input'),
    nodeTreeContainer: document.getElementById('node-tree-container'),
    jointsContainer: document.getElementById('joints-container'),
    btnAddJoint: document.getElementById('btn-add-joint'),
    selectionCount: document.getElementById('selection-count'),
    simControls: document.getElementById('sim-controls'),
    btnSimToggle: document.getElementById('btn-sim-toggle'),
    simSpeedSlider: document.getElementById('sim-speed-slider'),
    simSpeedVal: document.getElementById('sim-speed-val'),
    simStatus: document.getElementById('sim-status'),
    modalOverlay: document.getElementById('modal-overlay'),
    modalClose: document.getElementById('modal-close'),
    modalCancel: document.getElementById('modal-cancel'),
    modalConfirm: document.getElementById('modal-confirm'),
    jointName: document.getElementById('joint-name'),
    jointType: document.getElementById('joint-type'),
    jointCoupledTarget: document.getElementById('joint-coupled-target'),
    jointCoupledRatio: document.getElementById('joint-coupled-ratio'),
    coupledGroup: document.getElementById('coupled-group'),
    jointProperty: document.getElementById('joint-property'),
    jointMin: document.getElementById('joint-min'),
    jointMax: document.getElementById('joint-max'),
    jointStep: document.getElementById('joint-step'),
    jointSimPattern: document.getElementById('joint-sim-pattern'),
    jointSimFreq: document.getElementById('joint-sim-freq'),
    simFreqGroup: document.getElementById('sim-freq-group'),
    jointPivotNode: document.getElementById('joint-pivot-node'),
    pivotGroup: document.getElementById('pivot-group'),
    modalLinkedNodes: document.getElementById('modal-linked-nodes'),
    tabJoints: document.getElementById('tab-joints'),
    tabPresets: document.getElementById('tab-presets'),
    tabAnimation: document.getElementById('tab-animation'),
    btnExportProject: document.getElementById('btn-export-project'),
    btnImportProject: document.getElementById('btn-import-project'),
    projectFileInput: document.getElementById('project-file-input'),
    btnSavePreset: document.getElementById('btn-save-preset'),
    presetsContainer: document.getElementById('presets-container'),
    btnAddKeyframe: document.getElementById('btn-add-keyframe'),
    btnPlayAnim: document.getElementById('btn-play-anim'),
    animLoopChk: document.getElementById('anim-loop'),
    animTimecode: document.getElementById('anim-timecode'),
    animationContainer: document.getElementById('animation-container'),
    infoVertices: document.getElementById('info-vertices'),
    infoMeshes: document.getElementById('info-meshes'),
    infoNodes: document.getElementById('info-nodes'),
};

// ============================================================
// Three.js Setup
// ============================================================
function initThree() {
    state.scene = new THREE.Scene();
    state.scene.background = new THREE.Color(0x0f1117);

    state.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    state.camera.position.set(3, 2, 5);

    state.renderer = new THREE.WebGLRenderer({ canvas: dom.canvas, antialias: true, alpha: false });
    state.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    state.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    state.renderer.toneMappingExposure = 1.0;
    state.renderer.shadowMap.enabled = true;
    state.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    state.controls = new OrbitControls(state.camera, dom.canvas);
    state.controls.enableDamping = true;
    state.controls.dampingFactor = 0.08;
    state.controls.minDistance = 0.5;
    state.controls.maxDistance = 100;

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    state.scene.add(ambientLight);
    const dirLight1 = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight1.position.set(5, 8, 5);
    dirLight1.castShadow = true;
    dirLight1.shadow.mapSize.set(1024, 1024);
    state.scene.add(dirLight1);
    const dirLight2 = new THREE.DirectionalLight(0xb0c4de, 0.4);
    dirLight2.position.set(-3, 4, -5);
    state.scene.add(dirLight2);

    const grid = new THREE.GridHelper(20, 40, 0x2d3245, 0x1a1d27);
    grid.material.transparent = true;
    grid.material.opacity = 0.6;
    state.scene.add(grid);

    handleResize();
    window.addEventListener('resize', handleResize);
    animate();
}

function handleResize() {
    const rect = dom.viewportContainer.getBoundingClientRect();
    state.camera.aspect = rect.width / rect.height;
    state.camera.updateProjectionMatrix();
    state.renderer.setSize(rect.width, rect.height);
}

function animate() {
    requestAnimationFrame(animate);
    if (state.simRunning) updateSimulation();
    if (state.animPlaying) updateAnimationPlayback();
    state.controls.update();
    state.renderer.render(state.scene, state.camera);
}

// ============================================================
// Model Loading
// ============================================================
function loadModel(file) {
    const loader = new GLTFLoader();
    const url = URL.createObjectURL(file);

    loader.load(url, (gltf) => {
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

        // Auto-scale and center
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        const scale = 3 / maxDim;
        model.scale.multiplyScalar(scale);
        model.position.sub(center.multiplyScalar(scale));

        state.scene.add(model);
        state.camera.position.set(3, 2, 5);
        state.controls.target.set(0, 0, 0);
        state.controls.update();

        parseNodeTree(model);
        updateStats();
        renderNodeTree();
        renderJoints();
        renderPresets();
        renderKeyframes();
        updateSelectionCount();
        updatePresetControls();
        updateAnimControls();

        dom.viewportOverlay.classList.add('hidden');
        dom.simControls.classList.remove('hidden');
        URL.revokeObjectURL(url);
    }, undefined, (error) => {
        console.error('Error loading model:', error);
        alert('Failed to load model. Please check that the file is a valid GLTF/GLB.');
    });
}

// ============================================================
// Node Tree Parsing
// ============================================================
function parseNodeTree(root) {
    root.traverse((node) => {
        state.nodeMap.set(node.uuid, node);
        state.nodeList.push({ uuid: node.uuid, name: node.name || `[unnamed_${node.type}]`, type: node.type });
        state.originalTransforms.set(node.uuid, {
            position: node.position.clone(),
            rotation: new THREE.Euler(node.rotation.x, node.rotation.y, node.rotation.z, node.rotation.order),
            visible: node.visible,
        });
    });
}

function getNodeIcon(type) {
    switch (type) {
        case 'Mesh': case 'SkinnedMesh': return { icon: 'hexagon', cls: 'mesh' };
        case 'Group': case 'Object3D': return { icon: 'folder', cls: 'group' };
        case 'Bone': return { icon: 'skeleton', cls: 'bone' };
        case 'DirectionalLight': case 'PointLight': case 'SpotLight': case 'AmbientLight': return { icon: 'light_mode', cls: 'light' };
        case 'PerspectiveCamera': case 'OrthographicCamera': return { icon: 'videocam', cls: 'camera' };
        default: return { icon: 'circle', cls: 'object' };
    }
}

function getTypeBadge(type) {
    return type.replace('Perspective','P').replace('Orthographic','O').replace('Directional','Dir').replace('Skinned','Sk');
}

// ============================================================
// Node Tree Rendering
// ============================================================
function renderNodeTree() {
    if (!state.model) return;
    dom.nodeTreeContainer.innerHTML = '';
    dom.nodeTreeContainer.appendChild(createTreeNodeElement(state.model, 0));
}

function createTreeNodeElement(node, depth) {
    const container = document.createElement('div');
    container.className = 'tree-node';
    const hasChildren = node.children && node.children.length > 0;
    const iconInfo = getNodeIcon(node.type);
    const name = node.name || '[unnamed]';

    const row = document.createElement('div');
    row.className = 'tree-node-row';
    row.style.paddingLeft = `${depth * 4 + 4}px`;
    row.dataset.uuid = node.uuid;

    const toggle = document.createElement('span');
    toggle.className = `material-icons-round tree-toggle ${!hasChildren ? 'no-children' : ''}`;
    toggle.textContent = 'expand_more';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'tree-checkbox';
    checkbox.checked = state.checkedNodeUUIDs.has(node.uuid);
    checkbox.dataset.uuid = node.uuid;
    checkbox.addEventListener('change', (e) => {
        e.stopPropagation();
        if (e.target.checked) state.checkedNodeUUIDs.add(node.uuid);
        else state.checkedNodeUUIDs.delete(node.uuid);
        updateSelectionCount();
        updateAddJointButton();
    });

    const icon = document.createElement('span');
    icon.className = `material-icons-round tree-icon ${iconInfo.cls}`;
    icon.textContent = iconInfo.icon;

    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = name;
    label.title = `${name} (${node.type})`;

    const badge = document.createElement('span');
    badge.className = 'tree-type-badge';
    badge.textContent = getTypeBadge(node.type);

    row.appendChild(toggle);
    row.appendChild(checkbox);
    row.appendChild(icon);
    row.appendChild(label);
    row.appendChild(badge);
    container.appendChild(row);

    row.addEventListener('click', (e) => {
        if (e.target === checkbox) return;
        e.stopPropagation();
        highlightNode(node.uuid);
    });
    toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!hasChildren) return;
        toggle.classList.toggle('collapsed');
        childrenEl.classList.toggle('collapsed');
    });

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

function updateSelectionCount() {
    const count = state.checkedNodeUUIDs.size;
    if (count > 0) {
        dom.selectionCount.textContent = `${count} selected`;
        dom.selectionCount.classList.remove('hidden');
    } else {
        dom.selectionCount.classList.add('hidden');
    }
}

function updateAddJointButton() {
    dom.btnAddJoint.disabled = state.checkedNodeUUIDs.size === 0;
}

// ============================================================
// 3D Highlight
// ============================================================
let highlightOutlines = [];

function highlightNode(uuid) {
    highlightOutlines.forEach(h => state.scene.remove(h));
    highlightOutlines = [];
    const node = state.nodeMap.get(uuid);
    if (!node) return;
    const box = new THREE.Box3().setFromObject(node);
    if (box.isEmpty()) return;
    const helper = new THREE.Box3Helper(box, new THREE.Color(0x6366f1));
    state.scene.add(helper);
    highlightOutlines.push(helper);
    setTimeout(() => {
        state.scene.remove(helper);
        highlightOutlines = highlightOutlines.filter(h2 => h2 !== helper);
    }, 3000);
}

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
    setTimeout(() => { highlightOutlines.forEach(h => state.scene.remove(h)); highlightOutlines = []; }, 3000);
}

// ============================================================
// Stats
// ============================================================
function updateStats() {
    let vertices = 0, meshes = 0, nodes = 0;
    if (state.model) {
        state.model.traverse((node) => {
            nodes++;
            if (node.isMesh) {
                meshes++;
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
// Joint System
// ============================================================
function openAddJointModal() {
    if (state.checkedNodeUUIDs.size === 0) return;

    dom.modalLinkedNodes.innerHTML = '';
    for (const uuid of state.checkedNodeUUIDs) {
        const info = state.nodeList.find(n => n.uuid === uuid);
        if (!info) continue;
        const chip = document.createElement('span');
        chip.className = 'linked-node-chip';
        chip.innerHTML = `<span class="material-icons-round">link</span>${escapeHtml(info.name)}`;
        dom.modalLinkedNodes.appendChild(chip);
    }

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

    // Reset defaults
    dom.jointName.value = '';
    dom.jointType.value = 'revolute';
    dom.jointProperty.value = 'rotation.y';
    dom.jointSimPattern.value = 'none';
    dom.jointSimFreq.value = '3';
    dom.coupledGroup.style.display = 'none';
    if (dom.pivotManualGroup) dom.pivotManualGroup.style.display = 'none';
    updateMinMaxDefaults();
    updateSimFreqVisibility();
    updatePivotVisibility();

    // Populate coupled target dropdown
    dom.jointCoupledTarget.innerHTML = '<option value="">-- เลือก Joint ต้นทาง --</option>';
    for (const j of state.joints) {
        const opt = document.createElement('option');
        opt.value = j.id;
        opt.textContent = j.name;
        dom.jointCoupledTarget.appendChild(opt);
    }

    // Show/hide coupled config when type changes
    dom.jointType.onchange = () => {
        const isContinuous = dom.jointType.value === 'continuous';
        const isCoupled = dom.jointType.value === 'coupled';
        dom.coupledGroup.style.display = isCoupled ? 'flex' : 'none';
        if (isContinuous) {
            dom.jointMin.value = '0';
            dom.jointMax.value = '6.28'; // 2π — speed in rad/s
            dom.jointStep.value = '0.01';
        } else {
            updateMinMaxDefaults();
        }
    };

    dom.modalOverlay.classList.remove('hidden');
    dom.jointName.focus();
}

function updateMinMaxDefaults() {
    const prop = dom.jointProperty.value;
    if (prop.startsWith('rotation')) {
        dom.jointMin.value = '-3.14';
        dom.jointMax.value = '3.14';
        dom.jointStep.value = '0.01';
    } else if (prop.startsWith('position')) {
        dom.jointMin.value = '-5';
        dom.jointMax.value = '5';
        dom.jointStep.value = '0.01';
    } else if (prop === 'visible') {
        dom.jointMin.value = '0';
        dom.jointMax.value = '1';
        dom.jointStep.value = '1';
    }
}

function updateSimFreqVisibility() {
    dom.simFreqGroup.style.display = dom.jointSimPattern.value === 'none' ? 'none' : 'flex';
}

function updatePivotVisibility() {
    // แสดง pivot dropdown เฉพาะเมื่อเลือกหลาย node และไม่ใช่ visible
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

function closeModal() {
    dom.modalOverlay.classList.add('hidden');
}

// ============================================================
// Pivot helper: use bounding box center — works for ALL model types
// (files where node.position=0 and geometry is baked into vertices)
// ============================================================
function getNodeCenter(node) {
    state.model.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(node);
    if (!box.isEmpty()) {
        const c = new THREE.Vector3();
        box.getCenter(c);
        return c;
    }
    // fallback for empty groups
    const wp = new THREE.Vector3();
    node.getWorldPosition(wp);
    return wp;
}

function addJoint() {
    const name = dom.jointName.value.trim() || `Joint ${state.jointIdCounter + 1}`;
    const nodeUUIDs = [...state.checkedNodeUUIDs];
    const property = dom.jointProperty.value;
    const min = parseFloat(dom.jointMin.value);
    const max = parseFloat(dom.jointMax.value);
    const step = parseFloat(dom.jointStep.value);
    const simPattern = dom.jointSimPattern.value;
    const simPeriod = parseFloat(dom.jointSimFreq.value);
    const jointType = dom.jointType.value;                          // NEW
    const coupledTarget = dom.jointCoupledTarget.value || null;     // NEW
    const coupledRatio = parseFloat(dom.jointCoupledRatio.value) || 1; // NEW

    if (nodeUUIDs.length === 0) return;

    const baseValues = new Map();
    for (const uuid of nodeUUIDs) {
        const node = state.nodeMap.get(uuid);
        if (node) baseValues.set(uuid, getNodePropertyValue(node, property));
    }

    let pivotGroup = null;
    let pivotBasePosition = null;
    const originalParentData = new Map();
    const pivotNodeUUID = dom.jointPivotNode.value;
    const usesPivot = property !== 'visible' && (
        nodeUUIDs.length > 1 ||
        pivotNodeUUID === 'manual' ||
        pivotNodeUUID !== 'centroid'
    );

    if (usesPivot) {
        pivotGroup = new THREE.Group();
        pivotGroup.name = `__joint_pivot_${state.jointIdCounter}`;

        // ── FIX: use bounding box center (works for ALL model types) ──
        // คำนวณตำแหน่ง pivot ตามโหมดที่ user เลือก
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
            // Centroid auto: bounding box center เฉลี่ยของทุก node ที่เลือก
            let count = 0;
            for (const uuid of nodeUUIDs) {
                const node = state.nodeMap.get(uuid);
                if (node) { centroid.add(getNodeCenter(node)); count++; }
            }
            if (count > 0) centroid.divideScalar(count);
        }

        // ── FIX: add to scene (not model) so model scale doesn't corrupt pivot ──
        state.scene.add(pivotGroup);
        pivotGroup.position.copy(centroid);
        pivotGroup.updateWorldMatrix(true, false);
        pivotBasePosition = pivotGroup.position.clone();

        const selectedSet = new Set(nodeUUIDs);
        const topmostUUIDs = nodeUUIDs.filter(uuid => {
            const node = state.nodeMap.get(uuid);
            if (!node) return false;
            let p = node.parent;
            while (p) {
                if (selectedSet.has(p.uuid)) return false;
                p = p.parent;
            }
            return true;
        });

        for (const uuid of topmostUUIDs) {
            const node = state.nodeMap.get(uuid);
            if (node && node.parent) {
                originalParentData.set(uuid, { parent: node.parent });
                node.updateWorldMatrix(true, false);
                pivotGroup.updateWorldMatrix(true, false);
                pivotGroup.attach(node);
            }
        }
    }

    const joint = {
        id: `joint_${state.jointIdCounter++}`,
        name,
        nodeUUIDs,
        property,
        min, max, step,
        value: 0,
        baseValues,
        pivotGroup,
        pivotBasePosition,
        originalParentData,
        simPattern,
        simPeriod,
        jointType,       // NEW
        coupledTarget,   // NEW
        coupledRatio,    // NEW
        _pivotNodeUUID: dom.jointPivotNode.value,
    };

    state.joints.push(joint);
    updatePresetControls();
    updateAnimControls();
    closeModal();

    state.checkedNodeUUIDs.clear();
    updateSelectionCount();
    updateAddJointButton();
    uncheckAllTreeCheckboxes();
    markBoundNodes();
    renderJoints();
}

function removeJoint(jointId) {
    const idx = state.joints.findIndex(j => j.id === jointId);
    if (idx === -1) return;
    const joint = state.joints[idx];

    if (joint.pivotGroup) {
        joint.pivotGroup.rotation.set(0, 0, 0);
        if (joint.pivotBasePosition) joint.pivotGroup.position.copy(joint.pivotBasePosition);
        joint.pivotGroup.updateWorldMatrix(true, true);

        for (const [uuid, origData] of joint.originalParentData) {
            const node = state.nodeMap.get(uuid);
            if (node && origData.parent) origData.parent.attach(node);
        }
        if (joint.pivotGroup.parent) joint.pivotGroup.parent.remove(joint.pivotGroup);
    } else {
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

function getNodePropertyValue(node, property) {
    const [prop, axis] = property.split('.');
    if (prop === 'visible') return node.visible ? 1 : 0;
    return node[prop][axis];
}

function setNodePropertyValue(node, property, value) {
    const [prop, axis] = property.split('.');
    if (prop === 'visible') { node.visible = value >= 0.5; return; }
    node[prop][axis] = value;
}

function applyJointValue(joint, value) {
    // Continuous joints spin freely — no clamping
    const clamped = (joint.jointType === 'continuous')
        ? value
        : Math.min(joint.max, Math.max(joint.min, value));

    joint.value = clamped;

    if (joint.pivotGroup) {
        const [prop, axis] = joint.property.split('.');
        // Reset every frame to prevent drift
        joint.pivotGroup.position.copy(joint.pivotBasePosition);
        joint.pivotGroup.rotation.set(0, 0, 0);
        if (prop === 'rotation') joint.pivotGroup.rotation[axis] = clamped;
        else if (prop === 'position') joint.pivotGroup.position[axis] += clamped;
    } else {
        for (const uuid of joint.nodeUUIDs) {
            const node = state.nodeMap.get(uuid);
            if (!node) continue;
            if (joint.property === 'visible') {
                setNodePropertyValue(node, joint.property, clamped);
            } else {
                const baseVal = joint.baseValues?.get(uuid) ?? 0;
                setNodePropertyValue(node, joint.property, baseVal + clamped);
            }
        }
    }
}

// ── Sync slider + number input + degree display + limit warning ──
function syncJointUI(joint, value) {
    const slider  = document.getElementById(`slider-${joint.id}`);
    const numEl   = document.getElementById(`num-${joint.id}`);
    const valEl   = document.getElementById(`val-${joint.id}`);
    const degEl   = document.getElementById(`deg-${joint.id}`);
    const cardEl  = document.getElementById(`card-${joint.id}`);
    const limitEl = document.getElementById(`limit-${joint.id}`);

    if (slider) slider.value = value;
    if (numEl)  numEl.value  = value.toFixed(3);
    if (valEl)  valEl.textContent = value.toFixed(3);
    if (degEl && joint.property.startsWith('rotation')) {
        degEl.textContent = `${(value * 180 / Math.PI).toFixed(1)}°`;
    }
    if (cardEl) cardEl.classList.toggle('simulating', state.simRunning);

    // Limit warning: orange icon when >90% of range
    if (limitEl && joint.jointType !== 'continuous') {
        const range = joint.max - joint.min;
        const pct = range > 0 ? Math.abs(value - joint.min) / range : 0;
        limitEl.style.display = pct >= 0.9 ? 'inline-flex' : 'none';
    }
}

function uncheckAllTreeCheckboxes() {
    document.querySelectorAll('.tree-checkbox').forEach(cb => { cb.checked = false; });
}

function markBoundNodes() {
    document.querySelectorAll('.tree-node-row.bound').forEach(el => el.classList.remove('bound'));
    const allBound = new Set();
    for (const joint of state.joints) for (const uuid of joint.nodeUUIDs) allBound.add(uuid);
    allBound.forEach(uuid => {
        const row = document.querySelector(`.tree-node-row[data-uuid="${uuid}"]`);
        if (row) row.classList.add('bound');
    });
}

// ============================================================
// Joint Rendering
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
        const nodeNames = joint.nodeUUIDs.map(uuid => {
            const info = state.nodeList.find(n => n.uuid === uuid);
            return info ? info.name : '?';
        });
        const isRotation = joint.property.startsWith('rotation');
        const isContinuous = joint.jointType === 'continuous';

        const card = document.createElement('div');
        card.className = 'joint-card';
        card.id = `card-${joint.id}`;
        if (joint.simPattern !== 'none') card.classList.add('has-sim');

        const degDisplay = isRotation
            ? `<span class="joint-deg-display" id="deg-${joint.id}">${(joint.value * 180 / Math.PI).toFixed(1)}°</span>`
            : '';

        const simBadge = joint.simPattern !== 'none'
            ? `<span class="joint-badge sim-badge"><span class="material-icons-round">sensors</span>${joint.simPattern} (${joint.simPeriod}s)</span>`
            : '';

        const typeBadge = (joint.jointType && joint.jointType !== 'revolute')
            ? `<span class="joint-badge type-badge"><span class="material-icons-round">rotate_right</span>${joint.jointType}</span>`
            : '';

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

        // Slider
        const slider = card.querySelector(`#slider-${joint.id}`);
        slider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            applyJointValue(joint, val);
            syncJointUI(joint, joint.value);
        });

        // Number input (type exact value)
        const numInput = card.querySelector(`#num-${joint.id}`);
        numInput.addEventListener('change', (e) => {
            const val = parseFloat(e.target.value);
            if (!isNaN(val)) {
                applyJointValue(joint, val);
                syncJointUI(joint, joint.value);
                if (slider) slider.value = joint.value;
            }
        });

        // Step buttons +/−
        card.querySelectorAll('.btn-step').forEach(btn => {
            btn.addEventListener('click', () => {
                const dir = parseFloat(btn.dataset.dir);
                applyJointValue(joint, joint.value + dir * joint.step);
                syncJointUI(joint, joint.value);
                if (slider) slider.value = joint.value;
            });
        });

        // Reset
        card.querySelector('.btn-reset-joint').addEventListener('click', () => {
            applyJointValue(joint, 0);
            syncJointUI(joint, 0);
            if (slider) slider.value = 0;
        });

        // Remove
        card.querySelector('.remove-joint').addEventListener('click', () => removeJoint(joint.id));

        // Highlight nodes
        card.querySelector('.show-nodes').addEventListener('click', (e) => {
            highlightMultipleNodes(e.currentTarget.dataset.nodes.split(','));
        });
    }
}

// ============================================================
// Tab Switching
// ============================================================
function switchTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabId);
    });
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.toggle('hidden', content.id !== tabId);
    });
}

// ============================================================
// Presets
// ============================================================
function savePreset() {
    if (state.joints.length === 0) return;
    const name = prompt('Preset name:', `State ${state.presetIdCounter + 1}`);
    if (name === null) return;
    const finalName = name.trim() || `State ${state.presetIdCounter + 1}`;
    const values = {};
    for (const joint of state.joints) values[joint.id] = joint.value;
    state.presets.push({
        id: `preset_${state.presetIdCounter++}`,
        name: finalName,
        values,
        savedAt: new Date().toLocaleTimeString(),
        jointCount: state.joints.length,
    });
    renderPresets();
}

function loadPreset(preset) {
    for (const joint of state.joints) {
        const val = preset.values[joint.id] ?? 0;
        applyJointValue(joint, val);
        syncJointUI(joint, joint.value);
    }
}

function deletePreset(id) {
    state.presets = state.presets.filter(p => p.id !== id);
    renderPresets();
}

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
                <button class="btn btn-danger btn-icon btn-del-preset">
                    <span class="material-icons-round" style="font-size:16px;">delete</span>
                </button>
            </div>`;
        card.querySelector('.btn-load-preset').addEventListener('click', () => loadPreset(preset));
        card.querySelector('.btn-del-preset').addEventListener('click', () => deletePreset(preset.id));
        dom.presetsContainer.appendChild(card);
    });
}

function updatePresetControls() {
    if (dom.btnSavePreset) dom.btnSavePreset.disabled = state.joints.length === 0;
    if (dom.btnExportProject) dom.btnExportProject.disabled =
        state.joints.length === 0 && state.presets.length === 0 && state.keyframes.length === 0;
}

// ============================================================
// Project Export / Import
// ============================================================
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
            baseValues: j.baseValues ? Object.fromEntries(j.baseValues) : {},
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

function importProject(file) {
    if (!state.model) { alert('Please load a 3D model first, then import the project file.'); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);
            if (!data.version || !Array.isArray(data.joints)) { alert('Invalid project file.'); return; }

            const ids = state.joints.map(j => j.id);
            for (const id of ids) removeJoint(id);

            if (data.jointIdCounter) state.jointIdCounter = data.jointIdCounter;
            if (data.presetIdCounter) state.presetIdCounter = data.presetIdCounter;
            if (data.keyframeIdCounter) state.keyframeIdCounter = data.keyframeIdCounter;

            let failed = 0;
            for (const cfg of data.joints) { if (!importJoint(cfg)) failed++; }

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

function importJoint(cfg) {
    const nameToNode = new Map();
    for (const [, node] of state.nodeMap) { if (node.name) nameToNode.set(node.name, node); }

    const nodeNames = cfg.nodeNames || [];
    const resolvedNodes = [];
    for (let i = 0; i < nodeNames.length; i++) {
        const name = nodeNames[i];
        const node = name ? nameToNode.get(name) : state.nodeMap.get(cfg.nodeUUIDs?.[i]);
        if (!node) return false;
        resolvedNodes.push(node);
    }
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
        const centroid = new THREE.Vector3();
        const pivotNodeName = cfg.pivotNodeName || 'centroid';
        if (pivotNodeName !== 'centroid') {
            const pn = nameToNode.get(pivotNodeName);
            if (pn) centroid.copy(getNodeCenter(pn));
            else { let c = 0; for (const n of resolvedNodes) { centroid.add(getNodeCenter(n)); c++; } if (c > 0) centroid.divideScalar(c); }
        } else {
            let c = 0;
            for (const n of resolvedNodes) { centroid.add(getNodeCenter(n)); c++; }
            if (c > 0) centroid.divideScalar(c);
        }

        pivotGroup = new THREE.Group();
        pivotGroup.name = `__pivot_${cfg.id}`;
        state.scene.add(pivotGroup);
        pivotGroup.position.copy(centroid);
        pivotGroup.updateWorldMatrix(true, false);
        pivotBasePosition = pivotGroup.position.clone();

        const selectedSet = new Set(nodeUUIDs);
        const topmostNodes = resolvedNodes.filter(node => {
            let p = node.parent;
            while (p) { if (selectedSet.has(p.uuid)) return false; p = p.parent; }
            return true;
        });

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
        baseValues = new Map();
        const byName = cfg.baseValuesByName || {};
        for (const node of resolvedNodes) {
            const saved = byName[node.name] ?? cfg.baseValues?.[node.uuid];
            baseValues.set(node.uuid, saved !== undefined ? saved : getNodePropertyValue(node, cfg.property));
        }
    }

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
    };

    state.joints.push(joint);
    applyJointValue(joint, cfg.value || 0);
    return true;
}

// ============================================================
// Keyframe Animation
// ============================================================
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

function deleteKeyframe(id) {
    state.keyframes = state.keyframes.filter(kf => kf.id !== id);
    if (state.keyframes.length < 2) stopAnimationPlayback();
    renderKeyframes();
    updateAnimControls();
    updateTimecodeDisplay();
}

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

        item.querySelector('.keyframe-time-input').addEventListener('change', (e) => {
            kf.time = parseFloat(e.target.value) || 0;
            state.keyframes.sort((a, b) => a.time - b.time);
            renderKeyframes(); updateTimecodeDisplay();
        });
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

function updateAnimControls() {
    if (dom.btnAddKeyframe) dom.btnAddKeyframe.disabled = state.joints.length === 0;
    if (dom.btnPlayAnim) dom.btnPlayAnim.disabled = state.keyframes.length < 2;
}

function getTotalDuration() {
    if (state.keyframes.length < 2) return 0;
    return Math.max(...state.keyframes.map(kf => kf.time));
}

function updateTimecodeDisplay() {
    if (dom.animTimecode) dom.animTimecode.textContent = `0.00s / ${getTotalDuration().toFixed(2)}s`;
}

function playAnimationPlayback() {
    if (state.keyframes.length < 2) return;
    state.animPlaying = true;
    state.animStartTime = performance.now() / 1000;
    dom.btnPlayAnim.classList.add('running');
    dom.btnPlayAnim.querySelector('.material-icons-round').textContent = 'pause';
    dom.animTimecode.classList.add('playing');
    if (state.simRunning) stopSimulation();
}

function stopAnimationPlayback() {
    state.animPlaying = false;
    if (dom.btnPlayAnim) {
        dom.btnPlayAnim.classList.remove('running');
        dom.btnPlayAnim.querySelector('.material-icons-round').textContent = 'play_arrow';
    }
    if (dom.animTimecode) dom.animTimecode.classList.remove('playing');
    document.querySelectorAll('.keyframe-item.active-kf').forEach(el => el.classList.remove('active-kf'));
}

function toggleAnimationPlayback() {
    if (state.animPlaying) stopAnimationPlayback();
    else playAnimationPlayback();
}

function updateAnimationPlayback() {
    const kfs = [...state.keyframes].sort((a, b) => a.time - b.time);
    const totalDuration = kfs[kfs.length - 1].time;
    if (totalDuration <= 0) { stopAnimationPlayback(); return; }

    const now = performance.now() / 1000;
    let elapsed = now - state.animStartTime;

    if (elapsed >= totalDuration) {
        if (state.animLoop) {
            state.animStartTime += totalDuration;
            elapsed = elapsed % totalDuration;
        } else {
            applyKeyframeValues(kfs[kfs.length - 1]);
            stopAnimationPlayback();
            if (dom.animTimecode) dom.animTimecode.textContent = `${totalDuration.toFixed(2)}s / ${totalDuration.toFixed(2)}s`;
            return;
        }
    }

    let kfA = kfs[0], kfB = kfs[1];
    for (let i = 0; i < kfs.length - 1; i++) {
        if (elapsed >= kfs[i].time && elapsed <= kfs[i + 1].time) { kfA = kfs[i]; kfB = kfs[i + 1]; break; }
    }

    const segDur = kfB.time - kfA.time;
    const alpha = segDur > 0 ? (elapsed - kfA.time) / segDur : 1;

    for (const joint of state.joints) {
        const valA = kfA.values[joint.id] ?? 0;
        const valB = kfB.values[joint.id] ?? 0;
        const val = valA + (valB - valA) * alpha;
        applyJointValue(joint, val);
        syncJointUI(joint, joint.value);
    }

    if (dom.animTimecode) dom.animTimecode.textContent = `${elapsed.toFixed(2)}s / ${totalDuration.toFixed(2)}s`;
    document.querySelectorAll('.keyframe-item').forEach(el => el.classList.remove('active-kf'));
    const activeEl = document.getElementById(`kf-item-${kfA.id}`);
    if (activeEl) activeEl.classList.add('active-kf');
}

function applyKeyframeValues(kf) {
    for (const joint of state.joints) {
        const val = kf.values[joint.id] ?? 0;
        applyJointValue(joint, val);
        syncJointUI(joint, joint.value);
    }
}

// ============================================================
// Sensor Simulation
// ============================================================
function startSimulation() {
    state.simRunning = true;
    state.simStartTime = performance.now() / 1000;
    dom.btnSimToggle.classList.add('running');
    dom.btnSimToggle.querySelector('.material-icons-round').textContent = 'pause';
    dom.btnSimToggle.title = 'Pause Simulation';
    dom.simStatus.className = 'sim-status active';
    dom.simStatus.innerHTML = '<span class="sim-dot"></span>Simulating';
}

function stopSimulation() {
    state.simRunning = false;
    if (!dom.btnSimToggle) return;
    dom.btnSimToggle.classList.remove('running');
    dom.btnSimToggle.querySelector('.material-icons-round').textContent = 'play_arrow';
    dom.btnSimToggle.title = 'Start Simulation';
    dom.simStatus.className = 'sim-status';
    dom.simStatus.innerHTML = '<span class="sim-dot"></span>Idle';
}

function toggleSimulation() {
    if (state.simRunning) stopSimulation();
    else startSimulation();
}

function updateSimulation() {
    const now = performance.now() / 1000;
    const elapsed = (now - state.simStartTime) * state.simSpeed;

    for (const joint of state.joints) {

        // ── Coupled: follow another joint × ratio ──
        if (joint.jointType === 'coupled') {
            if (joint.coupledTarget) {
                const source = state.joints.find(j => j.id === joint.coupledTarget);
                if (source) {
                    const val = source.value * (joint.coupledRatio ?? 1);
                    applyJointValue(joint, val);
                    syncJointUI(joint, joint.value);
                }
            }
            continue;
        }

        if (joint.simPattern === 'none') continue;

        const t = elapsed / joint.simPeriod;
        const range = joint.max - joint.min;
        let normalized = 0;

        switch (joint.simPattern) {
            case 'sine':     normalized = (Math.sin(t * Math.PI * 2) + 1) / 2; break;
            case 'triangle': normalized = 1 - Math.abs(((t % 1) * 2) - 1);    break;
            case 'sawtooth': normalized = t % 1;                                break;
            case 'square':   normalized = (t % 1) < 0.5 ? 0 : 1;              break;
            case 'random':   normalized = (Math.sin(t * 7.13) * Math.cos(t * 3.71) + 1) / 2; break;
        }

        // ── Continuous: spin forever using elapsed time × speed ──
        let value;
        if (joint.jointType === 'continuous') {
            value = elapsed * (joint.max > 0 ? joint.max : 1);
        } else {
            value = joint.min + normalized * range;
        }

        applyJointValue(joint, value);
        syncJointUI(joint, joint.value);
    }
}

// ============================================================
// Helpers
// ============================================================
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function truncate(str, len) {
    return str.length > len ? str.substring(0, len) + '…' : str;
}

// ============================================================
// Event Bindings
// ============================================================
function bindEvents() {
    dom.btnUpload.addEventListener('click', () => dom.fileInput.click());
    dom.fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) loadModel(file);
        e.target.value = '';
    });

    dom.viewportContainer.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    dom.viewportContainer.addEventListener('drop', (e) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (file && (file.name.endsWith('.glb') || file.name.endsWith('.gltf'))) loadModel(file);
    });

    dom.btnAddJoint.addEventListener('click', openAddJointModal);
    dom.modalClose.addEventListener('click', closeModal);
    dom.modalCancel.addEventListener('click', closeModal);
    dom.modalConfirm.addEventListener('click', addJoint);

    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
    dom.modalOverlay.addEventListener('click', (e) => { if (e.target === dom.modalOverlay) closeModal(); });

    dom.jointProperty.addEventListener('change', () => { updateMinMaxDefaults(); updatePivotVisibility(); });
    dom.jointSimPattern.addEventListener('change', updateSimFreqVisibility);

    dom.btnSimToggle.addEventListener('click', toggleSimulation);
    dom.simSpeedSlider.addEventListener('input', (e) => {
        state.simSpeed = parseFloat(e.target.value);
        dom.simSpeedVal.textContent = `${state.simSpeed.toFixed(1)}x`;
    });

    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    dom.btnExportProject.addEventListener('click', exportProject);
    dom.btnImportProject.addEventListener('click', () => dom.projectFileInput.click());
    dom.projectFileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) importProject(file);
        e.target.value = '';
    });

    dom.btnSavePreset.addEventListener('click', savePreset);
    dom.btnAddKeyframe.addEventListener('click', addKeyframe);
    dom.btnPlayAnim.addEventListener('click', toggleAnimationPlayback);
    dom.animLoopChk.addEventListener('change', (e) => { state.animLoop = e.target.checked; });
}

// ============================================================
// Initialize
// ============================================================
function init() {
    initThree();
    bindEvents();
}

init();