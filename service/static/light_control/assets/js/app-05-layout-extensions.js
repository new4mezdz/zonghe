// Extended layout system for building elements: pillars, doors, paths,
// workstations, racks, and safety stations.

const EXT_LAYOUT_KIND_META = Object.freeze({
  wall: {
    label: '墙体',
    icon: '墙',
    collection: 'walls',
    prefix: '墙体',
    draw: 'line',
    accent: '#ffb35c',
    accentHex: 0xffb35c
  },
  door: {
    label: '卷帘门',
    icon: '门',
    collection: 'doors',
    prefix: '卷帘门',
    draw: 'line',
    accent: '#84cc16',
    accentHex: 0x84cc16
  },
  pillar: {
    label: '柱子',
    icon: '柱',
    collection: 'pillars',
    prefix: '柱子',
    draw: 'point',
    accent: '#d5dbe5',
    accentHex: 0xd5dbe5
  },
  path: {
    label: '通道',
    icon: '道',
    collection: 'paths',
    prefix: '通道',
    draw: 'rect',
    accent: '#67e8f9',
    accentHex: 0x67e8f9
  },
  workstation: {
    label: '工位',
    icon: '工',
    collection: 'workstations',
    prefix: '工位',
    draw: 'rect',
    accent: '#818cf8',
    accentHex: 0x818cf8
  },
  rack: {
    label: '货架',
    icon: '架',
    collection: 'racks',
    prefix: '货架',
    draw: 'rect',
    accent: '#f59e0b',
    accentHex: 0xf59e0b
  },
  safety: {
    label: '消防设施',
    icon: '消',
    collection: 'safetyStations',
    prefix: '消防点',
    draw: 'point',
    accent: '#ef4444',
    accentHex: 0xef4444
  },
  zone: {
    label: '区域',
    icon: '区',
    collection: 'zones',
    prefix: '区域',
    draw: 'rect',
    accent: LAYOUT_ZONE_COLOR,
    accentHex: 0x5ac8fa
  }
});

const EXT_LAYOUT_TOOL_ORDER = ['select', 'wall', 'door', 'pillar', 'path', 'workstation', 'rack', 'safety', 'zone'];
const EXT_LAYOUT_POINT_TOOLS = new Set(['pillar', 'safety']);
const EXT_LAYOUT_LINE_TOOLS = new Set(['wall', 'door']);
const EXT_LAYOUT_RECT_TOOLS = new Set(['zone', 'path', 'workstation', 'rack']);

function getExtLayoutMeta(kind) {
  return EXT_LAYOUT_KIND_META[kind] || EXT_LAYOUT_KIND_META.zone;
}

function getExtLayoutCollectionKey(kind) {
  return getExtLayoutMeta(kind).collection;
}

const EXT_PATH_VARIANTS = Object.freeze({
  human: { label: '\u4eba\u884c\u901a\u9053', color: '#67e8f9' },
  forklift: { label: '\u53c9\u8f66\u901a\u9053', color: '#facc15' }
});

const EXT_WORKSTATION_VARIANTS = Object.freeze({
  station: { label: '\u5de5\u4f4d' },
  line: { label: '\u6574\u6761\u4ea7\u7ebf' },
  cigarette: { label: '\u5377\u5305\u673a' }
});

const EXT_RACK_VARIANTS = Object.freeze({
  single: { label: '\u5355\u6392\u8d27\u67b6' },
  double: { label: '\u53cc\u6392\u8d27\u67b6' }
});

function getExtPathVariant(value) {
  return value === 'forklift' ? 'forklift' : 'human';
}

function getExtWorkstationVariant(value) {
  if (value === 'line') return 'line';
  if (value === 'cigarette') return 'cigarette';
  return 'station';
}

function getExtRackVariant(value) {
  return value === 'double' ? 'double' : 'single';
}

function getExtPathVariantMeta(value) {
  return EXT_PATH_VARIANTS[getExtPathVariant(value)];
}

function getExtWorkstationVariantMeta(value) {
  return EXT_WORKSTATION_VARIANTS[getExtWorkstationVariant(value)];
}

function getExtRackVariantMeta(value) {
  return EXT_RACK_VARIANTS[getExtRackVariant(value)];
}

function getExtLayoutRotation(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return ((numeric % 360) + 360) % 360;
}

function getExtLayoutRadians(value) {
  return getExtLayoutRotation(value) * Math.PI / 180;
}

function clampExtRectCenter(x, z, width, depth, margin) {
  const inset = margin == null ? 1.2 : margin;
  return {
    x: clamp(x, -BUILDING.halfW + width / 2 + inset, BUILDING.halfW - width / 2 - inset),
    z: clamp(z, -BUILDING.halfD + depth / 2 + inset, BUILDING.halfD - depth / 2 - inset)
  };
}

function getExtLayoutDimension(baseRatio, minValue, maxValue) {
  return clamp(Math.min(BUILDING.width, BUILDING.depth) * baseRatio, minValue, maxValue);
}

function getExtLayoutCounts(layout) {
  const src = layout || DEFAULT_LAYOUT;
  const walls = Array.isArray(src.walls) ? src.walls.length : 0;
  const zones = Array.isArray(src.zones) ? src.zones.length : 0;
  const pillars = Array.isArray(src.pillars) ? src.pillars.length : 0;
  const doors = Array.isArray(src.doors) ? src.doors.length : 0;
  const paths = Array.isArray(src.paths) ? src.paths.length : 0;
  const workstations = Array.isArray(src.workstations) ? src.workstations.length : 0;
  const racks = Array.isArray(src.racks) ? src.racks.length : 0;
  const safetyStations = Array.isArray(src.safetyStations) ? src.safetyStations.length : 0;
  const structures = walls + pillars + doors + paths + workstations + racks + safetyStations;
  return {
    walls,
    zones,
    pillars,
    doors,
    paths,
    workstations,
    racks,
    safetyStations,
    structures,
    total: structures + zones
  };
}

function getExtLayoutListItems() {
  ensureLayoutConfig();
  const items = [];
  ['wall', 'door', 'pillar', 'path', 'workstation', 'rack', 'safety', 'zone'].forEach(function(kind) {
    getLayoutCollection(kind).forEach(function(item) {
      items.push({ kind, item });
    });
  });
  return items;
}

function normalizeExtPillar(item, idx) {
  if (!item) return null;
  const x = Number(item.x);
  const z = Number(item.z);
  const point = clampFloorPoint({
    x: Number.isFinite(x) ? x : 0,
    z: Number.isFinite(z) ? z : 0
  });
  const diameter = clamp(Number(item.diameter) || getExtLayoutDimension(0.04, 12, 28), 8, 36);
  const maxHeight = Math.max(BUILDING.wallH, BUILDING.ridgeH - 2);
  return {
    id: item.id || makeLayoutId('pillar'),
    name: String(item.name || ('柱子' + (idx + 1))),
    x: point.x,
    z: point.z,
    diameter,
    height: clamp(Number(item.height) || BUILDING.wallH, 8, maxHeight)
  };
}

function normalizeExtDoor(item, idx) {
  if (!item) return null;
  let x = Number(item.x);
  let z = Number(item.z);
  let length = Number(item.length);
  let rotation = Number(item.rotation);
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(length)) {
    const x1 = Number(item.x1);
    const z1 = Number(item.z1);
    const x2 = Number(item.x2);
    const z2 = Number(item.z2);
    if (![x1, z1, x2, z2].every(Number.isFinite)) return null;
    x = (x1 + x2) / 2;
    z = (z1 + z2) / 2;
    length = Math.hypot(x2 - x1, z2 - z1);
    rotation = Math.atan2(x2 - x1, z2 - z1) * 180 / Math.PI;
  }
  const point = clampFloorPoint({ x, z });
  const variant = ['rolling', 'double'].includes(item.variant) ? item.variant : 'rolling';
  return {
    id: item.id || makeLayoutId('door'),
    name: String(item.name || ('卷帘门' + (idx + 1))),
    x: point.x,
    z: point.z,
    length: clamp(Math.abs(length) || getExtLayoutDimension(0.18, 42, 160), 24, Math.max(36, BUILDING.width * 0.42)),
    height: clamp(Number(item.height) || Math.min(BUILDING.wallH * 0.76, 18), 4, Math.max(6, BUILDING.wallH)),
    thickness: clamp(Number(item.thickness) || 0.65, 0.28, 3.2),
    rotation: getExtLayoutRotation(rotation),
    variant
  };
}

function normalizeExtRectAsset(item, idx, kind, defaults) {
  if (!item) return null;
  const rawWidth = Math.abs(Number(item.width) || defaults.width);
  const rawDepth = Math.abs(Number(item.depth) || defaults.depth);
  const width = clamp(rawWidth, defaults.minWidth, defaults.maxWidth || Math.max(defaults.minWidth, BUILDING.width - 2.4));
  const depth = clamp(rawDepth, defaults.minDepth, defaults.maxDepth || Math.max(defaults.minDepth, BUILDING.depth - 2.4));
  const x = Number(item.x);
  const z = Number(item.z);
  const point = clampExtRectCenter(
    Number.isFinite(x) ? x : 0,
    Number.isFinite(z) ? z : 0,
    width,
    depth,
    1.2
  );
  const next = {
    id: item.id || makeLayoutId(kind),
    name: String(item.name || (getExtLayoutMeta(kind).prefix + (idx + 1))),
    x: point.x,
    z: point.z,
    width,
    depth,
    rotation: getExtLayoutRotation(item.rotation)
  };
  if (defaults.height) {
    next.height = clamp(Number(item.height) || defaults.height, defaults.minHeight, defaults.maxHeight);
  }
  if (defaults.levels) {
    next.levels = clamp(Math.round(Number(item.levels) || defaults.levels), 2, 6);
  }
  if (defaults.colorKey) {
    next.color = item.color || defaults.colorKey;
  }
  return next;
}

function normalizeExtPath(item, idx) {
  const next = normalizeExtRectAsset(item, idx, 'path', {
    width: getExtLayoutDimension(0.12, 40, 120),
    depth: getExtLayoutDimension(0.3, 90, 240),
    minWidth: 18,
    minDepth: 24,
    colorKey: '#67e8f9'
  });
  if (!next) return null;
  const variant = getExtPathVariant(item && item.variant);
  next.variant = variant;
  next.color = item && item.color ? item.color : getExtPathVariantMeta(variant).color;
  return next;
}

function normalizeExtWorkstation(item, idx) {
  const next = normalizeExtRectAsset(item, idx, 'workstation', {
    width: getExtLayoutDimension(0.16, 48, 120),
    depth: getExtLayoutDimension(0.12, 36, 100),
    minWidth: 24,
    minDepth: 18,
    height: 3.2,
    minHeight: 2,
    maxHeight: 14
  });
  if (!next) return null;
  next.variant = getExtWorkstationVariant(item && item.variant);
  return next;
}

function normalizeExtRack(item, idx) {
  const next = normalizeExtRectAsset(item, idx, 'rack', {
    width: getExtLayoutDimension(0.18, 54, 140),
    depth: getExtLayoutDimension(0.08, 24, 68),
    minWidth: 24,
    minDepth: 12,
    height: 8,
    minHeight: 4,
    maxHeight: 18,
    levels: 3
  });
  if (!next) return null;
  next.variant = getExtRackVariant(item && item.variant);
  return next;
}

function normalizeExtSafety(item, idx) {
  if (!item) return null;
  const point = clampFloorPoint({
    x: Number.isFinite(Number(item.x)) ? Number(item.x) : 0,
    z: Number.isFinite(Number(item.z)) ? Number(item.z) : 0
  });
  const variant = ['hydrant', 'extinguisher', 'exit'].includes(item.variant) ? item.variant : 'hydrant';
  return {
    id: item.id || makeLayoutId('safety'),
    name: String(item.name || ('消防点' + (idx + 1))),
    x: point.x,
    z: point.z,
    width: clamp(Math.abs(Number(item.width) || getExtLayoutDimension(0.04, 12, 28)), 8, 32),
    depth: clamp(Math.abs(Number(item.depth) || getExtLayoutDimension(0.028, 8, 22)), 6, 24),
    height: clamp(Number(item.height) || 2.6, 1.4, 5),
    variant
  };
}

window.normalizeLayoutData = normalizeLayoutData = function(layout) {
  const src = layout || DEFAULT_LAYOUT;
  const building = applyBuildingConfig(src.building || DEFAULT_BUILDING);
  return {
    building,
    walls: (Array.isArray(src.walls) ? src.walls : []).map(normalizeWall).filter(Boolean),
    zones: (Array.isArray(src.zones) ? src.zones : []).map(normalizeZone).filter(Boolean),
    pillars: (Array.isArray(src.pillars) ? src.pillars : []).map(normalizeExtPillar).filter(Boolean),
    doors: (Array.isArray(src.doors) ? src.doors : []).map(normalizeExtDoor).filter(Boolean),
    paths: (Array.isArray(src.paths) ? src.paths : []).map(normalizeExtPath).filter(Boolean),
    workstations: (Array.isArray(src.workstations) ? src.workstations : []).map(normalizeExtWorkstation).filter(Boolean),
    racks: (Array.isArray(src.racks) ? src.racks : []).map(normalizeExtRack).filter(Boolean),
    safetyStations: (Array.isArray(src.safetyStations) ? src.safetyStations : []).map(normalizeExtSafety).filter(Boolean)
  };
};

window.ensureLayoutConfig = ensureLayoutConfig = function() {
  if (!config.layout || typeof config.layout !== 'object' || config.layout === null) {
    config.layout = normalizeLayoutData(config.layout);
    return;
  }
  // 只补齐缺失结构,不要重建已存在的 item 对象 —— 否则 inspector 闭包中抓到的引用会变成孤儿
  ['walls', 'zones', 'pillars', 'doors', 'paths', 'workstations', 'racks', 'safetyStations'].forEach(function(key) {
    if (!Array.isArray(config.layout[key])) config.layout[key] = [];
  });
  if (!config.layout.building || typeof config.layout.building !== 'object') {
    config.layout.building = Object.assign({}, DEFAULT_BUILDING);
  }
};

window.applyLayoutBuildingChange = applyLayoutBuildingChange = function(partial) {
  ensureLayoutConfig();
  config.layout = normalizeLayoutData({
    building: Object.assign({}, config.layout.building, partial || {}),
    walls: config.layout.walls,
    zones: config.layout.zones,
    pillars: config.layout.pillars,
    doors: config.layout.doors,
    paths: config.layout.paths,
    workstations: config.layout.workstations,
    racks: config.layout.racks,
    safetyStations: config.layout.safetyStations
  });
  clampLightPositionsToBuilding();
  rebuildFactoryScene();
  rebuildLayoutScene();
  rebuildLamps();
  applyStatus();
  setLayoutDirty(true, false);
  updateLayoutUI();
};

window.getLayoutCollection = getLayoutCollection = function(kind) {
  ensureLayoutConfig();
  const key = getExtLayoutCollectionKey(kind);
  if (!Array.isArray(config.layout[key])) config.layout[key] = [];
  return config.layout[key];
};

window.findLayoutItem = findLayoutItem = function(kind, id) {
  return getLayoutCollection(kind).find(function(item) {
    return item.id === id;
  }) || null;
};

window.getNextLayoutName = getNextLayoutName = function(kind) {
  const meta = getExtLayoutMeta(kind);
  const used = new Set(getLayoutCollection(kind).map(function(item) {
    return item.name;
  }));
  let index = 1;
  while (used.has(meta.prefix + index)) index++;
  return meta.prefix + index;
};

function createExtLayoutTag(kind, item, selected, y) {
  const meta = getExtLayoutMeta(kind);
  const tag = createCanvasSprite(240, 72, 8.4, 2.3, y);
  tag.sprite.position.set(item.x, y, item.z);
  drawTextSprite(tag.canvas, tag.tex, {
    text: (item.name || meta.label).slice(0, 14),
    bg: selected ? 'rgba(0,0,0,0.9)' : 'rgba(18,22,28,0.82)',
    stroke: selected ? '#ffffff' : meta.accent,
    color: '#ffffff'
  });
  scene.add(tag.sprite);
  layoutObjects.push({ group: tag.sprite, textures: [tag.tex] });
}

function createExtLayoutHit(group, width, height, depth, y, kind, id) {
  const hit = new THREE.Mesh(
    new THREE.BoxGeometry(width, height, depth),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  hit.position.y = y;
  hit.userData = { kind, id };
  group.add(hit);
  layoutHitObjects.push(hit);
}

function setExtObjectShadowProfile(group, castShadow, receiveShadow) {
  if (!group) return;
  group.traverse(function(node) {
    if (!node || !node.isMesh) return;
    node.castShadow = castShadow;
    node.receiveShadow = receiveShadow;
  });
}

function createExtPillarObject(item, selected) {
  const group = new THREE.Group();
  group.position.set(item.x, 0, item.z);
  const radius = item.diameter / 2;
  const shellMat = new THREE.MeshStandardMaterial({
    color: selected ? 0xf0f4f8 : 0xbcc3cb,
    roughness: 0.56, metalness: 0.18,
    emissive: selected ? 0x38414f : 0x000000,
    emissiveIntensity: selected ? 0.28 : 0
  });
  const capMat = new THREE.MeshStandardMaterial({
    color: selected ? 0xd5dde7 : 0x87919d,
    roughness: 0.38, metalness: 0.54
  });
  addMesh(group, new THREE.CylinderGeometry(radius * 1.1, radius * 1.12, 1.1, 18), capMat, [0, 0.55, 0]);
  addMesh(group, new THREE.CylinderGeometry(radius, radius, item.height, 24), shellMat, [0, item.height / 2 + 1.1, 0]);
  addMesh(group, new THREE.CylinderGeometry(radius * 1.12, radius * 1.08, 0.8, 20), capMat, [0, item.height + 1.5, 0]);
  createExtLayoutHit(group, item.diameter * 1.2, item.height + 2.8, item.diameter * 1.2, (item.height + 2.2) / 2, 'pillar', item.id);
  scene.add(group);
  layoutObjects.push({ group, textures: [] });
  createExtLayoutTag('pillar', item, selected, item.height + 4);
}

function createExtDoorObject(item, selected) {
  const group = new THREE.Group();
  group.position.set(item.x, 0, item.z);
  group.rotation.y = getExtLayoutRadians(item.rotation);
  const frameMat = new THREE.MeshStandardMaterial({
    color: selected ? 0xb0d65a : 0x4f6d1d,
    roughness: 0.52, metalness: 0.38,
    emissive: selected ? 0x32440f : 0x000000,
    emissiveIntensity: selected ? 0.2 : 0
  });
  const leafMat = new THREE.MeshStandardMaterial({
    color: item.variant === 'double' ? 0xcfd7df : 0xdde4ea,
    roughness: 0.3, metalness: 0.46,
    emissive: selected ? 0x223310 : 0x000000,
    emissiveIntensity: selected ? 0.14 : 0
  });
  const beamH = 0.7;
  const postW = Math.max(0.32, item.thickness * 0.65);
  addMesh(group, new THREE.BoxGeometry(postW, item.height + beamH, item.thickness * 1.4), frameMat, [-item.length / 2, (item.height + beamH) / 2, 0]);
  addMesh(group, new THREE.BoxGeometry(postW, item.height + beamH, item.thickness * 1.4), frameMat, [item.length / 2, (item.height + beamH) / 2, 0]);
  addMesh(group, new THREE.BoxGeometry(item.length + postW * 0.8, beamH, item.thickness * 1.5), frameMat, [0, item.height + beamH / 2, 0]);
  if (item.variant === 'double') {
    addMesh(group, new THREE.BoxGeometry(item.length * 0.47, item.height * 0.88, item.thickness), leafMat, [-item.length * 0.25, item.height * 0.44, 0]);
    addMesh(group, new THREE.BoxGeometry(item.length * 0.47, item.height * 0.88, item.thickness), leafMat, [item.length * 0.25, item.height * 0.44, 0]);
  } else {
    addMesh(group, new THREE.BoxGeometry(item.length * 0.92, item.height * 0.88, item.thickness), leafMat, [0, item.height * 0.44, 0]);
    for (let i = 0; i < 7; i++) {
      const y = item.height * 0.14 + i * (item.height * 0.11);
      addMesh(group, new THREE.BoxGeometry(item.length * 0.92, 0.08, item.thickness * 1.04), frameMat, [0, y, 0]);
    }
  }
  createExtLayoutHit(group, item.length + 2, item.height + 2, item.thickness + 1.2, item.height / 2 + 0.3, 'door', item.id);
  scene.add(group);
  layoutObjects.push({ group, textures: [] });
  createExtLayoutTag('door', item, selected, item.height + 3.2);
}

function createExtRectBorder(width, depth, color, opacity, layerY, renderOrder) {
  const y = layerY == null ? FLOOR_LAYER.border : layerY;
  const border = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-width / 2, y, -depth / 2),
      new THREE.Vector3(width / 2, y, -depth / 2),
      new THREE.Vector3(width / 2, y, depth / 2),
      new THREE.Vector3(-width / 2, y, depth / 2)
    ]),
    new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: opacity == null ? 0.95 : opacity
    })
  );
  border.renderOrder = renderOrder == null ? FLOOR_RENDER_ORDER.marker : renderOrder;
  return border;
}

function createExtPathObject(item, selected) {
  const group = new THREE.Group();
  group.position.set(item.x, 0, item.z);
  group.rotation.y = getExtLayoutRadians(item.rotation);
  const variant = getExtPathVariant(item.variant);
  const pathColor = item.color || getExtPathVariantMeta(variant).color;
  const accentHex = new THREE.Color(pathColor).getHex();
  const fill = new THREE.Mesh(
    new THREE.PlaneGeometry(item.width, item.depth),
    createFloorOverlayMaterial({
      color: new THREE.Color(pathColor),
      transparent: true,
      opacity: selected ? 0.28 : 0.18
    }, 'path')
  );
  fill.rotation.x = -Math.PI / 2;
  applyFloorOverlayProfile(fill, FLOOR_LAYER.path, 'path');
  group.add(fill);
  group.add(createExtRectBorder(item.width, item.depth, selected ? 0xffffff : accentHex, 0.95, FLOOR_LAYER.border, FLOOR_RENDER_ORDER.path + 1));
  const stripeStep = Math.max(14, item.depth / 5);
  const markingY = FLOOR_LAYER.path + 0.08;
  if (variant === 'forklift') {
    const laneMat = new THREE.MeshStandardMaterial({
      color: 0x2b2f36,
      roughness: 0.42,
      metalness: 0.08,
      emissive: selected ? 0x3f2d00 : 0x000000,
      emissiveIntensity: selected ? 0.16 : 0
    });
    const guardW = Math.max(1.4, item.width * 0.08);
    const sideOffset = Math.max(item.width * 0.34, guardW * 1.6);
    addMesh(group, new THREE.BoxGeometry(guardW, 0.05, item.depth * 0.9), laneMat, [-sideOffset, markingY, 0]);
    addMesh(group, new THREE.BoxGeometry(guardW, 0.05, item.depth * 0.9), laneMat, [sideOffset, markingY, 0]);
    for (let offset = -item.depth / 2 + stripeStep * 0.45; offset < item.depth / 2; offset += stripeStep) {
      addMesh(group, new THREE.BoxGeometry(Math.max(2.2, item.width * 0.18), 0.05, Math.min(16, stripeStep * 0.44)), laneMat, [0, markingY, offset]);
    }
  } else {
    for (let offset = -item.depth / 2 + stripeStep / 2; offset < item.depth / 2; offset += stripeStep) {
      addMesh(group, new THREE.BoxGeometry(Math.max(1.3, item.width * 0.08), 0.05, Math.min(12, stripeStep * 0.55)), new THREE.MeshStandardMaterial({
        color: 0xeafcff,
        roughness: 0.35,
        metalness: 0.02,
        emissive: selected ? 0x163743 : 0x000000,
        emissiveIntensity: selected ? 0.15 : 0
      }), [0, markingY, offset]);
    }
  }
  createExtLayoutHit(group, item.width, 0.6, item.depth, 0.3, 'path', item.id);
  scene.add(group);
  layoutObjects.push({ group, textures: [] });
  createExtLayoutTag('path', item, selected, 0.52);
}

function createExtWorkstationObject(item, selected) {
  const group = new THREE.Group();
  group.position.set(item.x, 0, item.z);
  group.rotation.y = getExtLayoutRadians(item.rotation);
  const variant = getExtWorkstationVariant(item.variant);
  const baseMat = new THREE.MeshStandardMaterial({
    color: selected ? 0x96a1ff : 0x5f6ad8,
    roughness: 0.56, metalness: 0.14,
    emissive: selected ? 0x232b62 : 0x000000,
    emissiveIntensity: selected ? 0.24 : 0
  });
  const tableMat = new THREE.MeshStandardMaterial({
    color: 0xe7ebf1, roughness: 0.42, metalness: 0.24
  });
  const surface = new THREE.Mesh(
    new THREE.PlaneGeometry(item.width, item.depth),
    createFloorOverlayMaterial({
      color: new THREE.Color(getExtLayoutMeta('workstation').accent),
      transparent: true,
      opacity: selected ? 0.22 : 0.14
    }, 'workstation')
  );
  surface.rotation.x = -Math.PI / 2;
  applyFloorOverlayProfile(surface, FLOOR_LAYER.workstation, 'workstation');
  group.add(surface);
  group.add(createExtRectBorder(item.width, item.depth, selected ? 0xffffff : getExtLayoutMeta('workstation').accentHex, 0.95, FLOOR_LAYER.border, FLOOR_RENDER_ORDER.workstation + 1));
  if (variant === 'cigarette') {
    // Inverted-L industrial apparatus per spec:
    //   bottom: long horizontal base + small connection block at left end
    //   right side: slender vertical support rod + cylindrical part
    //   top: square motor module (left) -> connector + mounting platform (mid) -> vertical mounting plate (right)
    const cigGroup = new THREE.Group();
    const alongWidth = item.width >= item.depth;
    if (!alongWidth) cigGroup.rotation.y = Math.PI / 2;
    group.add(cigGroup);

    const W = Math.max(item.width, item.depth);
    const D = Math.min(item.width, item.depth);
    const H = Math.max(item.height, 6);
    const halfW = W / 2;

    const metalMat = new THREE.MeshStandardMaterial({
      color: selected ? 0xc8cdd4 : 0xa6acb4,
      roughness: 0.42, metalness: 0.62,
      emissive: selected ? 0x222933 : 0x000000,
      emissiveIntensity: selected ? 0.18 : 0
    });
    const metalLightMat = new THREE.MeshStandardMaterial({
      color: 0xdde2e7, roughness: 0.48, metalness: 0.48
    });
    const darkMat = new THREE.MeshStandardMaterial({
      color: 0x434851, roughness: 0.46, metalness: 0.62
    });
    const accentMat = new THREE.MeshStandardMaterial({
      color: 0x5ac8fa, emissive: 0x5ac8fa, emissiveIntensity: 0.55,
      roughness: 0.32, metalness: 0.4
    });
    const lampMat = new THREE.MeshStandardMaterial({
      color: 0x32d27a, emissive: 0x32d27a, emissiveIntensity: 0.85
    });
    const lampR = Math.max(0.3, D * 0.04);

    // ----- BOTTOM: long horizontal base
    const baseW = W * 0.92;
    const baseD = D * 0.34;
    const baseH = H * 0.14;
    addMesh(cigGroup, new THREE.BoxGeometry(baseW, baseH, baseD), metalMat, [0, baseH / 2, 0]);
    // accent strip along base front edge
    addMesh(cigGroup, new THREE.BoxGeometry(baseW * 0.96, H * 0.022, 0.36), accentMat, [0, baseH * 0.55, baseD / 2 + 0.18]);
    // raised dark end caps on the base
    const capW = W * 0.04;
    addMesh(cigGroup, new THREE.BoxGeometry(capW, baseH * 1.16, baseD * 1.04), darkMat, [-baseW / 2 + capW / 2, baseH * 0.58, 0]);
    addMesh(cigGroup, new THREE.BoxGeometry(capW, baseH * 1.16, baseD * 1.04), darkMat, [+baseW / 2 - capW / 2, baseH * 0.58, 0]);

    // ----- BOTTOM-LEFT: small block-shaped connection end
    const blockW = W * 0.11;
    const blockH = H * 0.42;
    const blockD = D * 0.46;
    const blockX = -halfW + blockW / 2 + W * 0.05;
    addMesh(cigGroup, new THREE.BoxGeometry(blockW, blockH, blockD), darkMat, [blockX, baseH + blockH / 2, 0]);
    // block top cap
    addMesh(cigGroup, new THREE.BoxGeometry(blockW * 1.06, H * 0.04, blockD * 1.06), metalMat, [blockX, baseH + blockH + H * 0.02, 0]);
    // status lamp on the block
    addMesh(cigGroup, new THREE.SphereGeometry(lampR, 12, 8), lampMat, [blockX, baseH + blockH + H * 0.07, blockD * 0.3]);

    // ----- RIGHT SIDE: slender vertical support rod (twin posts for stability)
    const rodX = halfW - W * 0.08;
    const rodH = H * 0.74;
    const rodR = Math.max(0.45, D * 0.028);
    const rodOffsetZ = D * 0.06;
    addMesh(cigGroup, new THREE.CylinderGeometry(rodR, rodR, rodH, 12), darkMat, [rodX, baseH + rodH / 2, rodOffsetZ]);
    addMesh(cigGroup, new THREE.CylinderGeometry(rodR, rodR, rodH, 12), darkMat, [rodX, baseH + rodH / 2, -rodOffsetZ]);
    // rod base flange
    addMesh(cigGroup, new THREE.CylinderGeometry(rodR * 1.5, rodR * 1.5, H * 0.04, 12), metalMat, [rodX, baseH + H * 0.02, rodOffsetZ]);
    addMesh(cigGroup, new THREE.CylinderGeometry(rodR * 1.5, rodR * 1.5, H * 0.04, 12), metalMat, [rodX, baseH + H * 0.02, -rodOffsetZ]);

    // ----- RIGHT SIDE: cylindrical component beside the rod (vertical drum / pulley)
    const cylR = D * 0.11;
    const cylHt = H * 0.3;
    const cylX = rodX - W * 0.06;
    const cylY = baseH + H * 0.18 + cylHt / 2;
    addMesh(cigGroup, new THREE.CylinderGeometry(cylR, cylR, cylHt, 18), metalLightMat, [cylX, cylY, 0]);
    // dark ring around the middle of the drum
    addMesh(cigGroup, new THREE.CylinderGeometry(cylR * 1.05, cylR * 1.05, H * 0.045, 18), darkMat, [cylX, cylY, 0]);
    // brace from the rod cluster to the cylinder
    addMesh(cigGroup, new THREE.BoxGeometry(W * 0.07, H * 0.04, D * 0.06), darkMat, [(rodX + cylX) / 2, cylY, 0]);

    // ----- TOP-RIGHT: vertical rectangular mounting plate (sits on top of the rod)
    const armY = baseH + rodH;
    const plateW = W * 0.06;
    const plateH = H * 0.32;
    const plateD = D * 0.42;
    addMesh(cigGroup, new THREE.BoxGeometry(plateW, plateH, plateD), metalMat, [rodX, armY + plateH / 2, 0]);
    // 4 bolt heads at plate corners (facing +z front)
    const boltR = 0.22;
    for (let zi = -1; zi <= 1; zi += 2) {
      for (let yi = -1; yi <= 1; yi += 2) {
        addMesh(cigGroup, new THREE.CylinderGeometry(boltR, boltR, 0.4, 8), darkMat, [rodX + plateW / 2 + 0.18, armY + plateH / 2 + yi * plateH * 0.32, zi * plateD * 0.32], [0, 0, Math.PI / 2]);
      }
    }

    // ----- TOP-MIDDLE: connector + mounting platform
    const platformW = W * 0.18;
    const platformH = H * 0.08;
    const platformD = D * 0.5;
    const platformX = rodX - W * 0.14;
    addMesh(cigGroup, new THREE.BoxGeometry(platformW, platformH, platformD), metalLightMat, [platformX, armY + platformH / 2, 0]);
    // raised mounting pads on the platform
    for (let i = -1; i <= 1; i += 2) {
      addMesh(cigGroup, new THREE.BoxGeometry(platformW * 0.16, platformH * 1.4, platformD * 0.16), darkMat, [platformX + i * platformW * 0.32, armY + platformH * 0.7, 0]);
    }
    // connector block between motor and platform
    const connW = W * 0.05;
    const connH = H * 0.18;
    const connD = D * 0.22;
    const connX = platformX - W * 0.12;
    addMesh(cigGroup, new THREE.BoxGeometry(connW, connH, connD), darkMat, [connX, armY + connH / 2, 0]);

    // ----- TOP-LEFT: square motor / transmission module
    const motorW = W * 0.18;
    const motorH = H * 0.34;
    const motorD = D * 0.54;
    const motorX = connX - W * 0.13;
    addMesh(cigGroup, new THREE.BoxGeometry(motorW, motorH, motorD), metalMat, [motorX, armY + motorH / 2, 0]);
    // cooling fins (4 thin horizontal strips on the motor body)
    for (let i = 0; i < 4; i++) {
      const fy = armY + motorH * (0.22 + i * 0.16);
      addMesh(cigGroup, new THREE.BoxGeometry(motorW * 0.98, H * 0.014, motorD * 1.02), darkMat, [motorX, fy, 0]);
    }
    // round end cap (driven side)
    addMesh(cigGroup, new THREE.CylinderGeometry(motorH * 0.34, motorH * 0.36, W * 0.025, 16), darkMat, [motorX - motorW / 2 - W * 0.013, armY + motorH / 2, 0], [0, 0, Math.PI / 2]);
    // motor shaft toward connector
    addMesh(cigGroup, new THREE.CylinderGeometry(motorH * 0.16, motorH * 0.16, W * 0.04, 14), darkMat, [motorX + motorW / 2 + W * 0.02, armY + motorH / 2, 0], [0, 0, Math.PI / 2]);

    // ----- Underside support beam tying the top arm together (horizontal of the inverted L)
    const beamLeft = motorX - motorW / 2;
    const beamRight = rodX + plateW / 2;
    const beamLen = beamRight - beamLeft;
    const beamCx = (beamLeft + beamRight) / 2;
    addMesh(cigGroup, new THREE.BoxGeometry(beamLen, H * 0.05, D * 0.07), darkMat, [beamCx, armY - H * 0.025, 0]);
    // accent strip along the beam (so the inverted-L top edge glows)
    addMesh(cigGroup, new THREE.BoxGeometry(beamLen * 0.94, H * 0.02, 0.34), accentMat, [beamCx, armY - H * 0.05, D * 0.04]);
  } else if (variant === 'line') {
    const lineGroup = new THREE.Group();
    const alongWidth = item.width >= item.depth;
    if (!alongWidth) lineGroup.rotation.y = Math.PI / 2;
    group.add(lineGroup);

    const mainSpan = Math.max(item.width, item.depth);
    const crossSpan = Math.min(item.width, item.depth);
    addMesh(lineGroup, new THREE.BoxGeometry(mainSpan * 0.82, item.height * 0.22, crossSpan * 0.34), tableMat, [0, item.height * 0.2, 0]);
    addMesh(lineGroup, new THREE.BoxGeometry(mainSpan * 0.1, item.height * 0.72, crossSpan * 0.12), baseMat, [-mainSpan * 0.34, item.height * 0.36, 0]);
    addMesh(lineGroup, new THREE.BoxGeometry(mainSpan * 0.1, item.height * 0.72, crossSpan * 0.12), baseMat, [mainSpan * 0.34, item.height * 0.36, 0]);
    const rollerRadius = Math.max(0.45, crossSpan * 0.08);
    const rollerStep = Math.max(10, mainSpan / 8);
    for (let offset = -mainSpan * 0.32; offset <= mainSpan * 0.32; offset += rollerStep) {
      addMesh(lineGroup, new THREE.CylinderGeometry(rollerRadius, rollerRadius, crossSpan * 0.64, 18), baseMat, [offset, item.height * 0.34, 0], [Math.PI / 2, 0, 0]);
    }
    addMesh(lineGroup, new THREE.BoxGeometry(mainSpan * 0.2, item.height * 0.16, crossSpan * 0.58), baseMat, [-mainSpan * 0.46, item.height * 0.16, 0]);
    addMesh(lineGroup, new THREE.BoxGeometry(mainSpan * 0.2, item.height * 0.16, crossSpan * 0.58), baseMat, [mainSpan * 0.46, item.height * 0.16, 0]);
  } else {
    addMesh(group, new THREE.BoxGeometry(item.width * 0.56, item.height * 0.22, item.depth * 0.36), tableMat, [0, item.height * 0.11, 0]);
    addMesh(group, new THREE.BoxGeometry(item.width * 0.12, item.height * 0.68, item.depth * 0.12), baseMat, [-item.width * 0.2, item.height * 0.34, -item.depth * 0.1]);
    addMesh(group, new THREE.BoxGeometry(item.width * 0.12, item.height * 0.68, item.depth * 0.12), baseMat, [item.width * 0.2, item.height * 0.34, -item.depth * 0.1]);
    addMesh(group, new THREE.BoxGeometry(item.width * 0.22, item.height * 0.18, item.depth * 0.1), baseMat, [0, item.height * 0.38, item.depth * 0.12]);
  }
  createExtLayoutHit(group, item.width, item.height + 1.1, item.depth, item.height / 2 + 0.3, 'workstation', item.id);
  setExtObjectShadowProfile(group, true, false);
  scene.add(group);
  layoutObjects.push({ group, textures: [] });
  createExtLayoutTag('workstation', item, selected, item.height + 2.2);
}

function createExtRackObject(item, selected) {
  const group = new THREE.Group();
  group.position.set(item.x, 0, item.z);
  group.rotation.y = getExtLayoutRadians(item.rotation);
  const variant = getExtRackVariant(item.variant);
  const frameMat = new THREE.MeshStandardMaterial({
    color: selected ? 0xf6bf59 : 0xe39218,
    roughness: 0.48, metalness: 0.32,
    emissive: selected ? 0x5d3504 : 0x000000,
    emissiveIntensity: selected ? 0.2 : 0
  });
  const shelfMat = new THREE.MeshStandardMaterial({
    color: 0xcbd5df, roughness: 0.34, metalness: 0.28
  });
  const legW = Math.max(1.2, item.depth * 0.08);
  const halfW = item.width / 2 - legW;
  const halfD = item.depth / 2 - legW;
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(item.width, item.depth),
    createFloorOverlayMaterial({
      color: new THREE.Color(getExtLayoutMeta('rack').accent),
      transparent: true,
      opacity: selected ? 0.2 : 0.12
    }, 'rack')
  );
  plane.rotation.x = -Math.PI / 2;
  applyFloorOverlayProfile(plane, FLOOR_LAYER.rack, 'rack');
  group.add(plane);
  group.add(createExtRectBorder(item.width, item.depth, selected ? 0xffffff : getExtLayoutMeta('rack').accentHex, 0.95, FLOOR_LAYER.border, FLOOR_RENDER_ORDER.rack + 1));
  if (variant === 'double') {
    const rowDepth = item.depth * 0.34;
    const rowCenter = item.depth * 0.24;
    const centerGap = item.depth * 0.14;
    [-rowCenter, rowCenter].forEach(function(centerZ) {
      [[-halfW, centerZ - rowDepth / 2], [halfW, centerZ - rowDepth / 2], [-halfW, centerZ + rowDepth / 2], [halfW, centerZ + rowDepth / 2]].forEach(function(pair) {
        addMesh(group, new THREE.BoxGeometry(legW, item.height, legW), frameMat, [pair[0], item.height / 2, pair[1]]);
      });
      for (let level = 0; level < item.levels; level++) {
        const y = ((level + 1) / (item.levels + 1)) * item.height;
        addMesh(group, new THREE.BoxGeometry(item.width * 0.92, 0.32, rowDepth), shelfMat, [0, y, centerZ]);
      }
    });
    addMesh(group, new THREE.BoxGeometry(item.width * 0.94, 0.08, centerGap), frameMat, [0, 0.08, 0]);
  } else {
    [[-halfW, -halfD], [halfW, -halfD], [-halfW, halfD], [halfW, halfD]].forEach(function(pair) {
      addMesh(group, new THREE.BoxGeometry(legW, item.height, legW), frameMat, [pair[0], item.height / 2, pair[1]]);
    });
    for (let level = 0; level < item.levels; level++) {
      const y = ((level + 1) / (item.levels + 1)) * item.height;
      addMesh(group, new THREE.BoxGeometry(item.width * 0.92, 0.32, item.depth * 0.84), shelfMat, [0, y, 0]);
    }
  }
  createExtLayoutHit(group, item.width + 1.4, item.height + 1.2, item.depth + 1.2, item.height / 2 + 0.2, 'rack', item.id);
  setExtObjectShadowProfile(group, true, false);
  scene.add(group);
  layoutObjects.push({ group, textures: [] });
  createExtLayoutTag('rack', item, selected, item.height + 2.2);
}

function createExtSafetyObject(item, selected) {
  const group = new THREE.Group();
  group.position.set(item.x, 0, item.z);
  const accentHex = getExtLayoutMeta('safety').accentHex;
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0xde3e3e, roughness: 0.28, metalness: 0.08,
    emissive: selected ? 0x5f0b0b : 0x000000,
    emissiveIntensity: selected ? 0.34 : 0
  });
  const trimMat = new THREE.MeshStandardMaterial({
    color: 0xf4f5f6, roughness: 0.4, metalness: 0.18
  });
  if (item.variant === 'exit') {
    addMesh(group, new THREE.BoxGeometry(item.width * 0.16, item.height, item.depth * 0.16), trimMat, [0, item.height / 2, 0]);
    addMesh(group, new THREE.BoxGeometry(item.width, item.height * 0.24, item.depth * 0.4), bodyMat, [0, item.height * 0.84, 0]);
  } else if (item.variant === 'extinguisher') {
    addMesh(group, new THREE.CylinderGeometry(item.width * 0.28, item.width * 0.32, item.height * 0.72, 18), bodyMat, [0, item.height * 0.36, 0]);
    addMesh(group, new THREE.BoxGeometry(item.width * 0.44, item.height * 0.08, item.depth * 0.2), trimMat, [0, item.height * 0.72, 0]);
    addMesh(group, new THREE.TorusGeometry(item.width * 0.12, item.width * 0.04, 10, 20), trimMat, [item.width * 0.18, item.height * 0.73, 0], [Math.PI / 2, 0, 0]);
  } else {
    addMesh(group, new THREE.BoxGeometry(item.width, item.height, item.depth), bodyMat, [0, item.height / 2, 0]);
    addMesh(group, new THREE.BoxGeometry(item.width * 0.7, item.height * 0.18, item.depth * 1.02), trimMat, [0, item.height * 0.72, item.depth * 0.02]);
    addMesh(group, new THREE.CylinderGeometry(item.width * 0.14, item.width * 0.14, item.depth * 0.5, 18), trimMat, [0, item.height * 0.36, item.depth * 0.06], [Math.PI / 2, 0, 0]);
  }
  const halo = createGlowSprite(accentHex, item.width * 1.6, item.width * 1.6, selected ? 0.14 : 0.06);
  halo.position.y = Math.max(item.height * 0.65, 1.2);
  group.add(halo);
  createExtLayoutHit(group, item.width + 1.1, item.height + 1.1, item.depth + 1.1, item.height / 2 + 0.1, 'safety', item.id);
  scene.add(group);
  layoutObjects.push({ group, textures: [] });
  createExtLayoutTag('safety', item, selected, item.height + 2);
}

window.rebuildLayoutScene = rebuildLayoutScene = function() {
  ensureLayoutConfig();
  clearLayoutScene();
  config.layout.zones.forEach(function(zone) {
    createZoneObject(zone, isLayoutSelected('zone', zone.id));
  });
  config.layout.paths.forEach(function(path) {
    createExtPathObject(path, isLayoutSelected('path', path.id));
  });
  config.layout.workstations.forEach(function(item) {
    createExtWorkstationObject(item, isLayoutSelected('workstation', item.id));
  });
  config.layout.racks.forEach(function(item) {
    createExtRackObject(item, isLayoutSelected('rack', item.id));
  });
  config.layout.pillars.forEach(function(item) {
    createExtPillarObject(item, isLayoutSelected('pillar', item.id));
  });
  config.layout.safetyStations.forEach(function(item) {
    createExtSafetyObject(item, isLayoutSelected('safety', item.id));
  });
  config.layout.walls.forEach(function(wall) {
    createWallObject(wall, isLayoutSelected('wall', wall.id));
  });
  config.layout.doors.forEach(function(door) {
    createExtDoorObject(door, isLayoutSelected('door', door.id));
  });
};

function getExtLayoutListMeta(kind, item) {
  switch (kind) {
    case 'wall':
      return '长度 ' + formatNum(getWallLength(item)) + ' · 高 ' + formatNum(item.height);
    case 'door':
      return '开口 ' + formatNum(item.length) + ' · 高 ' + formatNum(item.height);
    case 'pillar':
      return '直径 ' + formatNum(item.diameter) + ' · 高 ' + formatNum(item.height);
    case 'path':
    case 'workstation':
      return '尺寸 ' + formatNum(item.width) + ' × ' + formatNum(item.depth);
    case 'rack':
      return '尺寸 ' + formatNum(item.width) + ' × ' + formatNum(item.depth) + ' · 层 ' + item.levels;
    case 'safety':
      return '类型 ' + (item.variant === 'exit' ? '出口' : item.variant === 'extinguisher' ? '灭火器' : '消火栓');
    case 'zone':
    default:
      return '尺寸 ' + formatNum(item.width) + ' × ' + formatNum(item.depth);
  }
}

function getExtLayoutListMetaEnhanced(kind, item) {
  switch (kind) {
    case 'wall':
      return '\u957f\u5ea6 ' + formatNum(getWallLength(item)) + ' \u00b7 \u9ad8 ' + formatNum(item.height);
    case 'door':
      return '\u5f00\u53e3 ' + formatNum(item.length) + ' \u00b7 \u9ad8 ' + formatNum(item.height);
    case 'pillar':
      return '\u76f4\u5f84 ' + formatNum(item.diameter) + ' \u00b7 \u9ad8 ' + formatNum(item.height);
    case 'path':
      return getExtPathVariantMeta(item.variant).label + ' \u00b7 ' + formatNum(item.width) + ' \u00d7 ' + formatNum(item.depth);
    case 'workstation':
      return getExtWorkstationVariantMeta(item.variant).label + ' \u00b7 ' + formatNum(item.width) + ' \u00d7 ' + formatNum(item.depth);
    case 'rack':
      return getExtRackVariantMeta(item.variant).label + ' \u00b7 ' + formatNum(item.width) + ' \u00d7 ' + formatNum(item.depth) + ' \u00b7 \u5c42 ' + item.levels;
    case 'safety':
      return '\u7c7b\u578b ' + (item.variant === 'exit' ? '\u51fa\u53e3' : item.variant === 'extinguisher' ? '\u706d\u706b\u5668' : '\u6d88\u706b\u6813');
    case 'zone':
    default:
      return '\u5c3a\u5bf8 ' + formatNum(item.width) + ' \u00d7 ' + formatNum(item.depth);
  }
}

window.renderLayoutList = renderLayoutList = function() {
  const el = document.getElementById('layout-list');
  if (!el) return;
  const items = getExtLayoutListItems();
  el.innerHTML = '';
  if (items.length === 0) {
    el.innerHTML = '<div class="empty-tip">还没有布局对象，开启布局编辑后可添加墙体、柱子、卷帘门、通道、工位、货架和消防设施。</div>';
    return;
  }
  items.forEach(function(entry) {
    const kind = entry.kind;
    const item = entry.item;
    const meta = getExtLayoutMeta(kind);
    const row = document.createElement('div');
    row.className = 'layout-entry' + (isLayoutSelected(kind, item.id) ? ' sel' : '');
    row.innerHTML =
      '<div class="layout-entry-icon">' + meta.icon + '</div>' +
      '<div class="layout-entry-info">' +
        '<div class="layout-entry-name">' + escapeHtml(item.name || meta.label) + '</div>' +
        '<div class="layout-entry-meta">' + escapeHtml(getExtLayoutListMetaEnhanced(kind, item)) + '</div>' +
      '</div>';
    row.addEventListener('click', function() {
      selectLayout(kind, item.id);
    });
    el.appendChild(row);
  });
};

function createExtInspectorTextField(label, value, onInput) {
  const field = document.createElement('div');
  field.className = 'layout-field';
  const title = document.createElement('label');
  title.textContent = label;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value || '';
  input.addEventListener('input', function() {
    onInput(input.value);
  });
  field.appendChild(title);
  field.appendChild(input);
  return field;
}

function createExtInspectorNumberField(label, value, min, max, step, onInput) {
  const field = document.createElement('div');
  field.className = 'layout-field';
  const title = document.createElement('label');
  title.textContent = label;
  const input = document.createElement('input');
  input.type = 'number';
  if (min != null) input.min = min;
  if (max != null) input.max = max;
  if (step != null) input.step = step;
  input.value = value;
  input.addEventListener('input', function() {
    onInput(Number(input.value));
  });
  field.appendChild(title);
  field.appendChild(input);
  return field;
}

function createExtInspectorSelectField(label, value, options, onChange) {
  const field = document.createElement('div');
  field.className = 'layout-field';
  const title = document.createElement('label');
  title.textContent = label;
  const select = document.createElement('select');
  options.forEach(function(option) {
    const el = document.createElement('option');
    el.value = option.value;
    el.textContent = option.label;
    if (option.value === value) el.selected = true;
    select.appendChild(el);
  });
  select.addEventListener('change', function() {
    onChange(select.value);
  });
  field.appendChild(title);
  field.appendChild(select);
  return field;
}

function refreshExtLayoutAfterEdit() {
  setLayoutDirty(true, false);
  rebuildLayoutScene();
  renderLayoutList();
  refreshLayoutChrome();
}

window.renderLayoutInspector = renderLayoutInspector = function() {
  const el = document.getElementById('layout-inspector');
  if (!el) return;
  ensureLayoutConfig();
  el.innerHTML = '';

  const building = config.layout.building;
  const shellTitle = document.createElement('div');
  shellTitle.className = 'layout-inspector-title';
  shellTitle.textContent = '车间外形';
  el.appendChild(shellTitle);

  const shellGrid = document.createElement('div');
  shellGrid.className = 'layout-grid';
  shellGrid.appendChild(createExtInspectorNumberField('宽度', building.width, 24, 140, 1, function(value) {
    applyLayoutBuildingChange({ width: value || building.width });
  }));
  shellGrid.appendChild(createExtInspectorNumberField('进深', building.depth, 18, 110, 1, function(value) {
    applyLayoutBuildingChange({ depth: value || building.depth });
  }));
  shellGrid.appendChild(createExtInspectorNumberField('檐高', building.wallH, 12, 56, 0.5, function(value) {
    applyLayoutBuildingChange({ wallH: value || building.wallH });
  }));
  shellGrid.appendChild(createExtInspectorNumberField('脊高', building.ridgeH, building.wallH + 6, 84, 0.5, function(value) {
    applyLayoutBuildingChange({ ridgeH: value || building.ridgeH });
  }));
  el.appendChild(shellGrid);

  const shellMeta = document.createElement('div');
  shellMeta.className = 'layout-meta';
  shellMeta.textContent = '修改车间尺寸后，会重新约束墙体、通道、工位、货架和设备位置，避免对象跑到车间边界之外。';
  el.appendChild(shellMeta);

  if (!selectedLayout) {
    const divider = document.createElement('div');
    divider.className = 'layout-divider';
    el.appendChild(divider);

    const emptyTitle = document.createElement('div');
    emptyTitle.className = 'layout-inspector-title';
    emptyTitle.textContent = '未选中对象';
    el.appendChild(emptyTitle);

    const emptyMeta = document.createElement('div');
    emptyMeta.className = 'layout-meta';
    emptyMeta.textContent = '选中墙体、柱子、卷帘门、通道、工位、货架、消防设施或区域后，可在这里调整尺寸与属性。';
    el.appendChild(emptyMeta);
    return;
  }

  const kind = selectedLayout.kind;
  const item = findLayoutItem(kind, selectedLayout.id);
  if (!item) {
    selectedLayout = null;
    renderLayoutInspector();
    return;
  }

  const meta = getExtLayoutMeta(kind);
  const divider = document.createElement('div');
  divider.className = 'layout-divider';
  el.appendChild(divider);

  const title = document.createElement('div');
  title.className = 'layout-inspector-title';
  title.textContent = meta.label + '属性';
  el.appendChild(title);

  el.appendChild(createExtInspectorTextField('名称', item.name || '', function(value) {
    item.name = value || getNextLayoutName(kind);
    refreshExtLayoutAfterEdit();
  }));

  const grid = document.createElement('div');
  grid.className = 'layout-grid';

  if (kind === 'wall') {
    const maxWallHeight = Math.max(8, BUILDING.ridgeH - 4);
    const thicknessBounds = getLayoutWallThicknessBounds();
    grid.appendChild(createExtInspectorNumberField('高度', item.height, 4, maxWallHeight, 0.5, function(value) {
      item.height = clamp(value || item.height, 4, maxWallHeight);
      refreshExtLayoutAfterEdit();
    }));
    grid.appendChild(createExtInspectorNumberField('厚度', item.thickness, thicknessBounds.min, thicknessBounds.max, 0.1, function(value) {
      item.thickness = clamp(value || item.thickness, thicknessBounds.min, thicknessBounds.max);
      refreshExtLayoutAfterEdit();
    }));
  } else if (kind === 'door') {
    grid.appendChild(createExtInspectorNumberField('宽度', item.length, 24, Math.max(36, BUILDING.width * 0.42), 1, function(value) {
      item.length = clamp(Math.abs(value) || item.length, 24, Math.max(36, BUILDING.width * 0.42));
      refreshExtLayoutAfterEdit();
    }));
    grid.appendChild(createExtInspectorNumberField('高度', item.height, 4, Math.max(6, BUILDING.wallH), 0.5, function(value) {
      item.height = clamp(value || item.height, 4, Math.max(6, BUILDING.wallH));
      refreshExtLayoutAfterEdit();
    }));
    grid.appendChild(createExtInspectorNumberField('厚度', item.thickness, 0.28, 3.2, 0.05, function(value) {
      item.thickness = clamp(value || item.thickness, 0.28, 3.2);
      refreshExtLayoutAfterEdit();
    }));
    grid.appendChild(createExtInspectorNumberField('旋转', item.rotation, 0, 359, 1, function(value) {
      item.rotation = getExtLayoutRotation(value);
      refreshExtLayoutAfterEdit();
    }));
    el.appendChild(grid);
    el.appendChild(createExtInspectorSelectField('门型', item.variant, [
      { value: 'rolling', label: '卷帘门' },
      { value: 'double', label: '双开门' }
    ], function(value) {
      item.variant = value;
      refreshExtLayoutAfterEdit();
    }));
  } else if (kind === 'pillar') {
    grid.appendChild(createExtInspectorNumberField('直径', item.diameter, 8, 36, 0.5, function(value) {
      item.diameter = clamp(Math.abs(value) || item.diameter, 8, 36);
      refreshExtLayoutAfterEdit();
    }));
    grid.appendChild(createExtInspectorNumberField('高度', item.height, 8, Math.max(BUILDING.wallH, BUILDING.ridgeH - 2), 0.5, function(value) {
      item.height = clamp(value || item.height, 8, Math.max(BUILDING.wallH, BUILDING.ridgeH - 2));
      refreshExtLayoutAfterEdit();
    }));
  } else if (kind === 'safety') {
    grid.appendChild(createExtInspectorNumberField('宽度', item.width, 8, 32, 0.5, function(value) {
      item.width = clamp(Math.abs(value) || item.width, 8, 32);
      refreshExtLayoutAfterEdit();
    }));
    grid.appendChild(createExtInspectorNumberField('深度', item.depth, 6, 24, 0.5, function(value) {
      item.depth = clamp(Math.abs(value) || item.depth, 6, 24);
      refreshExtLayoutAfterEdit();
    }));
    grid.appendChild(createExtInspectorNumberField('高度', item.height, 1.4, 5, 0.1, function(value) {
      item.height = clamp(value || item.height, 1.4, 5);
      refreshExtLayoutAfterEdit();
    }));
    el.appendChild(grid);
    el.appendChild(createExtInspectorSelectField('设施类型', item.variant, [
      { value: 'hydrant', label: '消火栓柜' },
      { value: 'extinguisher', label: '灭火器' },
      { value: 'exit', label: '应急出口牌' }
    ], function(value) {
      item.variant = value;
      refreshExtLayoutAfterEdit();
    }));
  } else {
    const maxWidth = Math.max(24, BUILDING.width - 2.4);
    const maxDepth = Math.max(12, BUILDING.depth - 2.4);
    grid.appendChild(createExtInspectorNumberField('宽度', item.width, 2, maxWidth, 0.5, function(value) {
      item.width = clamp(Math.abs(value) || item.width, kind === 'zone' ? 2 : 12, maxWidth);
      const point = clampExtRectCenter(item.x, item.z, item.width, item.depth, 1.2);
      item.x = point.x;
      item.z = point.z;
      refreshExtLayoutAfterEdit();
    }));
    grid.appendChild(createExtInspectorNumberField('深度', item.depth, 2, maxDepth, 0.5, function(value) {
      item.depth = clamp(Math.abs(value) || item.depth, kind === 'zone' ? 2 : 12, maxDepth);
      const point = clampExtRectCenter(item.x, item.z, item.width, item.depth, 1.2);
      item.x = point.x;
      item.z = point.z;
      refreshExtLayoutAfterEdit();
    }));
    if (kind !== 'zone') {
      grid.appendChild(createExtInspectorNumberField('旋转', item.rotation, 0, 359, 1, function(value) {
        item.rotation = getExtLayoutRotation(value);
        refreshExtLayoutAfterEdit();
      }));
    }
    if (kind === 'workstation') {
      grid.appendChild(createExtInspectorNumberField('台高', item.height, 2, 14, 0.1, function(value) {
        item.height = clamp(value || item.height, 2, 14);
        refreshExtLayoutAfterEdit();
      }));
    } else if (kind === 'rack') {
      grid.appendChild(createExtInspectorNumberField('高度', item.height, 4, 18, 0.5, function(value) {
        item.height = clamp(value || item.height, 4, 18);
        refreshExtLayoutAfterEdit();
      }));
      grid.appendChild(createExtInspectorNumberField('层数', item.levels, 2, 6, 1, function(value) {
        item.levels = clamp(Math.round(value || item.levels), 2, 6);
        refreshExtLayoutAfterEdit();
      }));
    }
  }

  el.appendChild(grid);

  if (kind === 'path') {
    el.appendChild(createExtInspectorSelectField('\u901a\u9053\u7c7b\u578b', getExtPathVariant(item.variant), [
      { value: 'human', label: '\u4eba\u884c\u901a\u9053' },
      { value: 'forklift', label: '\u53c9\u8f66\u901a\u9053' }
    ], function(value) {
      item.variant = getExtPathVariant(value);
      item.color = getExtPathVariantMeta(item.variant).color;
      refreshExtLayoutAfterEdit();
    }));
  } else if (kind === 'workstation') {
    el.appendChild(createExtInspectorSelectField('\u4f5c\u4e1a\u7c7b\u578b', getExtWorkstationVariant(item.variant), [
      { value: 'station', label: '\u5de5\u4f4d' },
      { value: 'line', label: '\u6574\u6761\u4ea7\u7ebf' },
      { value: 'cigarette', label: '\u5377\u5305\u673a' }
    ], function(value) {
      item.variant = getExtWorkstationVariant(value);
      refreshExtLayoutAfterEdit();
    }));
    const snappedDirection = String((Math.round(getExtLayoutRotation(item.rotation) / 90) % 4) * 90);
    el.appendChild(createExtInspectorSelectField('\u65b9\u5411', snappedDirection, [
      { value: '0', label: '\u6a2a\u5411 (0\u00b0)' },
      { value: '90', label: '\u7eb5\u5411 (90\u00b0)' },
      { value: '180', label: '\u6a2a\u5411 \u53cd (180\u00b0)' },
      { value: '270', label: '\u7eb5\u5411 \u53cd (270\u00b0)' }
    ], function(value) {
      item.rotation = getExtLayoutRotation(Number(value));
      refreshExtLayoutAfterEdit();
    }));
  } else if (kind === 'rack') {
    el.appendChild(createExtInspectorSelectField('\u8d27\u67b6\u7c7b\u578b', getExtRackVariant(item.variant), [
      { value: 'single', label: '\u5355\u6392\u8d27\u67b6' },
      { value: 'double', label: '\u53cc\u6392\u8d27\u67b6' }
    ], function(value) {
      item.variant = getExtRackVariant(value);
      refreshExtLayoutAfterEdit();
    }));
  }

  const metaLine = document.createElement('div');
  metaLine.className = 'layout-meta';
  metaLine.textContent =
    kind === 'wall'
      ? ('墙体长度 ' + formatNum(getWallLength(item)) + '，端点可通过重新绘制来调整。')
      : ('中心位于 (' + formatNum(item.x) + ', ' + formatNum(item.z) + ')。');
  el.appendChild(metaLine);
};

function buildExtLinePreview(kind, start, end) {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const len = Math.hypot(dx, dz);
  if (len < 1.5) return null;
  const angle = Math.atan2(dx, dz);
  const cx = (start.x + end.x) / 2;
  const cz = (start.z + end.z) / 2;
  const meta = getExtLayoutMeta(kind);
  const group = new THREE.Group();
  group.position.set(cx, 0, cz);
  group.rotation.y = angle;
  const height = kind === 'door' ? Math.min(BUILDING.wallH * 0.7, 12) : 12;
  const thickness = kind === 'door' ? 0.95 : getLayoutWallThicknessBounds().value;
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(kind === 'door' ? len : thickness, height, kind === 'door' ? thickness : len),
    new THREE.MeshStandardMaterial({
      color: meta.accentHex,
      transparent: true,
      opacity: 0.5
    })
  );
  mesh.position.y = height / 2;
  group.add(mesh);
  scene.add(group);
  return { group, textures: [] };
}

function buildExtRectPreview(kind, start, end) {
  const width = Math.abs(end.x - start.x);
  const depth = Math.abs(end.z - start.z);
  if (width < 1.5 || depth < 1.5) return null;
  const cx = (start.x + end.x) / 2;
  const cz = (start.z + end.z) / 2;
  const meta = getExtLayoutMeta(kind);
  const group = new THREE.Group();
  group.position.set(cx, 0, cz);
  const fill = new THREE.Mesh(
    new THREE.PlaneGeometry(width, depth),
    createFloorOverlayMaterial({
      color: new THREE.Color(meta.accent),
      transparent: true,
      opacity: 0.22
    }, 'preview')
  );
  fill.rotation.x = -Math.PI / 2;
  applyFloorOverlayProfile(fill, FLOOR_LAYER.preview, 'preview');
  group.add(fill);
  group.add(createExtRectBorder(width, depth, meta.accentHex, 0.9, FLOOR_LAYER.border, FLOOR_RENDER_ORDER.preview + 1));
  scene.add(group);
  return { group, textures: [] };
}

window.updateLayoutPreview = updateLayoutPreview = function() {
  clearLayoutPreview();
  if (!layoutDrawState) return;
  const kind = layoutDrawState.tool;
  if (EXT_LAYOUT_LINE_TOOLS.has(kind)) {
    layoutPreview = buildExtLinePreview(kind, layoutDrawState.start, layoutDrawState.current);
  } else if (EXT_LAYOUT_RECT_TOOLS.has(kind)) {
    layoutPreview = buildExtRectPreview(kind, layoutDrawState.start, layoutDrawState.current);
  }
};

function createExtPointItem(kind, point) {
  if (kind === 'pillar') {
    return normalizeExtPillar({
      id: makeLayoutId('pillar'),
      name: getNextLayoutName('pillar'),
      x: point.x,
      z: point.z
    }, getLayoutCollection('pillar').length);
  }
  return normalizeExtSafety({
    id: makeLayoutId('safety'),
    name: getNextLayoutName('safety'),
    x: point.x,
    z: point.z
  }, getLayoutCollection('safety').length);
}

function createExtLineItem(kind, start, current) {
  if (kind === 'wall') {
    return normalizeWall({
      id: makeLayoutId('wall'),
      name: getNextLayoutName('wall'),
      x1: start.x,
      z1: start.z,
      x2: current.x,
      z2: current.z,
      height: 12,
      thickness: getLayoutWallThicknessBounds().value
    }, getLayoutCollection('wall').length);
  }
  const length = Math.hypot(current.x - start.x, current.z - start.z);
  if (length < 1.5) return null;
  return normalizeExtDoor({
    id: makeLayoutId('door'),
    name: getNextLayoutName('door'),
    x: (start.x + current.x) / 2,
    z: (start.z + current.z) / 2,
    length,
    rotation: Math.atan2(current.x - start.x, current.z - start.z) * 180 / Math.PI,
    variant: 'rolling'
  }, getLayoutCollection('door').length);
}

function createExtRectItem(kind, start, current) {
  const width = Math.abs(current.x - start.x);
  const depth = Math.abs(current.z - start.z);
  if (width < 1.5 || depth < 1.5) return null;
  const payload = {
    id: makeLayoutId(kind),
    name: getNextLayoutName(kind),
    x: (start.x + current.x) / 2,
    z: (start.z + current.z) / 2,
    width,
    depth
  };
  switch (kind) {
    case 'zone':
      return normalizeZone(payload, getLayoutCollection('zone').length);
    case 'path':
      return normalizeExtPath(payload, getLayoutCollection('path').length);
    case 'workstation':
      return normalizeExtWorkstation(payload, getLayoutCollection('workstation').length);
    case 'rack':
      return normalizeExtRack(payload, getLayoutCollection('rack').length);
    default:
      return null;
  }
}

window.finishLayoutDraw = finishLayoutDraw = function() {
  if (!layoutDrawState) return;
  const kind = layoutDrawState.tool;
  let next = null;
  if (EXT_LAYOUT_LINE_TOOLS.has(kind)) {
    next = createExtLineItem(kind, layoutDrawState.start, layoutDrawState.current);
  } else if (EXT_LAYOUT_RECT_TOOLS.has(kind)) {
    next = createExtRectItem(kind, layoutDrawState.start, layoutDrawState.current);
  }
  if (next) {
    getLayoutCollection(kind).push(next);
    selectedLayout = { kind, id: next.id };
    setLayoutDirty(true);
  }
  layoutDrawState = null;
  clearLayoutPreview();
  rebuildLayoutScene();
  updateLayoutUI();
};

window.handleLayoutPointerDown = handleLayoutPointerDown = function() {
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
  if (EXT_LAYOUT_POINT_TOOLS.has(layoutTool)) {
    const created = createExtPointItem(layoutTool, groundPoint);
    if (created) {
      getLayoutCollection(layoutTool).push(created);
      selectedLayout = { kind: layoutTool, id: created.id };
      setLayoutDirty(true);
      rebuildLayoutScene();
      updateLayoutUI();
    }
    return true;
  }
  layoutDrawState = {
    tool: layoutTool,
    start: { x: groundPoint.x, z: groundPoint.z },
    current: { x: groundPoint.x, z: groundPoint.z }
  };
  controls.enabled = false;
  updateLayoutPreview();
  return true;
};

window.handleLayoutPointerMove = handleLayoutPointerMove = function() {
  if (!layoutMode || !layoutDrawState) return false;
  const groundPoint = getGroundPoint();
  if (!groundPoint) return true;
  layoutDrawState.current = { x: groundPoint.x, z: groundPoint.z };
  updateLayoutPreview();
  return true;
};

window.handleLayoutPointerUp = handleLayoutPointerUp = function() {
  if (!layoutMode || !layoutDrawState) return false;
  controls.enabled = true;
  finishLayoutDraw();
  return true;
};

window.updateSceneHint = updateSceneHint = function() {
  const el = document.getElementById('scene-hint');
  if (!el) return;
  if (walkMode) {
    el.textContent = walkPointerLocked
      ? '\u7b2c\u4e00\u4eba\u79f0\u6f2b\u6e38 \u00b7 WASD/\u65b9\u5411\u952e\u884c\u8d70 \u00b7 Shift \u52a0\u901f \u00b7 \u79fb\u52a8\u9f20\u6807\u89c2\u5bdf \u00b7 Esc \u9000\u51fa'
      : '\u7b2c\u4e00\u4eba\u79f0\u6f2b\u6e38 \u00b7 \u70b9\u51fb\u573a\u666f\u9501\u5b9a\u9f20\u6807 \u00b7 WASD/\u65b9\u5411\u952e\u884c\u8d70 \u00b7 Esc \u9000\u51fa';
    return;
  }
  if (lightPlacementIndex != null && editingLights[lightPlacementIndex]) {
    const deviceMeta = getItemMeta(editingLights[lightPlacementIndex].type);
    el.textContent = '场景选点中 · 在地面点击放置「' + deviceMeta.label + '」 · WASD/方向键/小键盘平移 · 按 Esc 取消并返回配置';
    return;
  }
  if (layoutMode) {
    switch (layoutTool) {
      case 'select':
        el.textContent = '布局编辑中 · 点击场景对象即可选中，在右侧修改建筑和管理属性。';
        break;
      case 'wall':
        el.textContent = '布局编辑中 · 在地面拖拽绘制墙体。';
        break;
      case 'door':
        el.textContent = '布局编辑中 · 沿着墙面方向拖拽生成卷帘门或双开门开口。';
        break;
      case 'pillar':
        el.textContent = '布局编辑中 · 点击地面即可落下柱子。';
        break;
      case 'path':
        el.textContent = '布局编辑中 · 拖拽框选一段人车通道。';
        break;
      case 'workstation':
        el.textContent = '布局编辑中 · 拖拽框选一个生产线工位区域。';
        break;
      case 'rack':
        el.textContent = '布局编辑中 · 拖拽框选一个货架仓位。';
        break;
      case 'safety':
        el.textContent = '布局编辑中 · 点击地面放置消防设施。';
        break;
      default:
        el.textContent = '布局编辑中 · 拖拽框选一片区域，便于做功能分区。';
        break;
    }
    return;
  }
  if (editMode) {
    el.textContent = '🖱 拖动旋转 · 滚轮缩放 · 按住电器拖动位置 · WASD/方向键/小键盘平移';
    return;
  }
  el.textContent = '🖱 拖动旋转 · 滚轮缩放 · 点击图标切换 · 按住图标拖动位置 · WASD/方向键/小键盘平移';
};

window.refreshLayoutChrome = refreshLayoutChrome = function() {
  const toggleBtn = document.getElementById('layout-toggle-btn');
  if (toggleBtn) {
    toggleBtn.textContent = layoutMode ? '退出编辑' : '布局编辑';
    toggleBtn.className = 'btn ' + (layoutMode ? 'btn-primary' : 'btn-ghost');
  }
  EXT_LAYOUT_TOOL_ORDER.forEach(function(tool) {
    const btn = document.getElementById('tool-' + tool);
    if (!btn) return;
    if (tool !== 'select') btn.disabled = !layoutMode;
    btn.classList.toggle('active', layoutTool === tool);
  });

  const saveBtn = document.getElementById('layout-save-btn');
  if (saveBtn) saveBtn.textContent = layoutDirty ? '保存布局' : '布局已保存';
  const delBtn = document.getElementById('layout-del-btn');
  if (delBtn) delBtn.disabled = !selectedLayout;

  const counts = getExtLayoutCounts(config.layout);
  const statusEl = document.getElementById('layout-status');
  if (statusEl) {
    statusEl.textContent =
      '结构 ' + counts.structures +
      ' · 区域 ' + counts.zones +
      ' · ' + (layoutDirty ? '未保存' : '已保存') +
      ' · ' + (layoutMode ? '编辑中' : '浏览中');
  }

  const helpEl = document.getElementById('layout-help');
  if (helpEl) {
    if (!layoutMode) {
      helpEl.textContent = '开启布局编辑后，可以在场景里添加柱子、卷帘门、通道、工位、货架、消防设施，以及原有的墙体和区域。';
    } else if (layoutTool === 'select') {
      helpEl.textContent = '当前是选择工具。点击任意布局对象后，可在下方直接修改名称、尺寸和类型。';
    } else if (layoutTool === 'wall') {
      helpEl.textContent = '当前是画墙工具。拖出一段距离后松开即可生成墙体。';
    } else if (layoutTool === 'door') {
      helpEl.textContent = '当前是卷帘门工具。沿着墙面方向拖拽，可建立门洞和出入口。';
    } else if (layoutTool === 'pillar') {
      helpEl.textContent = '当前是柱子工具。点击地面即可放置车间立柱。';
    } else if (layoutTool === 'path') {
      helpEl.textContent = '当前是通道工具。拖拽框选后可标识物流或人行通道。';
    } else if (layoutTool === 'workstation') {
      helpEl.textContent = '当前是工位工具。拖拽后可快速定义生产线工位或工序区域。';
    } else if (layoutTool === 'rack') {
      helpEl.textContent = '当前是货架工具。拖拽后可创建仓位与存储区。';
    } else if (layoutTool === 'safety') {
      helpEl.textContent = '当前是消防工具。点击地面后可放置消火栓、灭火器或应急出口标识。';
    } else {
      helpEl.textContent = '当前是区域工具。拖拽框出功能分区后，可继续命名和调整尺寸。';
    }
  }

  updateSceneHint();
  updateCanvasCursor();
  refreshPanelSections();
};

window.refreshPanelSections = refreshPanelSections = function() {
  const layout = config.layout || DEFAULT_LAYOUT;
  const counts = getExtLayoutCounts(layout);
  const deviceCount = (config.devices || []).length;
  const connectedCount = getConnectedDeviceCount();
  const lightCount = (config.lights || []).length;
  const lightOnCount = getLightOnCount();
  const metaText = {
    devices: deviceCount === 0
      ? 'No devices'
      : connectedCount + ' / ' + deviceCount + ' connected',
    appliances: lightCount === 0
      ? 'No items'
      : lightOnCount + ' / ' + lightCount + ' on',
    layout: counts.structures + ' objects / ' + counts.zones + ' zones'
  };

  Object.keys(PANEL_SECTION_DEFAULTS).forEach(function(key) {
    const open = !!panelSections[key];
    const root = document.getElementById('section-' + key);
    const body = document.getElementById('body-' + key);
    const toggle = document.querySelector('[data-section-toggle="' + key + '"]');
    const meta = document.getElementById('meta-' + key);
    if (root) root.classList.toggle('open', open);
    if (body) body.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (meta) meta.textContent = metaText[key];
  });

  const miniDevices = document.getElementById('mini-devices');
  const miniAppliances = document.getElementById('mini-appliances');
  const miniLayout = document.getElementById('mini-layout');
  if (miniDevices) miniDevices.textContent = String(deviceCount);
  if (miniAppliances) miniAppliances.textContent = String(lightOnCount);
  if (miniLayout) miniLayout.textContent = String(counts.total);
};

config.layout = normalizeLayoutData(config.layout);
rebuildLayoutScene();
updateLayoutUI();
refreshPanelSections();
