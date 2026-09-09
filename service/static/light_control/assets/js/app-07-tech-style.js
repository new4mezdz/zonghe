/* =============================================================================
 * app-07-tech-style.js - Tech / cyber night style overlay
 * -----------------------------------------------------------------------------
 * Independent, reversible style layer for the Three.js factory scene.
 * Console API: TechStyle.on/off/toggle/refresh/isOn
 *              TechStyle.setShellMode('curtain'|'panel')
 *              TechStyle.setGlowColor('#00e5ff')
 *              TechStyle.setBloom(strength, radius, threshold)
 * ========================================================================== */
(function () {
  'use strict';

  if (typeof THREE === 'undefined' || typeof scene === 'undefined') {
    console.warn('[TechStyle] THREE / scene is not ready; module skipped.');
    return;
  }

  const S = typeof SCALE !== 'undefined' ? SCALE : 1;
  const cfg = {
    enabled: false,
    bg: 0x05080f,
    floorIndoor: 0x0a1220,
    floorOutdoor: 0x060b14,
    grid: 0x1d3a5f,
    glow: 0x00e5ff,
    glowSoft: 0x2979ff,
    curtainColor: 0x0e1e33,
    roofColor: 0x0a121e,
    fogNear: 60 * S,
    fogFar: 190 * S,
    moon: { color: 0xbfd8ff, intensity: 0.20 },
    ambient: { color: 0x1c2942, intensity: 0.12 },
    hemi: { sky: 0x16223a, ground: 0x05080a, intensity: 0.30 },
    fill: { color: 0x24406b, intensity: 0.10 },
    metalness: 0.85,
    roughness: 0.30,
    edgeThresholdAngle: 30,
    edgeOpacity: 0.55,
    edgeMinDim: 0.6,
    shellMode: 'curtain',
    curtainOpacity: 0.35,
    fresnelPower: 3.0,
    fresnelScale: 1.015,
    floorGrid: true,
    floorRoughness: 0.22,
    floorMetalness: 0.20,
    floorReflect: 0.7,
    bloom: true,
    bloomStrength: 0.85,
    bloomRadius: 0.4,
    bloomThreshold: 0.85,
    flowSpeed: 0.35,
    scanEnabled: true,
    scanPeriod: 6.0
  };

  const overlays = [];
  const flowItems = [];
  const createdTextures = new Set();
  let sceneSaved = null;
  let techFloorTex = null;
  let nightEnvTex = null;
  let panelTextures = null;
  let composer = null;
  let bloomPass = null;
  let resizeBound = false;
  let rafId = null;
  let lastTick = 0;
  let scanMesh = null;
  let pending = null;
  let labelPatched = false;
  let originalDrawLabel = null;
  const sizeProbe = new THREE.Vector2();

  function parseHex(value, fallback) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const n = parseInt(value.replace('#', ''), 16);
      if (Number.isFinite(n)) return n;
    }
    return fallback;
  }

  function cssHex(value) {
    return '#' + ('000000' + parseHex(value, 0).toString(16)).slice(-6);
  }

  function setTextureColorSpace(tex) {
    if (!tex) return tex;
    if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    else if (THREE.sRGBEncoding) tex.encoding = THREE.sRGBEncoding;
    return tex;
  }

  function registerTexture(tex) {
    if (!tex) return tex;
    tex.userData = tex.userData || {};
    tex.userData.techOverlay = true;
    tex.userData.techSkip = true;
    createdTextures.add(tex);
    return tex;
  }

  function disposeMaterial(material) {
    if (!material) return;
    if (Array.isArray(material)) {
      material.forEach(disposeMaterial);
      return;
    }
    if (material.dispose) material.dispose();
  }

  function disposeObject(obj) {
    if (!obj) return;
    obj.traverse(function (node) {
      if (node.geometry && node.geometry.dispose) node.geometry.dispose();
      disposeMaterial(node.material);
    });
  }

  function registerOverlay(obj, owner, key) {
    if (!obj) return obj;
    obj.userData = obj.userData || {};
    obj.userData.techOverlay = true;
    obj.userData.techSkip = true;
    overlays.push({ object: obj, owner: owner || null, key: key || null });
    return obj;
  }

  function removeOverlays() {
    overlays.splice(0).forEach(function (entry) {
      const obj = entry.object;
      if (entry.owner && entry.key && entry.owner.userData) {
        if (entry.owner.userData[entry.key] === obj) delete entry.owner.userData[entry.key];
      }
      if (obj && obj.parent) obj.parent.remove(obj);
      disposeObject(obj);
    });
    flowItems.splice(0);
    scanMesh = null;
  }

  function disposeCreatedTextures() {
    createdTextures.forEach(function (tex) {
      if (tex && tex.dispose) tex.dispose();
    });
    createdTextures.clear();
    techFloorTex = null;
    nightEnvTex = null;
    panelTextures = null;
  }

  function saveMaterial(material, keys) {
    if (!material) return;
    material.userData = material.userData || {};
    const saved = material.userData.__techSaved || {};
    keys.forEach(function (key) {
      if (Object.prototype.hasOwnProperty.call(saved, key)) return;
      if ((key === 'color' || key === 'emissive') && material[key] && material[key].isColor) {
        saved[key] = material[key].getHex();
      } else {
        saved[key] = material[key];
      }
    });
    material.userData.__techSaved = saved;
  }

  function restoreMaterial(material) {
    const saved = material && material.userData && material.userData.__techSaved;
    if (!saved) return;
    Object.keys(saved).forEach(function (key) {
      if ((key === 'color' || key === 'emissive') && material[key] && material[key].isColor) {
        material[key].setHex(saved[key]);
      } else {
        material[key] = saved[key];
      }
    });
    delete material.userData.__techSaved;
    material.needsUpdate = true;
  }

  function saveObject(obj, keys) {
    obj.userData = obj.userData || {};
    const saved = obj.userData.__techObjSaved || {};
    keys.forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(saved, key)) saved[key] = obj[key];
    });
    obj.userData.__techObjSaved = saved;
  }

  function restoreObject(obj) {
    const saved = obj && obj.userData && obj.userData.__techObjSaved;
    if (!saved) return;
    Object.keys(saved).forEach(function (key) { obj[key] = saved[key]; });
    delete obj.userData.__techObjSaved;
  }

  function restoreAllMaterialsAndObjects() {
    const seen = new Set();
    scene.traverse(function (obj) {
      restoreObject(obj);
      if (!obj.material) return;
      const list = Array.isArray(obj.material) ? obj.material : [obj.material];
      list.forEach(function (mat) {
        if (mat && !seen.has(mat)) {
          seen.add(mat);
          restoreMaterial(mat);
        }
      });
    });
  }

  function applySceneBase() {
    if (!sceneSaved) {
      sceneSaved = {
        background: scene.background && scene.background.isColor ? scene.background.clone() : scene.background,
        fog: scene.fog ? {
          ref: scene.fog,
          color: scene.fog.color.clone(),
          near: scene.fog.near,
          far: scene.fog.far
        } : null,
        environment: scene.environment || null
      };
    }
    scene.background = new THREE.Color(cfg.bg);
    if (!scene.fog) scene.fog = new THREE.Fog(cfg.bg, cfg.fogNear, cfg.fogFar);
    scene.fog.color.setHex(cfg.bg);
    scene.fog.near = cfg.fogNear;
    scene.fog.far = cfg.fogFar;
    scene.environment = makeNightEnv();
  }

  function restoreSceneBase() {
    if (!sceneSaved) return;
    scene.background = sceneSaved.background && sceneSaved.background.isColor
      ? sceneSaved.background.clone()
      : sceneSaved.background;
    if (sceneSaved.fog) {
      scene.fog = sceneSaved.fog.ref || scene.fog;
      if (scene.fog) {
        scene.fog.color.copy(sceneSaved.fog.color);
        scene.fog.near = sceneSaved.fog.near;
        scene.fog.far = sceneSaved.fog.far;
      }
    } else {
      scene.fog = null;
    }
    scene.environment = sceneSaved.environment || null;
    sceneSaved = null;
  }

  function saveLight(light) {
    light.userData = light.userData || {};
    if (light.userData.__techSaved) return;
    light.userData.__techSaved = {
      color: light.color && light.color.isColor ? light.color.getHex() : null,
      groundColor: light.groundColor && light.groundColor.isColor ? light.groundColor.getHex() : null,
      intensity: light.intensity
    };
  }

  function applyLighting() {
    const ambient = [];
    const hemi = [];
    const dirs = [];
    scene.traverse(function (obj) {
      if (!obj || !obj.isLight || (obj.userData && (obj.userData.techOverlay || obj.userData.techSkip))) return;
      if (obj.isAmbientLight) ambient.push(obj);
      else if (obj.isHemisphereLight) hemi.push(obj);
      else if (obj.isDirectionalLight) dirs.push(obj);
    });
    ambient.forEach(function (light) {
      saveLight(light);
      light.color.setHex(cfg.ambient.color);
      light.intensity = cfg.ambient.intensity;
    });
    hemi.forEach(function (light) {
      saveLight(light);
      light.color.setHex(cfg.hemi.sky);
      light.groundColor.setHex(cfg.hemi.ground);
      light.intensity = cfg.hemi.intensity;
    });
    dirs.forEach(function (light, index) {
      const next = index === 0 ? cfg.moon : cfg.fill;
      saveLight(light);
      light.color.setHex(next.color);
      light.intensity = next.intensity;
    });
  }

  function restoreLighting() {
    scene.traverse(function (obj) {
      const saved = obj && obj.userData && obj.userData.__techSaved;
      if (!saved || !obj.isLight) return;
      if (saved.color != null && obj.color) obj.color.setHex(saved.color);
      if (saved.groundColor != null && obj.groundColor) obj.groundColor.setHex(saved.groundColor);
      obj.intensity = saved.intensity;
      delete obj.userData.__techSaved;
    });
  }

  function updateFloorRepeat(tex) {
    if (!tex || !tex.repeat) return tex;
    const w = typeof BUILDING !== 'undefined' ? BUILDING.configWidth || BUILDING.width || 60 : 60;
    const d = typeof BUILDING !== 'undefined' ? BUILDING.configDepth || BUILDING.depth || 40 : 40;
    tex.repeat.set(Math.max(6, w / 10), Math.max(4, d / 10));
    return tex;
  }

  function makeTechFloorTexture() {
    if (techFloorTex) return updateFloorRepeat(techFloorTex);
    const cv = document.createElement('canvas');
    cv.width = 512;
    cv.height = 512;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = cssHex(cfg.floorIndoor);
    ctx.fillRect(0, 0, 512, 512);
    ctx.lineCap = 'square';
    for (let i = 0; i <= 512; i += 32) {
      const major = i % 128 === 0;
      ctx.strokeStyle = major ? 'rgba(0,229,255,0.34)' : 'rgba(29,58,95,0.55)';
      ctx.lineWidth = major ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(i + 0.5, 0);
      ctx.lineTo(i + 0.5, 512);
      ctx.moveTo(0, i + 0.5);
      ctx.lineTo(512, i + 0.5);
      ctx.stroke();
    }
    const tex = registerTexture(setTextureColorSpace(new THREE.CanvasTexture(cv)));
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    techFloorTex = tex;
    return updateFloorRepeat(tex);
  }

  function makeNightEnv() {
    if (nightEnvTex) return nightEnvTex;
    const cv = document.createElement('canvas');
    cv.width = 64;
    cv.height = 256;
    const ctx = cv.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0.00, '#0b1524');
    grad.addColorStop(0.42, '#10223a');
    grad.addColorStop(0.70, '#07101c');
    grad.addColorStop(1.00, '#02050a');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 256);
    [86, 116, 142].forEach(function (y, idx) {
      const band = ctx.createLinearGradient(0, 0, 64, 0);
      band.addColorStop(0, 'rgba(30,74,107,0)');
      band.addColorStop(0.18, 'rgba(30,74,107,' + (0.25 + idx * 0.08) + ')');
      band.addColorStop(0.52, 'rgba(0,229,255,' + (0.18 + idx * 0.05) + ')');
      band.addColorStop(1, 'rgba(30,74,107,0)');
      ctx.fillStyle = band;
      ctx.fillRect(0, y, 64, 3 + idx);
    });
    const tex = registerTexture(setTextureColorSpace(new THREE.CanvasTexture(cv)));
    tex.mapping = THREE.EquirectangularReflectionMapping;
    nightEnvTex = tex;
    return tex;
  }

  function isFloorPlane(mesh) {
    if (!mesh || !mesh.isMesh || Array.isArray(mesh.material)) return false;
    if (mesh.userData && (mesh.userData.techOverlay || mesh.userData.techSkip)) return false;
    if (mesh.userData && (mesh.userData.techTag === 'ground' || mesh.userData.techTag === 'outdoor')) return true;
    const g = mesh.geometry;
    const m = mesh.material;
    if (!g || g.type !== 'PlaneGeometry') return false;
    if (mesh.renderOrder && mesh.renderOrder !== 0) return false;
    return m && m.isMeshStandardMaterial && m.visible !== false && m.transparent !== true &&
      (m.blending === undefined || m.blending === THREE.NormalBlending) &&
      !(m.userData && m.userData.renderOrder !== undefined);
  }

  function applyFloor(mesh) {
    const m = mesh.material;
    saveMaterial(m, ['color', 'roughness', 'metalness', 'map', 'envMap', 'envMapIntensity']);
    const saved = m.userData.__techSaved;
    const base = new THREE.Color(saved.color);
    const lum = 0.299 * base.r + 0.587 * base.g + 0.114 * base.b;
    const indoor = mesh.userData && mesh.userData.techTag
      ? mesh.userData.techTag === 'ground'
      : lum > 0.5;
    m.color.setHex(indoor ? cfg.floorIndoor : cfg.floorOutdoor);
    m.map = indoor && cfg.floorGrid ? makeTechFloorTexture() : null;
    m.roughness = cfg.floorRoughness;
    m.metalness = cfg.floorMetalness;
    m.envMap = makeNightEnv();
    m.envMapIntensity = cfg.floorReflect;
    m.needsUpdate = true;
  }

  function structuralMats(mesh) {
    if (!mesh || !mesh.isMesh || mesh.isLine || mesh.isLineSegments || mesh.isSprite) return null;
    const ud = mesh.userData || {};
    if (ud.softSkip || ud.techSkip || ud.techOverlay) return null;
    if (mesh.renderOrder && mesh.renderOrder !== 0) return null;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const ok = list.filter(function (m) {
      return m && m.isMeshStandardMaterial &&
        m.visible !== false &&
        m.transparent !== true &&
        (m.blending === undefined || m.blending === THREE.NormalBlending) &&
        !(m.userData && m.userData.renderOrder !== undefined);
    });
    return ok.length ? ok : null;
  }

  function metalizeMat(m) {
    saveMaterial(m, ['metalness', 'roughness', 'envMap', 'envMapIntensity']);
    m.metalness = cfg.metalness;
    m.roughness = cfg.roughness;
    if (!m.envMap) m.envMap = makeNightEnv();
    m.envMapIntensity = Math.max(m.envMapIntensity || 0, 0.45);
    m.needsUpdate = true;
  }

  function geometryMinDim(mesh) {
    const g = mesh.geometry;
    const p = g && g.parameters;
    if (!p) return 0;
    if (g.type === 'BoxGeometry') return Math.min(p.width || 0, p.height || 0, p.depth || 0);
    if (g.type === 'CylinderGeometry') {
      const r = Math.max(p.radiusTop || 0, p.radiusBottom || 0) * 2;
      return Math.min(r, p.height || 0);
    }
    return 0;
  }

  function addEdge(mesh) {
    if (mesh.userData.__techEdge || Array.isArray(mesh.material)) return;
    const g = mesh.geometry;
    if (!g || (g.type !== 'BoxGeometry' && g.type !== 'CylinderGeometry')) return;
    if (geometryMinDim(mesh) < cfg.edgeMinDim) return;
    const edgeGeo = new THREE.EdgesGeometry(g, cfg.edgeThresholdAngle);
    const edgeMat = new THREE.LineBasicMaterial({
      color: cfg.glow,
      transparent: true,
      opacity: cfg.edgeOpacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const edge = new THREE.LineSegments(edgeGeo, edgeMat);
    edge.renderOrder = (mesh.renderOrder || 0) + 1;
    registerOverlay(edge, mesh, '__techEdge');
    mesh.userData.__techEdge = edge;
    mesh.add(edge);
  }

  function updatePanelRepeat(tex) {
    if (!tex || !tex.repeat) return tex;
    const w = typeof BUILDING !== 'undefined' ? BUILDING.configWidth || BUILDING.width || 60 : 60;
    tex.repeat.set(Math.max(6, w / 8), 1);
    return tex;
  }

  function makeTechPanelTextures() {
    if (panelTextures) {
      updatePanelRepeat(panelTextures.map);
      updatePanelRepeat(panelTextures.emissiveMap);
      return panelTextures;
    }
    const mapCv = document.createElement('canvas');
    mapCv.width = 512;
    mapCv.height = 512;
    const mapCtx = mapCv.getContext('2d');
    mapCtx.fillStyle = '#0d141f';
    mapCtx.fillRect(0, 0, 512, 512);
    mapCtx.strokeStyle = 'rgba(29,58,95,0.72)';
    mapCtx.lineWidth = 2;
    for (let x = 0; x <= 512; x += 64) {
      mapCtx.beginPath();
      mapCtx.moveTo(x + 0.5, 0);
      mapCtx.lineTo(x + 0.5, 512);
      mapCtx.stroke();
    }
    for (let y = 0; y <= 512; y += 128) {
      mapCtx.beginPath();
      mapCtx.moveTo(0, y + 0.5);
      mapCtx.lineTo(512, y + 0.5);
      mapCtx.stroke();
    }
    const emCv = document.createElement('canvas');
    emCv.width = 512;
    emCv.height = 512;
    const emCtx = emCv.getContext('2d');
    emCtx.fillStyle = '#000000';
    emCtx.fillRect(0, 0, 512, 512);
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 8; col++) {
        if ((row * 7 + col * 5) % 4 === 0) continue;
        const x0 = col * 64 + 14;
        const y0 = row * 128 + 28;
        emCtx.fillStyle = (row + col) % 3 === 0 ? 'rgba(0,229,255,0.72)' : 'rgba(41,121,255,0.48)';
        emCtx.fillRect(x0, y0, 22 + ((row + col) % 2) * 16, 8);
      }
    }
    const map = registerTexture(setTextureColorSpace(new THREE.CanvasTexture(mapCv)));
    const emissiveMap = registerTexture(setTextureColorSpace(new THREE.CanvasTexture(emCv)));
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    emissiveMap.wrapS = emissiveMap.wrapT = THREE.RepeatWrapping;
    panelTextures = { map: updatePanelRepeat(map), emissiveMap: updatePanelRepeat(emissiveMap) };
    return panelTextures;
  }

  function addFresnelShell(mesh) {
    if (mesh.userData.__techShell || !mesh.geometry) return;
    const uniforms = {
      glowColor: { value: new THREE.Color(cfg.glow) },
      power: { value: cfg.fresnelPower }
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: uniforms,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      vertexShader: [
        'varying vec3 vWorldNormal;',
        'varying vec3 vWorldPos;',
        'void main() {',
        '  vec4 worldPos = modelMatrix * vec4(position, 1.0);',
        '  vWorldPos = worldPos.xyz;',
        '  vWorldNormal = normalize(mat3(modelMatrix) * normal);',
        '  gl_Position = projectionMatrix * viewMatrix * worldPos;',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 glowColor;',
        'uniform float power;',
        'varying vec3 vWorldNormal;',
        'varying vec3 vWorldPos;',
        'void main() {',
        '  vec3 viewDir = normalize(cameraPosition - vWorldPos);',
        '  float rim = pow(1.0 - max(dot(normalize(vWorldNormal), viewDir), 0.0), power);',
        '  gl_FragColor = vec4(glowColor, rim * 0.72);',
        '}'
      ].join('\n')
    });
    const shell = new THREE.Mesh(mesh.geometry.clone(), mat);
    shell.scale.setScalar(cfg.fresnelScale);
    shell.renderOrder = (mesh.renderOrder || 12) + 0.1;
    registerOverlay(shell, mesh, '__techShell');
    mesh.userData.__techShell = shell;
    mesh.add(shell);
  }

  function applyShellWall(mesh) {
    if (Array.isArray(mesh.material) || !mesh.material || !mesh.material.isMeshStandardMaterial) return;
    const m = mesh.material;
    if (cfg.shellMode === 'panel') {
      const maps = makeTechPanelTextures();
      saveMaterial(m, [
        'color', 'map', 'emissive', 'emissiveMap', 'emissiveIntensity',
        'transparent', 'opacity', 'depthWrite', 'roughness', 'metalness',
        'envMap', 'envMapIntensity'
      ]);
      m.color.setHex(0xffffff);
      m.map = maps.map;
      m.emissive.setHex(cfg.glow);
      m.emissiveMap = maps.emissiveMap;
      m.emissiveIntensity = 1.2;
      m.transparent = false;
      m.opacity = 1;
      m.depthWrite = true;
      m.roughness = 0.32;
      m.metalness = 0.58;
      m.envMap = makeNightEnv();
      m.envMapIntensity = 0.55;
      m.needsUpdate = true;
      return;
    }
    saveMaterial(m, [
      'color', 'map', 'transparent', 'opacity', 'depthWrite', 'roughness',
      'metalness', 'envMap', 'envMapIntensity'
    ]);
    saveObject(mesh, ['renderOrder']);
    m.color.setHex(cfg.curtainColor);
    m.map = null;
    m.transparent = true;
    m.opacity = cfg.curtainOpacity;
    m.depthWrite = false;
    m.roughness = 0.24;
    m.metalness = 0.16;
    m.envMap = makeNightEnv();
    m.envMapIntensity = 0.35;
    m.needsUpdate = true;
    mesh.renderOrder = 12;
    addFresnelShell(mesh);
  }

  function applyRoof(mesh) {
    if (!mesh.material || Array.isArray(mesh.material)) return;
    const m = mesh.material;
    if (!m.isMeshStandardMaterial) return;
    saveMaterial(m, ['color', 'roughness', 'metalness', 'envMap', 'envMapIntensity']);
    m.color.setHex(cfg.roofColor);
    m.roughness = 0.46;
    m.metalness = 0.42;
    m.envMap = makeNightEnv();
    m.envMapIntensity = 0.2;
    m.needsUpdate = true;
  }

  function makeFlowTexture() {
    const cv = document.createElement('canvas');
    cv.width = 256;
    cv.height = 32;
    const ctx = cv.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 256, 0);
    g.addColorStop(0.00, 'rgba(0,229,255,0)');
    g.addColorStop(0.42, 'rgba(0,229,255,0.10)');
    g.addColorStop(0.50, 'rgba(0,229,255,0.88)');
    g.addColorStop(0.58, 'rgba(41,121,255,0.16)');
    g.addColorStop(1.00, 'rgba(0,229,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 32);
    const tex = registerTexture(setTextureColorSpace(new THREE.CanvasTexture(cv)));
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(3, 1);
    return tex;
  }

  function findPathFill(group) {
    let fill = null;
    group.children.forEach(function (child) {
      if (!fill && child.isMesh && child.geometry && child.geometry.type === 'PlaneGeometry' &&
          child.material && child.material.userData && child.material.userData.renderOrder !== undefined) {
        fill = child;
      }
    });
    return fill;
  }

  function addPathFlow(group) {
    if (group.userData && group.userData.__techFlow) return;
    const fill = findPathFill(group);
    if (!fill || !fill.geometry || !fill.geometry.parameters) return;
    const p = fill.geometry.parameters;
    const longX = p.width >= p.height;
    const flowW = longX ? p.width * 0.84 : Math.max(0.7, Math.min(p.width * 0.34, 2.4));
    const flowD = longX ? Math.max(0.7, Math.min(p.height * 0.34, 2.4)) : p.height * 0.84;
    const tex = makeFlowTexture();
    if (!longX) tex.rotation = Math.PI / 2;
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      color: cfg.glow,
      transparent: true,
      opacity: 0.62,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const flow = new THREE.Mesh(new THREE.PlaneGeometry(flowW, flowD), mat);
    flow.rotation.x = -Math.PI / 2;
    if (typeof applyFloorOverlayProfile === 'function' && typeof FLOOR_LAYER !== 'undefined') {
      applyFloorOverlayProfile(flow, FLOOR_LAYER.glow + 0.018, 'glow');
    } else {
      flow.position.y = 0.12;
      flow.renderOrder = 45;
    }
    registerOverlay(flow, group, '__techFlow');
    group.userData.__techFlow = flow;
    group.add(flow);
    flowItems.push({ texture: tex });
  }

  function applyPathFlows() {
    scene.traverse(function (obj) {
      if (!obj || !obj.children || !obj.children.length || (obj.userData && obj.userData.techOverlay)) return;
      const hasPathHit = obj.children.some(function (child) {
        return child.userData && child.userData.kind === 'path';
      });
      if (hasPathHit) addPathFlow(obj);
    });
  }

  function makeScanTexture() {
    const cv = document.createElement('canvas');
    cv.width = 512;
    cv.height = 512;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, 512, 512);
    const c = 256;
    const rg = ctx.createRadialGradient(c, c, 144, c, c, 228);
    rg.addColorStop(0.00, 'rgba(0,229,255,0)');
    rg.addColorStop(0.42, 'rgba(0,229,255,0.08)');
    rg.addColorStop(0.52, 'rgba(0,229,255,0.86)');
    rg.addColorStop(0.62, 'rgba(41,121,255,0.18)');
    rg.addColorStop(1.00, 'rgba(0,229,255,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, 512, 512);
    const tex = registerTexture(setTextureColorSpace(new THREE.CanvasTexture(cv)));
    return tex;
  }

  function addScanRing() {
    if (!cfg.scanEnabled || scanMesh) return;
    const mat = new THREE.MeshBasicMaterial({
      map: makeScanTexture(),
      color: cfg.glow,
      transparent: true,
      opacity: 0.0,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    mesh.rotation.x = -Math.PI / 2;
    if (typeof applyFloorOverlayProfile === 'function' && typeof FLOOR_LAYER !== 'undefined') {
      applyFloorOverlayProfile(mesh, FLOOR_LAYER.glow + 0.026, 'glow');
    } else {
      mesh.position.y = 0.14;
      mesh.renderOrder = 46;
    }
    registerOverlay(mesh, null, null);
    scene.add(mesh);
    scanMesh = mesh;
  }

  function applyMotion() {
    applyPathFlows();
    addScanRing();
    startTicker();
  }

  function getScanMaxSize() {
    if (typeof BUILDING === 'undefined') return 90;
    return Math.sqrt(BUILDING.width * BUILDING.width + BUILDING.depth * BUILDING.depth) * 1.18;
  }

  function tickMotion(now) {
    const dt = Math.min(0.05, Math.max(0, now - lastTick || 0.016));
    lastTick = now;
    flowItems.forEach(function (item) {
      if (item.texture && item.texture.offset) item.texture.offset.x -= cfg.flowSpeed * dt;
    });
    if (scanMesh && cfg.scanEnabled) {
      const period = Math.max(0.1, cfg.scanPeriod);
      const p = (now % period) / period;
      const size = getScanMaxSize() * (0.08 + p * 0.92);
      scanMesh.scale.set(size, size, 1);
      if (scanMesh.material) scanMesh.material.opacity = Math.pow(1 - p, 1.5) * 0.46;
    }
  }

  function startTicker() {
    if (rafId) return;
    lastTick = performance.now() * 0.001;
    const loop = function () {
      if (!cfg.enabled) { rafId = null; return; }
      tickMotion(performance.now() * 0.001);
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
  }

  function stopTicker() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  }

  function syncComposerSize() {
    if (!composer || typeof renderer === 'undefined') return;
    const pr = Math.min(window.devicePixelRatio || 1, 2);
    if (composer.setPixelRatio) composer.setPixelRatio(pr);
    renderer.getSize(sizeProbe);
    composer.setSize(sizeProbe.x, sizeProbe.y);
  }

  function enableBloom() {
    if (!cfg.bloom || typeof renderer === 'undefined' || typeof camera === 'undefined') return;
    if (!THREE.EffectComposer || !THREE.RenderPass || !THREE.UnrealBloomPass) {
      delete window.__techRenderFrame;
      return;
    }
    if (!composer) {
      composer = new THREE.EffectComposer(renderer);
      composer.addPass(new THREE.RenderPass(scene, camera));
      renderer.getSize(sizeProbe);
      bloomPass = new THREE.UnrealBloomPass(
        new THREE.Vector2(sizeProbe.x, sizeProbe.y),
        cfg.bloomStrength,
        cfg.bloomRadius,
        cfg.bloomThreshold
      );
      composer.addPass(bloomPass);
    }
    if (bloomPass) {
      bloomPass.strength = cfg.bloomStrength;
      bloomPass.radius = cfg.bloomRadius;
      bloomPass.threshold = cfg.bloomThreshold;
    }
    syncComposerSize();
    window.__techRenderFrame = function () {
      if (!composer) return false;
      composer.render();
      return true;
    };
    if (!resizeBound) {
      window.addEventListener('resize', syncComposerSize);
      resizeBound = true;
    }
  }

  function disableBloom() {
    delete window.__techRenderFrame;
    if (resizeBound) {
      window.removeEventListener('resize', syncComposerSize);
      resizeBound = false;
    }
    if (composer) {
      if (composer.passes) {
        composer.passes.forEach(function (pass) {
          if (pass && pass.dispose) pass.dispose();
        });
      }
      if (composer.renderTarget1 && composer.renderTarget1.dispose) composer.renderTarget1.dispose();
      if (composer.renderTarget2 && composer.renderTarget2.dispose) composer.renderTarget2.dispose();
      if (composer.dispose) composer.dispose();
    }
    composer = null;
    bloomPass = null;
  }

  function techDrawLabel(lamp, on) {
    const ctx = lamp.labelCanvas.getContext('2d');
    const meta = lamp.meta;
    ctx.clearRect(0, 0, lamp.labelCanvas.width, lamp.labelCanvas.height);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(8, 8, 240, 72, 10);
    ctx.fillStyle = on ? 'rgba(5,12,22,0.94)' : 'rgba(8,18,32,0.90)';
    ctx.strokeStyle = on ? meta.accent : cssHex(cfg.grid);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = on ? meta.accent : cssHex(cfg.glowSoft);
    ctx.fillRect(18, 17, 212, 1);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = on ? meta.accent : cssHex(cfg.glowSoft);
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText(meta.short, 22, 28);
    ctx.fillStyle = on ? '#f4fdff' : '#b9d7e6';
    ctx.font = 'bold 24px sans-serif';
    ctx.fillText((lamp.name || meta.label).slice(0, 12), 22, 56);
    lamp.labelTex.needsUpdate = true;
  }

  function redrawLampLabels() {
    if (typeof lamps === 'undefined' || !Array.isArray(lamps)) return;
    lamps.forEach(function (lamp) {
      if (lamp && lamp.labelCanvas && lamp.labelTex) techDrawLabel(lamp, !!lamp.state);
    });
  }

  function patchLabels() {
    if (labelPatched) return;
    const current = typeof window.drawLabel === 'function'
      ? window.drawLabel
      : (typeof drawLabel === 'function' ? drawLabel : null);
    if (!current) return;
    originalDrawLabel = current;
    window.drawLabel = techDrawLabel;
    try { drawLabel = techDrawLabel; } catch (e) {}
    labelPatched = true;
    redrawLampLabels();
  }

  function restoreLabels() {
    if (!labelPatched || !originalDrawLabel) return;
    window.drawLabel = originalDrawLabel;
    try { drawLabel = originalDrawLabel; } catch (e) {}
    labelPatched = false;
    if (typeof lamps !== 'undefined' && Array.isArray(lamps)) {
      lamps.forEach(function (lamp) {
        if (lamp && lamp.labelCanvas && lamp.labelTex) originalDrawLabel(lamp, !!lamp.state);
      });
    }
    originalDrawLabel = null;
  }

  function applyMeshes() {
    let meshes = 0;
    let mats = 0;
    const seen = new Set();
    scene.traverse(function (obj) {
      if (!obj || !obj.isMesh) return;
      if (isFloorPlane(obj)) {
        applyFloor(obj);
        return;
      }
      if (obj.userData && obj.userData.techTag === 'shellWall') {
        applyShellWall(obj);
        addEdge(obj);
        return;
      }
      if (obj.userData && obj.userData.techTag === 'roof') {
        applyRoof(obj);
      }
      const ms = structuralMats(obj);
      if (!ms) return;
      meshes++;
      ms.forEach(function (m) {
        if (!seen.has(m)) {
          seen.add(m);
          metalizeMat(m);
          mats++;
        }
      });
      addEdge(obj);
    });
    return { meshes: meshes, mats: mats };
  }

  function applyTech() {
    applySceneBase();
    applyLighting();
    const result = applyMeshes();
    applyMotion();
    enableBloom();
    patchLabels();
    return result;
  }

  function removeTech() {
    stopTicker();
    disableBloom();
    restoreLabels();
    removeOverlays();
    restoreAllMaterialsAndObjects();
    restoreLighting();
    restoreSceneBase();
    disposeCreatedTextures();
  }

  function schedule() {
    if (!cfg.enabled) return;
    if (pending) clearTimeout(pending);
    pending = setTimeout(function () {
      pending = null;
      applyTech();
    }, 80);
  }

  function wrap(name) {
    const orig = window[name];
    if (typeof orig === 'function' && !orig.__techWrapped) {
      const wrapped = function () {
        const r = orig.apply(this, arguments);
        schedule();
        return r;
      };
      wrapped.__techWrapped = true;
      window[name] = wrapped;
    }
  }

  ['rebuildLamps', 'rebuildFactoryScene', 'rebuildLayoutScene', 'refreshExtLayoutAfterEdit']
    .forEach(wrap);

  const TechStyle = {
    on: function () {
      if (window.SoftStyle && SoftStyle.isOn && SoftStyle.isOn()) SoftStyle.off();
      cfg.enabled = true;
      const r = applyTech();
      console.log('[TechStyle] ON', r);
      return r;
    },
    off: function () {
      cfg.enabled = false;
      if (pending) {
        clearTimeout(pending);
        pending = null;
      }
      removeTech();
      console.log('[TechStyle] OFF');
    },
    toggle: function () { return cfg.enabled ? this.off() : this.on(); },
    refresh: function () {
      if (!cfg.enabled) return;
      removeTech();
      return applyTech();
    },
    isOn: function () { return cfg.enabled; },
    setShellMode: function (mode) {
      if (mode !== 'curtain' && mode !== 'panel') return false;
      cfg.shellMode = mode;
      return this.refresh();
    },
    setGlowColor: function (hex) {
      cfg.glow = parseHex(hex, cfg.glow);
      return this.refresh();
    },
    setBloom: function (strength, radius, threshold) {
      if (strength != null) cfg.bloomStrength = Math.max(0, +strength || 0);
      if (radius != null) cfg.bloomRadius = Math.max(0, +radius || 0);
      if (threshold != null) cfg.bloomThreshold = Math.max(0, +threshold || 0);
      return this.refresh();
    },
    config: cfg
  };

  window.TechStyle = TechStyle;

  if (cfg.enabled) {
    [200, 600, 1200, 2500].forEach(function (t) {
      setTimeout(function () { if (cfg.enabled) applyTech(); }, t);
    });
  }
  console.log('[TechStyle] ready. Use TechStyle.on() / TechStyle.off().');
})();
