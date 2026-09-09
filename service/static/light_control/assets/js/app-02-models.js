// 3D models, interaction handlers, and animation loop.

function refreshLayoutChrome() {
  const toggleBtn = document.getElementById('layout-toggle-btn');
  if (toggleBtn) {
    toggleBtn.textContent = layoutMode ? '退出编辑' : '布局编辑';
    toggleBtn.className = 'btn ' + (layoutMode ? 'btn-primary' : 'btn-ghost');
  }
  ['select', 'wall', 'zone'].forEach(tool => {
    const btn = document.getElementById('tool-' + tool);
    if (!btn) return;
    btn.disabled = !layoutMode;
    btn.classList.toggle('active', layoutTool === tool);
  });
  const saveBtn = document.getElementById('layout-save-btn');
  if (saveBtn) saveBtn.textContent = layoutDirty ? '保存布局' : '布局已保存';
  const delBtn = document.getElementById('layout-del-btn');
  if (delBtn) delBtn.disabled = !selectedLayout;

  const statusEl = document.getElementById('layout-status');
  if (statusEl) {
    ensureLayoutConfig();
    statusEl.textContent = '墙体 ' + config.layout.walls.length +
      ' · 区域 ' + config.layout.zones.length +
      ' · ' + (layoutDirty ? '未保存' : '已保存') +
      ' · ' + (layoutMode ? '编辑中' : '浏览中');
  }

  const helpEl = document.getElementById('layout-help');
  if (helpEl) {
    if (!layoutMode) {
      helpEl.textContent = '开启布局编辑后，在场景地面拖拽即可修建墙体或框选区域。';
    } else if (layoutTool === 'select') {
      helpEl.textContent = '当前是选择工具。点击墙体或区域可选中，并在下方修改属性。';
    } else if (layoutTool === 'wall') {
      helpEl.textContent = '当前是画墙工具。按住地面拖拽一段距离，松开即可生成墙体。';
    } else {
      helpEl.textContent = '当前是画区域工具。拖出矩形后即可给这片区域命名。';
    }
  }
  updateSceneHint();
  updateCanvasCursor();
}

function updateLayoutUI() {
  refreshLayoutChrome();
  renderLayoutList();
  renderLayoutInspector();
}

async function saveLayout() {
  const r = await saveConfigData();
  if (!r.ok) alert('布局保存失败: ' + (r.error || '未知错误'));
}

function deleteSelectedLayout() {
  if (!selectedLayout) return;
  const list = getLayoutCollection(selectedLayout.kind);
  const idx = list.findIndex(item => item.id === selectedLayout.id);
  if (idx < 0) return;
  list.splice(idx, 1);
  selectedLayout = null;
  clearLayoutPreview();
  rebuildLayoutScene();
  setLayoutDirty(true);
}

function toggleLayoutMode(forceValue) {
  layoutMode = typeof forceValue === 'boolean' ? forceValue : !layoutMode;
  if (layoutMode && walkMode) toggleWalkMode(false);
  if (layoutMode && editMode) toggleEditMode(false);
  if (!layoutMode) {
    layoutDrawState = null;
    clearLayoutPreview();
  }
  updateLayoutUI();
}

function setLayoutTool(tool) {
  if (!layoutMode) return;
  layoutTool = tool;
  clearLayoutPreview();
  updateLayoutUI();
}

function buildWallPreview(start, end) {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const len = Math.hypot(dx, dz);
  if (len < 1.5) return null;
  const angle = Math.atan2(dx, dz);
  const cx = (start.x + end.x) / 2;
  const cz = (start.z + end.z) / 2;
  const group = new THREE.Group();
  group.position.set(cx, 0, cz);
  group.rotation.y = angle;
  const previewThickness = getLayoutWallThicknessBounds().value;
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(previewThickness, 12, len),
    new THREE.MeshStandardMaterial({
      color: 0xffb35c,
      transparent: true,
      opacity: 0.55
    })
  );
  mesh.position.y = 6;
  group.add(mesh);
  scene.add(group);
  return { group, textures: [] };
}

function buildZonePreview(start, end) {
  const width = Math.abs(end.x - start.x);
  const depth = Math.abs(end.z - start.z);
  if (width < 1.5 || depth < 1.5) return null;
  const cx = (start.x + end.x) / 2;
  const cz = (start.z + end.z) / 2;
  const group = new THREE.Group();
  const fill = new THREE.Mesh(
    new THREE.PlaneGeometry(width, depth),
    createFloorOverlayMaterial({
      color: new THREE.Color(LAYOUT_ZONE_COLOR),
      transparent: true,
      opacity: 0.2
    }, 'preview')
  );
  fill.rotation.x = -Math.PI / 2;
  applyFloorOverlayProfile(fill, FLOOR_LAYER.preview, 'preview');
  group.add(fill);
  scene.add(group);
  return { group, textures: [] };
}

function updateLayoutPreview() {
  clearLayoutPreview();
  if (!layoutDrawState) return;
  layoutPreview = layoutDrawState.tool === 'wall'
    ? buildWallPreview(layoutDrawState.start, layoutDrawState.current)
    : buildZonePreview(layoutDrawState.start, layoutDrawState.current);
}

function drawLabel(lamp, on) {
  const ctx = lamp.labelCanvas.getContext('2d');
  const meta = lamp.meta;
  ctx.clearRect(0, 0, lamp.labelCanvas.width, lamp.labelCanvas.height);

  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(8, 8, 240, 72, 14);
  ctx.fillStyle = on ? 'rgba(12,12,16,0.92)' : 'rgba(28,28,30,0.92)';
  ctx.strokeStyle = on ? meta.accent : '#48484a';
  ctx.fill();
  ctx.stroke();

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = on ? meta.accent : '#8e8e93';
  ctx.font = 'bold 14px sans-serif';
  ctx.fillText(meta.short, 22, 28);

  ctx.fillStyle = on ? '#ffffff' : '#d0d0d6';
  ctx.font = 'bold 24px sans-serif';
  ctx.fillText((lamp.name || meta.label).slice(0, 12), 22, 56);
  lamp.labelTex.needsUpdate = true;
}

// 同屏真实点光源预算: 灯具数量很多时(整屏网格可达数百盏)若每盏都发实光,
// 会超出 WebGL 片元着色器的光源上限, 造成渲染异常或严重掉帧。这里把"发实光"的灯
// 均匀抽样限制在上限内, 其余灯仍通过自发光面板 + 地面光斑表现"点亮"。
const LAMP_LIGHT_MAX = 48;
let _lampLightStride = 1;
let _lampLightSerial = 0;
let _lampLightEmitted = 0;
function setLampLightBudget(totalLamps) {
  const total = Math.max(0, Number(totalLamps) || 0);
  _lampLightStride = Math.max(1, Math.ceil(total / LAMP_LIGHT_MAX));
  _lampLightSerial = 0;
  _lampLightEmitted = 0;
}
function _lampLightShouldEmit() {
  const emit = (_lampLightSerial % _lampLightStride === 0) && (_lampLightEmitted < LAMP_LIGHT_MAX);
  _lampLightSerial += 1;
  if (emit) _lampLightEmitted += 1;
  return emit;
}

function buildLampModel(group, meta) {
  const panelW = 5, panelH = 0.15, panelD = 0.8;
  const frameMat = new THREE.MeshStandardMaterial({
    color: 0xcfd2d6, roughness: 0.4, metalness: 0.8,
    emissive: 0x000000, emissiveIntensity: 0
  });
  const diffMat = new THREE.MeshStandardMaterial({
    color: 0xf0f0f0, roughness: 0.3, metalness: 0,
    emissive: 0x000000, emissiveIntensity: 0
  });

  const frame = addMesh(group, new THREE.BoxGeometry(panelW, panelH, panelD), frameMat, [0, 9.85, 0]);
  const diff = addMesh(group, new THREE.PlaneGeometry(panelW - 0.15, panelD - 0.15), diffMat, [0, 9.85 - panelH / 2 - 0.002, 0], [Math.PI / 2, 0, 0], false);
  diff.castShadow = false;
  // 暖光点光源(灯具自身的真实光照)。受同屏光源预算控制: 数量很多时只有抽样到的灯发实光。
  let point = null;
  if (_lampLightShouldEmit()) {
    point = new THREE.PointLight(0xffe2a8, 0, 95, 1.5);
    point.position.y = 9.5;
    group.add(point);
  }

  const spot = new THREE.Mesh(
    new THREE.PlaneGeometry(panelW * 2.6, panelD * 8),
    new THREE.MeshBasicMaterial({
      color: 0xffe6b8,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2
    })
  );
  spot.rotation.x = -Math.PI / 2;
  applyFloorOverlayProfile(spot, FLOOR_LAYER.glow, 'glow');
  group.add(spot);

  return {
    mountY: 9.85,
    hit: { y: 9.85, w: panelW, h: 0.6, d: panelD },
    labelY: 8.45,
    applyState(state) {
      if (state) {
        diff.material.color.set(0xfff0c4);
        diff.material.emissive.set(0xffd58a);
        diff.material.emissiveIntensity = 3.4;
        frame.material.emissive.set(0xffd58a);
        frame.material.emissiveIntensity = 0.28;
        if (point) point.intensity = 7.2;
        spot.material.opacity = 0.6;
      } else {
        diff.material.color.set(0x3a3a3c);
        diff.material.emissive.set(0x000000);
        diff.material.emissiveIntensity = 0;
        frame.material.emissive.set(0x000000);
        frame.material.emissiveIntensity = 0;
        if (point) point.intensity = 0;
        spot.material.opacity = 0;
      }
    }
  };
}

function buildPrinterModel(group, meta) {
  let active = false;
  const hangerMat = new THREE.MeshStandardMaterial({ color: 0x8a8e92, roughness: 0.4, metalness: 0.8 });
  addMesh(group, new THREE.CylinderGeometry(0.05, 0.05, 0.75, 12), hangerMat, [0, 9.8, 0]);

  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0xe8edf2, roughness: 0.4, metalness: 0.18,
    emissive: 0x000000, emissiveIntensity: 0
  });
  const darkMat = new THREE.MeshStandardMaterial({
    color: 0x1c1c1e, roughness: 0.35, metalness: 0.6,
    emissive: 0x000000, emissiveIntensity: 0
  });
  const paperMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.92, metalness: 0,
    emissive: 0x000000, emissiveIntensity: 0
  });
  const ledMat = new THREE.MeshStandardMaterial({
    color: 0x44444a, roughness: 0.25, metalness: 0.1,
    emissive: 0x000000, emissiveIntensity: 0
  });

  const body = addMesh(group, new THREE.BoxGeometry(2.75, 1.35, 2.05), bodyMat, [0, 9.25, 0]);
  const lid = addMesh(group, new THREE.BoxGeometry(2.25, 0.18, 1.55), bodyMat, [0, 9.96, 0.04]);
  addMesh(group, new THREE.BoxGeometry(1.55, 0.1, 0.32), darkMat, [0, 9.48, 1.03]);
  const tray = addMesh(group, new THREE.BoxGeometry(1.8, 0.1, 0.82), bodyMat, [0, 8.78, 1.17], [-0.28, 0, 0]);
  const paper = addMesh(group, new THREE.BoxGeometry(1.3, 0.55, 0.04), paperMat, [0, 10.18, -0.08], [-0.22, 0, 0], false);
  const led = addMesh(group, new THREE.SphereGeometry(0.11, 16, 16), ledMat, [1.02, 9.42, 0.93]);
  const aura = createGlowSprite(meta.accentHex, 3.6, 2.6, 0.02);
  aura.position.y = 9.2;
  group.add(aura);

  return {
    hit: { y: 9.22, w: 3.5, h: 1.9, d: 2.6 },
    labelY: 7.05,
    applyState(state) {
      active = state;
      bodyMat.emissive.set(state ? 0x071018 : 0x000000);
      bodyMat.emissiveIntensity = state ? 0.08 : 0;
      darkMat.emissive.set(state ? meta.accentHex : 0x000000);
      darkMat.emissiveIntensity = state ? 0.08 : 0;
      paperMat.emissive.set(state ? meta.accentHex : 0x000000);
      paperMat.emissiveIntensity = state ? 0.1 : 0;
      ledMat.color.set(state ? meta.accentHex : 0x44444a);
      ledMat.emissive.set(state ? meta.accentHex : 0x000000);
      ledMat.emissiveIntensity = state ? 0.9 : 0;
      aura.material.opacity = state ? 0.14 : 0.02;
      if (!state) {
        paper.position.y = 10.18;
        tray.position.z = 1.17;
      }
    },
    tick(time) {
      if (!active) return;
      paper.position.y = 10.18 + Math.sin(time * 4.5) * 0.07;
      tray.position.z = 1.17 + Math.sin(time * 4.5) * 0.04;
      aura.material.opacity = 0.1 + (Math.sin(time * 9) + 1) * 0.03;
    }
  };
}

function buildFanModel(group, meta) {
  let active = false;
  const metalMat = new THREE.MeshStandardMaterial({
    color: 0xcfd4da, roughness: 0.28, metalness: 0.82,
    emissive: 0x000000, emissiveIntensity: 0
  });
  const bladeMat = new THREE.MeshStandardMaterial({
    color: 0xe7ebef, roughness: 0.35, metalness: 0.18,
    emissive: 0x000000, emissiveIntensity: 0
  });
  addMesh(group, new THREE.CylinderGeometry(0.05, 0.05, 0.75, 12), metalMat, [0, 9.82, 0]);
  addMesh(group, new THREE.CylinderGeometry(0.22, 0.28, 0.58, 18), metalMat, [0, 9.45, 0]);
  const hub = addMesh(group, new THREE.SphereGeometry(0.24, 18, 18), metalMat, [0, 9.0, 0]);

  const rotor = new THREE.Group();
  rotor.position.y = 9.0;
  group.add(rotor);
  for (let i = 0; i < 4; i++) {
    const blade = addMesh(rotor, new THREE.BoxGeometry(0.28, 0.05, 1.7), bladeMat, [0, 0, 0.85], [0, i * Math.PI / 2, 0]);
    blade.position.applyAxisAngle(new THREE.Vector3(0, 1, 0), i * Math.PI / 2);
  }
  const rim = addMesh(group, new THREE.TorusGeometry(1.45, 0.08, 12, 32), metalMat, [0, 9.0, 0], [Math.PI / 2, 0, 0]);
  const aura = createGlowSprite(meta.accentHex, 3.8, 3.8, 0.02);
  aura.position.y = 8.95;
  group.add(aura);

  return {
    mountY: 10.2,
    hit: { y: 9.1, w: 3.7, h: 1.9, d: 3.7 },
    labelY: 6.7,
    applyState(state) {
      active = state;
      metalMat.emissive.set(state ? meta.accentHex : 0x000000);
      metalMat.emissiveIntensity = state ? 0.08 : 0;
      rim.material.emissive.set(state ? meta.accentHex : 0x000000);
      rim.material.emissiveIntensity = state ? 0.05 : 0;
      bladeMat.color.set(state ? 0xffffff : 0xe7ebef);
      bladeMat.emissive.set(state ? meta.accentHex : 0x000000);
      bladeMat.emissiveIntensity = state ? 0.04 : 0;
      aura.material.opacity = state ? 0.14 : 0.02;
      if (!state) rotor.rotation.y = 0.45;
    },
    tick(time) {
      if (!active) return;
      rotor.rotation.y = time * 8.5;
      hub.rotation.y = time * 2;
      rim.material.emissiveIntensity = 0.05 + (Math.sin(time * 8) + 1) * 0.02;
      aura.material.opacity = 0.09 + (Math.sin(time * 12) + 1) * 0.03;
    }
  };
}

function buildSocketModel(group, meta) {
  const armMat = new THREE.MeshStandardMaterial({ color: 0x8a8e92, roughness: 0.4, metalness: 0.8 });
  addMesh(group, new THREE.CylinderGeometry(0.04, 0.04, 0.7, 10), armMat, [0, 9.72, 0.05]);

  const plateMat = new THREE.MeshStandardMaterial({
    color: 0xf4f4f6, roughness: 0.82, metalness: 0.04,
    emissive: 0x000000, emissiveIntensity: 0
  });
  const holeMat = new THREE.MeshStandardMaterial({ color: 0x1c1c1e, roughness: 0.35, metalness: 0.52 });
  const accentMat = new THREE.MeshStandardMaterial({
    color: 0x8e8e93, roughness: 0.2, metalness: 0.08,
    emissive: 0x000000, emissiveIntensity: 0
  });

  addMesh(group, new THREE.BoxGeometry(2.55, 3.15, 0.28), plateMat, [0, 9.05, 0]);
  addMesh(group, new THREE.CylinderGeometry(0.12, 0.12, 0.09, 18), holeMat, [-0.42, 9.36, 0.13], [Math.PI / 2, 0, 0]);
  addMesh(group, new THREE.CylinderGeometry(0.12, 0.12, 0.09, 18), holeMat, [0.42, 9.36, 0.13], [Math.PI / 2, 0, 0]);
  addMesh(group, new THREE.CylinderGeometry(0.1, 0.1, 0.09, 18), holeMat, [-0.42, 8.73, 0.13], [Math.PI / 2, 0, 0]);
  addMesh(group, new THREE.CylinderGeometry(0.1, 0.1, 0.09, 18), holeMat, [0.42, 8.73, 0.13], [Math.PI / 2, 0, 0]);
  const switchBase = addMesh(group, new THREE.BoxGeometry(0.72, 0.36, 0.18), accentMat, [0, 8.18, 0.15]);
  const led = addMesh(group, new THREE.SphereGeometry(0.1, 16, 16), accentMat, [0.88, 10.15, 0.16]);
  const aura = createGlowSprite(meta.accentHex, 3.4, 4.2, 0.02);
  aura.position.y = 9.02;
  group.add(aura);

  return {
    mountY: 9.05,
    hit: { y: 9.05, w: 2.8, h: 3.3, d: 0.8 },
    labelY: 6.95,
    applyState(state) {
      plateMat.emissive.set(state ? 0x2a1400 : 0x000000);
      plateMat.emissiveIntensity = state ? 0.05 : 0;
      accentMat.color.set(state ? meta.accentHex : 0x8e8e93);
      accentMat.emissive.set(state ? meta.accentHex : 0x000000);
      accentMat.emissiveIntensity = state ? 0.55 : 0;
      switchBase.position.y = state ? 8.24 : 8.18;
      led.scale.setScalar(state ? 1.2 : 1);
      aura.material.opacity = state ? 0.16 : 0.02;
    }
  };
}

function buildCameraModel(group, meta) {
  let active = false;
  const armMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.32, metalness: 0.82 });
  addMesh(group, new THREE.CylinderGeometry(0.04, 0.04, 0.45, 12), armMat, [0, 9.84, 0]);
  addMesh(group, new THREE.BoxGeometry(0.72, 0.08, 0.08), armMat, [0.34, 9.6, 0], [0, 0, 0.18]);
  addMesh(group, new THREE.SphereGeometry(0.11, 14, 14), armMat, [0.68, 9.49, 0]);

  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0xe9edf2, roughness: 0.28, metalness: 0.2,
    emissive: 0x000000, emissiveIntensity: 0
  });
  const hoodMat = new THREE.MeshStandardMaterial({
    color: 0x1c1c1e, roughness: 0.35, metalness: 0.6,
    emissive: 0x000000, emissiveIntensity: 0
  });
  const lensMat = new THREE.MeshStandardMaterial({
    color: 0x111114, roughness: 0.18, metalness: 0.88,
    emissive: 0x000000, emissiveIntensity: 0
  });
  const ledMat = new THREE.MeshStandardMaterial({
    color: 0x4a4a50, roughness: 0.2, metalness: 0.06,
    emissive: 0x000000, emissiveIntensity: 0
  });

  const camGroup = new THREE.Group();
  camGroup.position.set(1.05, 9.18, 0);
  camGroup.rotation.z = -0.22;
  group.add(camGroup);
  addMesh(camGroup, new THREE.BoxGeometry(1.45, 0.78, 0.84), bodyMat, [0, 0, 0]);
  addMesh(camGroup, new THREE.BoxGeometry(0.58, 0.42, 0.94), hoodMat, [0.78, 0, 0]);
  addMesh(camGroup, new THREE.CylinderGeometry(0.22, 0.28, 0.42, 20), lensMat, [1.02, 0, 0], [0, 0, Math.PI / 2]);
  addMesh(camGroup, new THREE.SphereGeometry(0.08, 12, 12), ledMat, [-0.52, 0.18, 0.42]);

  const beam = new THREE.Mesh(
    new THREE.ConeGeometry(0.72, 2.2, 28, 1, true),
    new THREE.MeshBasicMaterial({
      color: meta.accentHex,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
  );
  beam.position.set(2.02, 0, 0);
  beam.rotation.z = -Math.PI / 2;
  camGroup.add(beam);

  return {
    mountY: 9.18,
    hit: { y: 9.18, w: 3.8, h: 1.8, d: 1.6 },
    labelY: 7.0,
    applyState(state) {
      active = state;
      bodyMat.emissive.set(state ? 0x09090c : 0x000000);
      bodyMat.emissiveIntensity = state ? 0.12 : 0;
      hoodMat.emissive.set(state ? meta.accentHex : 0x000000);
      hoodMat.emissiveIntensity = state ? 0.12 : 0;
      lensMat.emissive.set(state ? meta.accentHex : 0x000000);
      lensMat.emissiveIntensity = state ? 0.16 : 0;
      ledMat.color.set(state ? meta.accentHex : 0x4a4a50);
      ledMat.emissive.set(state ? meta.accentHex : 0x000000);
      ledMat.emissiveIntensity = state ? 0.8 : 0;
      beam.material.opacity = state ? 0.08 : 0;
      if (!state) camGroup.rotation.y = 0;
    },
    tick(time) {
      if (!active) return;
      camGroup.rotation.y = Math.sin(time * 1.4) * 0.18;
      beam.material.opacity = 0.06 + (Math.sin(time * 6) + 1) * 0.02;
      beam.scale.set(1 + Math.sin(time * 2.8) * 0.04, 1, 1 + Math.sin(time * 2.8) * 0.04);
    }
  };
}

function buildAlarmModel(group, meta) {
  let active = false;
  const metalMat = new THREE.MeshStandardMaterial({ color: 0x8a8e92, roughness: 0.4, metalness: 0.82 });
  addMesh(group, new THREE.CylinderGeometry(0.05, 0.05, 0.55, 12), metalMat, [0, 9.84, 0]);

  const baseMat = new THREE.MeshStandardMaterial({
    color: 0xe8ebef, roughness: 0.4, metalness: 0.14,
    emissive: 0x000000, emissiveIntensity: 0
  });
  const domeMat = new THREE.MeshStandardMaterial({
    color: 0xc92b24, roughness: 0.22, metalness: 0.06,
    transparent: true, opacity: 0.92,
    emissive: 0x000000, emissiveIntensity: 0
  });
  addMesh(group, new THREE.CylinderGeometry(1.0, 1.0, 0.2, 24), baseMat, [0, 9.0, 0]);
  const dome = addMesh(group, new THREE.SphereGeometry(0.72, 24, 18, 0, Math.PI * 2, 0, Math.PI / 2), domeMat, [0, 9.09, 0]);
  addMesh(group, new THREE.TorusGeometry(0.88, 0.08, 12, 28), metalMat, [0, 9.03, 0], [Math.PI / 2, 0, 0]);
  const pulse = createGlowSprite(meta.accentHex, 3.2, 3.2, 0.02);
  pulse.position.y = 9.08;
  group.add(pulse);

  return {
    mountY: 9.1,
    hit: { y: 9.1, w: 2.5, h: 1.9, d: 2.5 },
    labelY: 7.0,
    applyState(state) {
      active = state;
      baseMat.emissive.set(state ? meta.accentHex : 0x000000);
      baseMat.emissiveIntensity = state ? 0.08 : 0;
      domeMat.emissive.set(state ? meta.accentHex : 0x000000);
      domeMat.emissiveIntensity = state ? 0.45 : 0;
      dome.material.opacity = state ? 0.96 : 0.92;
      pulse.material.opacity = state ? 0.14 : 0.02;
      if (!state) pulse.scale.set(3.2, 3.2, 1);
    },
    tick(time) {
      if (!active) return;
      const t = (Math.sin(time * 8) + 1) / 2;
      pulse.scale.set(3.1 + t * 0.9, 3.1 + t * 0.9, 1);
      pulse.material.opacity = 0.08 + t * 0.12;
      dome.material.opacity = 0.82 + t * 0.14;
    }
  };
}

function buildSmokeMachineModel(group, meta) {
  let active = false;
  const width = clamp(BUILDING.width / 15, 24, 56);
  const depth = clamp(BUILDING.depth / 15, 18, 42);
  const bodyH = clamp(Math.min(width, depth) * 0.54, 11, 18);
  const frameH = Math.max(1.1, bodyH * 0.08);
  const bodyY = frameH + bodyH / 2;
  const stackRadius = Math.max(1.1, Math.min(width, depth) * 0.08);
  const stackH = clamp(bodyH * 0.9, 8, 15);
  const stackTopY = frameH + bodyH + stackH;

  const baseMat = new THREE.MeshStandardMaterial({
    color: 0x3a434d, roughness: 0.82, metalness: 0.26,
    emissive: 0x000000, emissiveIntensity: 0
  });
  const shellMat = new THREE.MeshStandardMaterial({
    color: 0xaeb7bf, roughness: 0.34, metalness: 0.5,
    emissive: 0x000000, emissiveIntensity: 0
  });
  const darkMat = new THREE.MeshStandardMaterial({
    color: 0x20252a, roughness: 0.52, metalness: 0.62,
    emissive: 0x000000, emissiveIntensity: 0
  });
  const accentMat = new THREE.MeshStandardMaterial({
    color: meta.accentHex, roughness: 0.22, metalness: 0.14,
    emissive: 0x000000, emissiveIntensity: 0
  });

  addMesh(group, new THREE.BoxGeometry(width * 1.02, frameH, depth * 1.02), baseMat, [0, frameH / 2, 0]);
  addMesh(group, new THREE.BoxGeometry(width * 0.88, bodyH, depth * 0.78), shellMat, [0, bodyY, 0]);
  addMesh(group, new THREE.BoxGeometry(width * 0.82, bodyH * 0.72, depth * 0.18), darkMat, [0, bodyY + bodyH * 0.02, depth * 0.31]);
  addMesh(group, new THREE.BoxGeometry(width * 0.18, bodyH * 0.3, depth * 0.12), accentMat, [width * 0.23, bodyY + bodyH * 0.12, depth * 0.39]);
  addMesh(group, new THREE.BoxGeometry(width * 0.11, bodyH * 0.18, depth * 0.12), accentMat, [width * 0.08, bodyY - bodyH * 0.02, depth * 0.39]);

  const stackXs = [-width * 0.18, 0, width * 0.18];
  const smokePuffs = [];
  const smokeGroup = new THREE.Group();
  group.add(smokeGroup);

  stackXs.forEach(function(stackX, index) {
    addMesh(
      group,
      new THREE.CylinderGeometry(stackRadius, stackRadius * 1.08, stackH, 18),
      darkMat,
      [stackX, frameH + bodyH + stackH / 2, -depth * 0.08]
    );
    addMesh(
      group,
      new THREE.CylinderGeometry(stackRadius * 1.32, stackRadius * 1.18, bodyH * 0.08, 18),
      shellMat,
      [stackX, frameH + bodyH + stackH - bodyH * 0.02, -depth * 0.08]
    );

    const puff = createGlowSprite(meta.accentHex, width * 0.26, depth * 0.44, 0.02);
    puff.position.set(stackX, stackTopY + 1.8 + index * 1.4, -depth * 0.08);
    puff.material.color.setHex(0xdff7ff);
    puff.material.rotation = index * 0.4;
    smokeGroup.add(puff);
    smokePuffs.push({
      sprite: puff,
      offset: index * 0.8,
      x: stackX
    });
  });

  addMesh(group, new THREE.BoxGeometry(width * 0.1, bodyH * 0.48, depth * 0.1), baseMat, [-width * 0.4, frameH + bodyH * 0.24, depth * 0.34]);
  addMesh(group, new THREE.BoxGeometry(width * 0.1, bodyH * 0.48, depth * 0.1), baseMat, [width * 0.4, frameH + bodyH * 0.24, depth * 0.34]);
  addMesh(group, new THREE.BoxGeometry(width * 0.1, bodyH * 0.48, depth * 0.1), baseMat, [-width * 0.4, frameH + bodyH * 0.24, -depth * 0.34]);
  addMesh(group, new THREE.BoxGeometry(width * 0.1, bodyH * 0.48, depth * 0.1), baseMat, [width * 0.4, frameH + bodyH * 0.24, -depth * 0.34]);

  const glow = createGlowSprite(meta.accentHex, width * 0.92, depth * 0.92, 0.03);
  glow.position.set(0, frameH + 0.22, 0);
  glow.material.rotation = Math.PI / 4;
  group.add(glow);

  return {
    floorY: 0,
    hit: { y: frameH + bodyH * 0.55, w: width * 1.08, h: bodyH + stackH + 2, d: depth * 1.08 },
    labelY: frameH + bodyH + stackH + 5.2,
    applyState(state) {
      active = state;
      baseMat.emissive.set(state ? 0x163340 : 0x000000);
      baseMat.emissiveIntensity = state ? 0.18 : 0;
      shellMat.emissive.set(state ? 0x10242d : 0x000000);
      shellMat.emissiveIntensity = state ? 0.12 : 0;
      accentMat.emissive.set(state ? meta.accentHex : 0x000000);
      accentMat.emissiveIntensity = state ? 0.9 : 0;
      glow.material.opacity = state ? 0.1 : 0.03;
      smokePuffs.forEach(function(puff) {
        puff.sprite.material.opacity = state ? 0.12 : 0.02;
      });
    },
    tick(time) {
      smokePuffs.forEach(function(puff, index) {
        const wave = time * (active ? 0.95 : 0.28) + puff.offset;
        const rise = (Math.sin(wave) + 1) * 0.5;
        const drift = Math.cos(wave * 0.7) * width * 0.035;
        puff.sprite.position.set(
          puff.x + drift,
          stackTopY + 2.2 + rise * (active ? bodyH * 0.9 : bodyH * 0.28) + index * 0.45,
          -depth * 0.08 + Math.sin(wave * 0.8) * depth * 0.035
        );
        const scale = active ? 1 + rise * 0.75 : 0.82 + rise * 0.18;
        puff.sprite.scale.set(width * 0.24 * scale, depth * 0.42 * scale, 1);
        puff.sprite.material.opacity = active ? 0.08 + rise * 0.12 : 0.02 + rise * 0.02;
      });
      glow.material.opacity = active
        ? 0.06 + (Math.sin(time * 4.2) + 1) * 0.03
        : 0.02;
    }
  };
}

function buildItemModel(type, group, meta) {
  switch (type) {
    case 'printer': return buildPrinterModel(group, meta);
    case 'smoke_machine': return buildSmokeMachineModel(group, meta);
    case 'fan': return buildFanModel(group, meta);
    case 'socket': return buildSocketModel(group, meta);
    case 'camera': return buildCameraModel(group, meta);
    case 'alarm': return buildAlarmModel(group, meta);
    case 'lamp':
    default:
      return buildLampModel(group, meta);
  }
}

function createLamp(lightIdx, x, z, item) {
  const meta = getItemMeta(item.type);
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  const built = buildItemModel(item.type, group, meta);
  const hit = new THREE.Mesh(
    new THREE.BoxGeometry(built.hit.w, built.hit.h, built.hit.d),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  hit.position.y = built.hit.y;
  hit.userData.lightIdx = lightIdx;
  group.add(hit);

  const labelSprite = createCanvasSprite(256, 88, 7.2, 2.5, built.labelY);
  group.add(labelSprite.sprite);

  scene.add(group);

  const lamp = {
    group, hit,
    labelCanvas: labelSprite.canvas, labelTex: labelSprite.tex, label: labelSprite.sprite,
    state: false, name: item.name || '', meta,
    applyState: built.applyState,
    tick: built.tick || null
  };
  if (lamp.applyState) lamp.applyState(false);
  drawLabel(lamp, false);
  return lamp;
}

function disposeLamp(lamp) {
  scene.remove(lamp.group);
  lamp.group.traverse(obj => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
      else obj.material.dispose();
    }
  });
  if (lamp.labelTex) lamp.labelTex.dispose();
}

// 按设备分组,每组占一条 z 带,电器沿 x 排开(随 SCALE 放大)
function computeLayout(lights) {
  const positions = new Array(lights.length);

  // 已经有自定义位置的电器直接用
  const needAutoIdxs = [];
  lights.forEach((lt, i) => {
    if (typeof lt.x === 'number' && typeof lt.z === 'number') {
      positions[i] = { x: lt.x, z: lt.z };
    } else {
      needAutoIdxs.push(i);
    }
  });
  if (needAutoIdxs.length === 0) return positions;

  // 剩下的按设备分组自动排布
  const groups = {};
  const order = [];
  needAutoIdxs.forEach(i => {
    const ip = lights[i].device_ip;
    if (!groups[ip]) { groups[ip] = []; order.push(ip); }
    groups[ip].push(i);
  });

  const G = order.length || 1;
  const zSpan = 32 * SCALE;
  const bandH = zSpan / G;

  order.forEach((ip, gi) => {
    const idxs = groups[ip];
    const n = idxs.length;
    const perRow = Math.min(8, Math.max(1, n));
    const rows = Math.ceil(n / perRow);
    const bandCenter = -zSpan / 2 + bandH * (gi + 0.5);

    idxs.forEach((idx, i) => {
      const r = Math.floor(i / perRow);
      const c = i % perRow;
      const xSpacing = Math.min(6 * SCALE, 48 * SCALE / Math.max(perRow, 1));
      const x = (c - (perRow - 1) / 2) * xSpacing;
      const rowOffset = (r - (rows - 1) / 2) * Math.min(4 * SCALE, bandH / Math.max(rows, 1));
      const z = bandCenter + rowOffset;
      positions[idx] = { x, z };
    });
  });
  return positions;
}

function rebuildLamps() {
  lamps.forEach(disposeLamp);
  lamps = [];

  const lights = config.lights || [];
  const positions = computeLayout(lights);
  lights.forEach((lt, i) => {
    const p = positions[i] || { x: 0, z: 0 };
    lamps.push(createLamp(i, p.x, p.z, normalizeLight(lt)));
  });
}

function setLampState(index, state) {
  const lamp = lamps[index];
  if (!lamp) return;
  if (lamp.state === state) return;
  lamp.state = state;
  if (lamp.applyState) lamp.applyState(state);
  drawLabel(lamp, state);
}

// ========== 鼠标交互:点击=开关,拖动=移位 ==========
const DRAG_THRESHOLD = 5; // 像素,小于此距离视为点击
const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const dragPoint = new THREE.Vector3();
let dragState = null;
let editMode = false;

function toggleEditMode(forceValue) {
  editMode = typeof forceValue === 'boolean' ? forceValue : !editMode;
  if (editMode && walkMode) toggleWalkMode(false);
  if (editMode && layoutMode) toggleLayoutMode(false);
  const el = document.getElementById('hud-edit');
  const lbl = document.getElementById('edit-label');
  if (editMode) {
    el.classList.add('active');
    lbl.textContent = '操控模式:开';
  } else {
    el.classList.remove('active');
    lbl.textContent = '操控模式:关';
    if (typeof closeDeviceInspector === 'function') closeDeviceInspector();
  }
  updateSceneHint();
  updateCanvasCursor();
}
window.toggleEditMode = toggleEditMode;

function screenToRay(e) {
  const rect = canvas.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
}

function finishLayoutDraw() {
  if (!layoutDrawState) return;
  const { tool, start, current } = layoutDrawState;
  if (tool === 'wall') {
    const len = Math.hypot(current.x - start.x, current.z - start.z);
    if (len >= 1.5) {
      const wall = normalizeWall({
        id: makeLayoutId('wall'),
        name: getNextLayoutName('wall'),
        x1: start.x, z1: start.z,
        x2: current.x, z2: current.z,
        height: 12,
        thickness: getLayoutWallThicknessBounds().value
      }, getLayoutCollection('wall').length);
      config.layout.walls.push(wall);
      selectedLayout = { kind: 'wall', id: wall.id };
      setLayoutDirty(true);
    }
  } else if (tool === 'zone') {
    const width = Math.abs(current.x - start.x);
    const depth = Math.abs(current.z - start.z);
    if (width >= 1.5 && depth >= 1.5) {
      const zone = normalizeZone({
        id: makeLayoutId('zone'),
        name: getNextLayoutName('zone'),
        x: (start.x + current.x) / 2,
        z: (start.z + current.z) / 2,
        width,
        depth
      }, getLayoutCollection('zone').length);
      config.layout.zones.push(zone);
      selectedLayout = { kind: 'zone', id: zone.id };
      setLayoutDirty(true);
    }
  }
  layoutDrawState = null;
  clearLayoutPreview();
  rebuildLayoutScene();
  updateLayoutUI();
}

function handleLayoutPointerDown(e) {
  if (!layoutMode) return false;
  if (layoutTool === 'select') {
    const inter = raycaster.intersectObjects(layoutHitObjects);
    if (inter.length > 0) {
      const info = inter[0].object.userData;
      selectLayout(info.kind, info.id);
    } else {
      selectLayout(null, null);
    }
    return true;
  }
  const groundPoint = getGroundPoint();
  if (!groundPoint) return true;
  layoutDrawState = {
    tool: layoutTool,
    start: { x: groundPoint.x, z: groundPoint.z },
    current: { x: groundPoint.x, z: groundPoint.z }
  };
  controls.enabled = false;
  updateLayoutPreview();
  return true;
}

function handleLayoutPointerMove() {
  if (!layoutMode || !layoutDrawState) return false;
  const groundPoint = getGroundPoint();
  if (!groundPoint) return true;
  layoutDrawState.current = { x: groundPoint.x, z: groundPoint.z };
  updateLayoutPreview();
  return true;
}

function handleLayoutPointerUp() {
  if (!layoutMode) return false;
  if (!layoutDrawState) return false;
  controls.enabled = true;
  finishLayoutDraw();
  return true;
}

canvas.addEventListener('pointerdown', function(e) {
  if (e.button !== 0) return;
  if (walkMode) {
    requestWalkPointerLock();
    e.preventDefault();
    return;
  }
  screenToRay(e);
  if (lightPlacementIndex != null) {
    const point = getGroundPoint();
    if (point) finishLightPlacement(point);
    e.preventDefault();
    e.stopImmediatePropagation();
    return;
  }
  if (handleLayoutPointerDown(e)) return;
  const hits = [];
  lamps.forEach(function(l) {
    if (l.iconSprite) hits.push(l.iconSprite);
    if (l.hit) hits.push(l.hit);
  });
  const inter = raycaster.intersectObjects(hits);
  if (inter.length > 0) {
    const idx = inter[0].object.userData.lightIdx;
    dragState = { kind: 'lamp', lightIdx: idx, startX: e.clientX, startY: e.clientY, moved: false };
    controls.enabled = false; // 按在图标上就先禁用旋转
    return;
  }
  // 操控模式下点击空白处(或其它对象) → 收起设备浮窗
  if (editMode && typeof closeDeviceInspector === 'function') closeDeviceInspector();
  // 操控模式下:允许拖动工位、货架、消防设施等布局对象
  if (editMode && Array.isArray(layoutHitObjects) && layoutHitObjects.length > 0) {
    const layoutInter = raycaster.intersectObjects(layoutHitObjects);
    if (layoutInter.length > 0) {
      const hitObj = layoutInter[0].object;
      const info = hitObj.userData || {};
      if (info.kind === 'workstation' || info.kind === 'rack' || info.kind === 'safety') {
        dragState = {
          kind: info.kind,
          id: info.id,
          group: hitObj.parent,
          startX: e.clientX,
          startY: e.clientY,
          moved: false
        };
        controls.enabled = false;
      }
    }
  }
});

canvas.addEventListener('pointermove', function(e) {
  if (walkMode) return;
  screenToRay(e);
  if (lightPlacementIndex != null) {
    const point = getGroundPoint();
    if (point) updateLightPlacementMarker(point);
    e.preventDefault();
    e.stopImmediatePropagation();
    return;
  }
  if (handleLayoutPointerMove(e)) return;
  if (!dragState) return;
  if (!editMode) return;          // 操控模式关 → 不做拖动
  const dx = e.clientX - dragState.startX;
  const dy = e.clientY - dragState.startY;
  if (!dragState.moved && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
    dragState.moved = true;
    canvas.style.cursor = 'grabbing';
  }
  if (dragState.moved) {
    const point = getGroundPoint();
    if (point) {
      if (dragState.kind === 'lamp') {
        lamps[dragState.lightIdx].group.position.set(point.x, 0, point.z);
      } else if (dragState.group) {
        dragState.group.position.set(point.x, dragState.group.position.y, point.z);
      }
    }
  }
});

canvas.addEventListener('pointerup', function(e) {
  if (walkMode) return;
  if (lightPlacementIndex != null) {
    e.preventDefault();
    e.stopImmediatePropagation();
    return;
  }
  if (handleLayoutPointerUp(e)) return;
  if (!dragState) return;
  const s = dragState;
  dragState = null;
  controls.enabled = true;
  updateCanvasCursor();
  if (s.moved) {
    // 拖动结束 → 保存新位置
    if (s.kind === 'lamp') {
      const p = lamps[s.lightIdx].group.position;
      config.lights[s.lightIdx].x = Math.round(p.x * 100) / 100;
      config.lights[s.lightIdx].z = Math.round(p.z * 100) / 100;
      saveConfigData();
    } else if (s.kind && s.group) {
      const item = findLayoutItem(s.kind, s.id);
      if (item) {
        item.x = Math.round(s.group.position.x * 100) / 100;
        item.z = Math.round(s.group.position.z * 100) / 100;
        setLayoutDirty(true, false);
        saveConfigData();
        rebuildLayoutScene();
      }
    }
  } else if (s.kind === 'lamp') {
    if (editMode) {
      // 操控模式: 点击设备 → 在旁边弹出查看 / 修改浮窗
      if (typeof openDeviceInspector === 'function') openDeviceInspector(s.lightIdx);
    } else {
      // 非操控模式: 点击切换开关
      toggleLight(s.lightIdx);
    }
  }
});
