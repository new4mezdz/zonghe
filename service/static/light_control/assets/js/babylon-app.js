(function () {
  'use strict';

  if (typeof BABYLON === 'undefined') {
    showFatal('Babylon.js 没有加载成功，请检查 libs/babylon.js。');
    return;
  }

  var SCALE = 10;
  var DEFAULT_BUILDING = { width: 120, depth: 64, wallH: 33, ridgeH: 50 };
  // Safe fallback for WebGL1 and older drivers. WebGL2 updates this budget
  // from the actual vertex uniform-block limit after the engine is created.
  var MAX_DYNAMIC_LIGHTS = 8;
  // Look from the workshop's positive-Z side so the +X main entrance is on the
  // left of the default screen view. This changes only the camera, not the model.
  var DEFAULT_VIEW_ALPHA = 1.70;
  var DEFAULT_VIEW_BETA = 0.72;
  var DEFAULT_VIEW_RADIUS_SCALE = 0.92;

  var state = {
    config: { devices: [], lights: [], scenes: [], layout: { building: DEFAULT_BUILDING } },
    status: {},
    activeStyle: 'industrial',
    selectedLight: null,
    walkMode: false,
    gridWalkCameraKey: '',
    lightEntries: [],
    layoutEntries: [],
    sceneRoot: null,
    gridSelectionOverlay: null,
    gridSelectionRanges: [],
    gridSelectionActiveCell: null,
    extensionGridMetrics: null,
    extensionGrid: null,
    sceneBuildId: 0,
    dynamicLightPool: [],
    materials: Object.create(null)
  };
  var orbitPanKeys = Object.create(null);

  var canvas = document.getElementById('scene');
  var engine = new BABYLON.Engine(canvas, true, {
    antialias: true,
    stencil: true,
    preserveDrawingBuffer: false
  });
  try {
    var gl = engine._gl;
    if (gl && gl.MAX_VERTEX_UNIFORM_BLOCKS != null) {
      var uniformBlockLimit = Number(gl.getParameter(gl.MAX_VERTEX_UNIFORM_BLOCKS));
      if (isFinite(uniformBlockLimit) && uniformBlockLimit > 0) {
        // Babylon's PBR shader needs two blocks in addition to the two global
        // lights, so the remainder is the safe dynamic point-light budget.
        MAX_DYNAMIC_LIGHTS = Math.max(0, Math.min(MAX_DYNAMIC_LIGHTS, uniformBlockLimit - 4));
      }
    }
  } catch (error) {
    console.warn('[BabylonApp] Unable to detect the WebGL light budget; using the safe fallback.', error);
  }

  function resizeScene() {
    var pixelRatio = Math.min(Math.max(window.devicePixelRatio || 1, 1), 1.5);
    if (engine.setHardwareScalingLevel) engine.setHardwareScalingLevel(1 / pixelRatio);
    engine.resize();
  }

  var scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0.285, 0.320, 0.325, 1);
  scene.fogMode = BABYLON.Scene.FOGMODE_EXP2;
  scene.fogDensity = 0.00028;
  scene.fogColor = new BABYLON.Color3(0.405, 0.435, 0.435);
  scene.collisionsEnabled = true;
  scene.environmentIntensity = 0.44;

  if (scene.imageProcessingConfiguration) {
    scene.imageProcessingConfiguration.toneMappingEnabled = true;
    scene.imageProcessingConfiguration.toneMappingType = BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES;
    scene.imageProcessingConfiguration.exposure = 0.90;
    scene.imageProcessingConfiguration.contrast = 1.04;
  }

  var orbitCamera = new BABYLON.ArcRotateCamera(
    'orbit-camera',
    DEFAULT_VIEW_ALPHA,
    DEFAULT_VIEW_BETA,
    850,
    new BABYLON.Vector3(0, 35, 0),
    scene
  );
  orbitCamera.attachControl(canvas, true);
  orbitCamera.lowerBetaLimit = 0.32;
  orbitCamera.upperBetaLimit = 1.38;
  orbitCamera.lowerRadiusLimit = 150;
  orbitCamera.upperRadiusLimit = 1400;
  orbitCamera.wheelPrecision = 7;
  orbitCamera.wheelDeltaPercentage = 0.035;
  orbitCamera.panningSensibility = 38;
  orbitCamera.inertia = 0.72;
  orbitCamera.minZ = 0.3;
  orbitCamera.maxZ = 3200;

  var walkCamera = new BABYLON.UniversalCamera('walk-camera', new BABYLON.Vector3(-260, 38, 190), scene);
  walkCamera.setTarget(new BABYLON.Vector3(0, 30, 0));
  walkCamera.speed = 6.0;
  walkCamera.angularSensibility = 2600;
  walkCamera.inertia = 0.66;
  walkCamera.minZ = 0.25;
  walkCamera.maxZ = 2400;
  walkCamera.ellipsoid = new BABYLON.Vector3(8, 18, 8);
  walkCamera.checkCollisions = true;
  walkCamera.keysUp = [87, 38];
  walkCamera.keysDown = [83, 40];
  walkCamera.keysLeft = [65, 37];
  walkCamera.keysRight = [68, 39];

  scene.activeCamera = orbitCamera;

  canvas.addEventListener('wheel', function (event) {
    if (scene.activeCamera !== orbitCamera) return;
    event.preventDefault();
    var delta = Math.sign(event.deltaY || 0);
    if (!delta) return;
    var factor = delta > 0 ? 1.11 : 0.90;
    orbitCamera.radius = clamp(
      orbitCamera.radius * factor,
      orbitCamera.lowerRadiusLimit || 80,
      orbitCamera.upperRadiusLimit || 1600
    );
  }, { passive: false });

  function isTypingTarget(target) {
    if (!target) return false;
    var tag = String(target.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
  }

  function orbitPanDirection(code) {
    var map = {
      KeyW: 'forward',
      ArrowUp: 'forward',
      KeyS: 'back',
      ArrowDown: 'back',
      KeyA: 'left',
      ArrowLeft: 'left',
      KeyD: 'right',
      ArrowRight: 'right'
    };
    return map[code] || null;
  }

  function clearOrbitPanKeys() {
    orbitPanKeys = Object.create(null);
  }

  function handleOrbitPanKey(event, pressed) {
    if (isTypingTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
    var direction = orbitPanDirection(event.code);
    if (!direction) return;
    if (!pressed) orbitPanKeys[direction] = false;
    if (scene.activeCamera !== orbitCamera || state.walkMode) return;
    orbitPanKeys[direction] = pressed;
    event.preventDefault();
  }

  function clampOrbitTarget(target) {
    var b = state.config && state.config.layout && state.config.layout.building;
    if (!b) return target;
    var margin = 160;
    target.x = clamp(target.x, -b.halfW - margin, b.halfW + margin);
    target.z = clamp(target.z, -b.halfD - margin, b.halfD + margin);
    target.y = clamp(target.y, 10, Math.max(80, b.ridgeH + 35));
    return target;
  }

  function updateOrbitKeyboardPan() {
    if (scene.activeCamera !== orbitCamera || state.walkMode) return;
    if (!orbitPanKeys.forward && !orbitPanKeys.back && !orbitPanKeys.left && !orbitPanKeys.right) return;

    var forward = orbitCamera.target.subtract(orbitCamera.position);
    forward.y = 0;
    if (forward.lengthSquared() < 0.0001) {
      forward = new BABYLON.Vector3(Math.sin(orbitCamera.alpha), 0, Math.cos(orbitCamera.alpha));
    }
    forward.normalize();
    var right = BABYLON.Vector3.Cross(BABYLON.Axis.Y, forward);
    right.normalize();

    var move = BABYLON.Vector3.Zero();
    if (orbitPanKeys.forward) move.addInPlace(forward);
    if (orbitPanKeys.back) move.subtractInPlace(forward);
    if (orbitPanKeys.right) move.addInPlace(right);
    if (orbitPanKeys.left) move.subtractInPlace(right);
    if (move.lengthSquared() < 0.0001) return;

    var dt = Math.min(engine.getDeltaTime() / 1000 || 1 / 60, 0.05);
    var speed = clamp((orbitCamera.radius || 420) * 0.45, 80, 420);
    move.normalize().scaleInPlace(speed * dt);
    orbitCamera.target.addInPlace(move);
    clampOrbitTarget(orbitCamera.target);
  }

  window.addEventListener('keydown', function (event) {
    handleOrbitPanKey(event, true);
  });
  window.addEventListener('keyup', function (event) {
    handleOrbitPanKey(event, false);
  });
  window.addEventListener('blur', clearOrbitPanKeys);

  var hemi = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0.1, 1, 0.25), scene);
  hemi.intensity = 0.46;
  hemi.diffuse = new BABYLON.Color3(0.88, 0.94, 1.00);
  hemi.groundColor = new BABYLON.Color3(0.40, 0.44, 0.46);

  var keyLight = new BABYLON.DirectionalLight('key-light', new BABYLON.Vector3(0.42, -0.82, 0.38), scene);
  keyLight.position = new BABYLON.Vector3(-420, 580, -360);
  keyLight.intensity = 0.66;
  keyLight.diffuse = new BABYLON.Color3(0.94, 0.97, 1.00);

  var shadow = new BABYLON.ShadowGenerator(2048, keyLight);
  shadow.useBlurExponentialShadowMap = true;
  shadow.blurKernel = 24;
  shadow.setDarkness(0.22);

  var glow = new BABYLON.GlowLayer('main-glow', scene, { mainTextureSamples: 4 });
  glow.intensity = 0.12;

  var highlight = new BABYLON.HighlightLayer('selection-highlight', scene);
  highlight.innerGlow = false;
  highlight.outerGlow = true;
  highlight.blurHorizontalSize = 0.8;
  highlight.blurVerticalSize = 0.8;

  var pipeline = null;
  var ssaoPipeline = null;
  if (BABYLON.DefaultRenderingPipeline) {
    pipeline = new BABYLON.DefaultRenderingPipeline('main-pipeline', true, scene, [orbitCamera, walkCamera]);
    pipeline.samples = 4;
    pipeline.fxaaEnabled = true;
    pipeline.bloomEnabled = true;
    pipeline.bloomThreshold = 0.82;
    pipeline.bloomWeight = 0.14;
    pipeline.bloomKernel = 72;
    pipeline.imageProcessingEnabled = true;
  }
  try {
    if (BABYLON.SSAO2RenderingPipeline) {
      ssaoPipeline = new BABYLON.SSAO2RenderingPipeline(
        'main-ssao',
        scene,
        { ssaoRatio: 0.55, blurRatio: 0.5 },
        [orbitCamera, walkCamera]
      );
      ssaoPipeline.radius = 3.2;
      ssaoPipeline.totalStrength = 0.48;
      ssaoPipeline.base = 0.12;
      ssaoPipeline.samples = 8;
      ssaoPipeline.maxZ = 1800;
    }
  } catch (error) {
    ssaoPipeline = null;
    console.warn('[BabylonApp] SSAO unavailable:', error);
  }

  var palette = {
    industrial: {
      clear: new BABYLON.Color4(0.760, 0.790, 0.780, 1),
      fog: new BABYLON.Color3(0.824, 0.843, 0.839),
      floor: '#dce1df',
      ground: '#909895',
      wall: '#d5d9d7',
      steel: '#a7afb0',
      body: '#70887f',
      glow: '#e8f2f4',
      warm: '#d5a52d',
      guide: '#3b8d86',
      safety: '#d5a52d'
    },
    tech: {
      clear: new BABYLON.Color4(0.060, 0.070, 0.083, 1),
      fog: new BABYLON.Color3(0.060, 0.070, 0.083),
      floor: '#172432',
      ground: '#0c1118',
      wall: '#1b3240',
      steel: '#9cadbb',
      body: '#3a4652',
      glow: '#35e6a8',
      warm: '#ffbf67',
      guide: '#35e6a8',
      safety: '#ffbf67'
    },
    soft: {
      clear: new BABYLON.Color4(0.70, 0.73, 0.75, 1),
      fog: new BABYLON.Color3(0.70, 0.73, 0.75),
      floor: '#d4d8d7',
      ground: '#8b9492',
      wall: '#c8cecc',
      steel: '#6e767a',
      body: '#7b8789',
      glow: '#30d158',
      warm: '#ff9f0a',
      guide: '#30d158',
      safety: '#d1a62c'
    }
  };

  function showFatal(message) {
    document.body.innerHTML = '<div style="padding:24px;color:#fff;background:#111;font-family:sans-serif">' + escapeHtml(message) + '</div>';
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function toNumber(value, fallback) {
    var next = Number(value);
    return Number.isFinite(next) ? next : fallback;
  }

  function mapConfigPoint(x, z) {
    return {
      x: -toNumber(x, 0),
      z: toNumber(z, 0)
    };
  }

  function mapLayoutItem(item) {
    var next = Object.assign({}, item || {});
    if (next.x != null || next.z != null) {
      var point = mapConfigPoint(next.x, next.z);
      next.x = point.x;
      next.z = point.z;
    }
    if (next.x1 != null || next.z1 != null || next.x2 != null || next.z2 != null) {
      var point1 = mapConfigPoint(next.x1, next.z1);
      var point2 = mapConfigPoint(next.x2, next.z2);
      next.x1 = point1.x;
      next.z1 = point1.z;
      next.x2 = point2.x;
      next.z2 = point2.z;
    }
    if (next.rotation != null) next.rotation = -toNumber(next.rotation, 0);
    return next;
  }

  function mapLayoutItems(items) {
    return Array.isArray(items) ? items.map(mapLayoutItem) : [];
  }

  function looksBrokenText(value) {
    if (!value) return true;
    return /[�\u0590-\u05ff]/.test(value) || /[鐏鏂鍘惧僵佃灞扮]/.test(value);
  }

  function cleanName(value, fallback) {
    var text = String(value == null ? '' : value).trim();
    return looksBrokenText(text) ? fallback : text;
  }

  function color3(hex) {
    return BABYLON.Color3.FromHexString(hex);
  }

  function hexToRgb(hex) {
    var value = String(hex || '#ffffff').replace('#', '');
    if (value.length === 3) value = value.replace(/(.)/g, '$1$1');
    var num = parseInt(value, 16);
    return {
      r: (num >> 16) & 255,
      g: (num >> 8) & 255,
      b: num & 255
    };
  }

  function pbr(name, options) {
    options = options || {};
    var mat = new BABYLON.PBRMaterial(name, scene);
    mat.albedoColor = color3(options.color || '#ffffff');
    mat.metallic = options.metallic == null ? 0.1 : options.metallic;
    mat.roughness = options.roughness == null ? 0.58 : options.roughness;
    if (options.emissive) mat.emissiveColor = color3(options.emissive);
    if (options.alpha != null && options.alpha < 1) {
      mat.alpha = options.alpha;
      mat.transparencyMode = BABYLON.PBRMaterial.PBRMATERIAL_ALPHABLEND;
      mat.backFaceCulling = false;
      mat.disableDepthWrite = true;
    }
    return mat;
  }

  function standard(name, options) {
    options = options || {};
    var mat = new BABYLON.StandardMaterial(name, scene);
    mat.diffuseColor = color3(options.color || '#ffffff');
    mat.specularColor = color3(options.specular || '#050505');
    if (options.emissive) mat.emissiveColor = color3(options.emissive);
    if (options.alpha != null && options.alpha < 1) {
      mat.alpha = options.alpha;
      mat.backFaceCulling = false;
    }
    return mat;
  }

  function disposeMaterials() {
    Object.keys(state.materials).forEach(function (key) {
      var mat = state.materials[key];
      if (mat && mat.dispose) mat.dispose();
    });
    state.materials = Object.create(null);
  }

  function buildMaterials() {
    disposeMaterials();
    var p = palette[state.activeStyle];
    var industrial = state.activeStyle === 'industrial';
    state.materials.outdoor = pbr('outdoor', { color: p.ground, metallic: 0.05, roughness: 0.72 });
    state.materials.floor = makeGridMaterial('floor-grid-' + state.activeStyle, state.activeStyle);
    state.materials.wall = pbr('wall', { color: p.wall, metallic: 0.12, roughness: industrial ? 0.50 : 0.42, alpha: state.activeStyle === 'tech' ? 0.18 : (industrial ? 0.82 : 0.72) });
    state.materials.roomWall = pbr('room-wall', {
      color: state.activeStyle === 'tech' ? '#76909d' : (industrial ? '#cdd2d0' : '#d5dcde'),
      metallic: 0.12,
      roughness: 0.56
    });
    state.materials.glass = pbr('glass', { color: industrial ? '#bcd1ce' : '#b9f3f0', metallic: 0.0, roughness: 0.18, alpha: state.activeStyle === 'tech' ? 0.14 : (industrial ? 0.10 : 0.42) });
    state.materials.steel = pbr('steel', { color: p.steel, metallic: 0.74, roughness: 0.28 });
    state.materials.dark = pbr('dark-shell', { color: state.activeStyle === 'tech' ? '#171b20' : (industrial ? '#3b4345' : '#5d676b'), metallic: 0.42, roughness: 0.38 });
    state.materials.body = pbr('machine-body', { color: p.body, metallic: 0.36, roughness: 0.42 });
    state.materials.door = pbr('door-panel', { color: state.activeStyle === 'tech' ? '#4c7488' : (industrial ? '#929d9c' : '#9aa8ad'), metallic: 0.34, roughness: 0.34, emissive: state.activeStyle === 'tech' ? '#0a1d24' : null });
    state.materials.path = pbr('path', { color: state.activeStyle === 'tech' ? '#245245' : (industrial ? '#aebab6' : '#9aa7a2'), metallic: 0.05, roughness: industrial ? 0.36 : 0.56, alpha: industrial ? 0.40 : 0.78 });
    state.materials.zone = pbr('zone', { color: state.activeStyle === 'tech' ? '#214454' : (industrial ? '#c3cbc8' : '#b9c2c0'), metallic: 0.05, roughness: 0.52, alpha: state.activeStyle === 'tech' ? 0.54 : (industrial ? 0.28 : 0.64) });
    state.materials.lampFrame = pbr('lamp-frame', { color: state.activeStyle === 'tech' ? '#9bb3c2' : (industrial ? '#c4cbcc' : '#d1d8dc'), metallic: 0.64, roughness: 0.30 });
    state.materials.lampBody = pbr('lamp-body', { color: state.activeStyle === 'tech' ? '#858f95' : (industrial ? '#56686c' : '#cbd1d4'), metallic: 0.18, roughness: 0.52 });
    state.materials.lampEndCap = pbr('lamp-endcap', { color: state.activeStyle === 'tech' ? '#687177' : (industrial ? '#899497' : '#9da5aa'), metallic: 0.24, roughness: 0.48 });
    state.materials.lampTrim = pbr('lamp-trim', { color: state.activeStyle === 'tech' ? '#d6dade' : (industrial ? '#edf1f0' : '#eef1f2'), metallic: 0.08, roughness: 0.58 });
    state.materials.lampCable = pbr('lamp-cable', { color: state.activeStyle === 'tech' ? '#70828e' : (industrial ? '#596366' : '#4c565b'), metallic: 0.82, roughness: 0.22 });
    state.materials.floorLine = standard('floor-line', { color: p.guide, emissive: industrial ? '#082d2a' : p.guide, alpha: state.activeStyle === 'tech' ? 0.28 : (industrial ? 0.80 : 0.18) });
    state.materials.floorLine.disableDepthWrite = true;
    state.materials.floorLine.alphaMode = state.activeStyle === 'tech' ? BABYLON.Engine.ALPHA_ADD : BABYLON.Engine.ALPHA_COMBINE;
    state.materials.safetyLine = standard('safety-line', { color: p.safety, emissive: industrial ? '#302400' : p.safety, alpha: industrial ? 0.86 : 0.34 });
    state.materials.safetyLine.disableDepthWrite = true;
    state.materials.equipmentAreaLine = standard('equipment-area-line', {
      color: state.activeStyle === 'tech' ? '#46b8e8' : (industrial ? '#367fa8' : '#4f8fb5'),
      emissive: state.activeStyle === 'tech' ? '#123848' : (industrial ? '#0b2636' : '#112d3d'),
      alpha: industrial ? 0.90 : 0.72
    });
    state.materials.equipmentAreaLine.disableDepthWrite = true;
    state.materials.industrialTruss = pbr('industrial-truss', {
      color: industrial ? '#657174' : (state.activeStyle === 'tech' ? '#647582' : '#747d80'),
      metallic: 0.72,
      roughness: 0.32
    });
    state.materials.industrialDuct = pbr('industrial-duct', {
      color: industrial ? '#b6bfc0' : (state.activeStyle === 'tech' ? '#82949d' : '#adb5b6'),
      metallic: 0.68,
      roughness: 0.30
    });
    state.materials.industrialCableTray = pbr('industrial-cable-tray', {
      color: industrial ? '#596366' : (state.activeStyle === 'tech' ? '#3f4d56' : '#626a6d'),
      metallic: 0.78,
      roughness: 0.30
    });
    state.materials.industrialCable = pbr('industrial-cable', {
      color: industrial ? '#2f3639' : '#252b2f',
      metallic: 0.22,
      roughness: 0.52
    });
    state.materials.industrialFire = pbr('industrial-fire-pipe', {
      color: industrial ? '#b64b43' : '#873831',
      metallic: 0.34,
      roughness: 0.44
    });
    state.materials.industrialSafety = pbr('industrial-safety', {
      color: industrial ? '#d5a52d' : '#ba8b24',
      metallic: 0.18,
      roughness: 0.48
    });
    state.materials.trolleyYellow = pbr('platform-trolley-safety-yellow', {
      color: industrial ? '#e2aa2f' : '#d29a25',
      metallic: 0.24,
      roughness: 0.42
    });
    state.materials.trolleyWheel = pbr('platform-trolley-wheel', {
      color: industrial ? '#252a2c' : '#202529',
      metallic: 0.18,
      roughness: 0.62
    });
    state.materials.industrialDeck = pbr('industrial-deck', {
      color: industrial ? '#7b8689' : '#5c676d',
      metallic: 0.68,
      roughness: 0.38
    });
    state.materials.industrialMachinePanel = pbr('industrial-machine-panel', {
      color: industrial ? '#a7b3af' : '#718088',
      metallic: 0.30,
      roughness: 0.42
    });
    state.materials.industrialMachineGlass = pbr('industrial-machine-glass', {
      color: industrial ? '#617c7b' : '#365764',
      metallic: 0.08,
      roughness: 0.20,
      alpha: industrial ? 0.34 : 0.26
    });
    state.materials.industrialMachineScreen = standard('industrial-machine-screen', {
      color: '#2e6f9d',
      emissive: '#17496e'
    });
    state.materials.label = standard('label-fallback', { color: '#ffffff', emissive: '#ffffff' });
  }

  function makeGridMaterial(name, style) {
    var tex = new BABYLON.DynamicTexture(name + '-texture', { width: 1024, height: 1024 }, scene, false);
    var ctx = tex.getContext();
    var industrial = style === 'industrial';
    var bg = style === 'tech' ? '#172432' : (industrial ? '#dce1df' : '#cdd3d1');
    var major = style === 'tech' ? 'rgba(53,230,168,0.36)' : (industrial ? 'rgba(59,141,134,0.12)' : 'rgba(40,70,62,0.23)');
    var minor = style === 'tech' ? 'rgba(255,255,255,0.11)' : (industrial ? 'rgba(76,90,96,0.055)' : 'rgba(20,30,30,0.10)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 1024, 1024);
    for (var i = 0; i <= 1024; i += 32) {
      ctx.strokeStyle = i % 128 === 0 ? major : minor;
      ctx.lineWidth = i % 128 === 0 ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, 1024);
      ctx.moveTo(0, i);
      ctx.lineTo(1024, i);
      ctx.stroke();
    }
    ctx.fillStyle = style === 'tech' ? 'rgba(53,230,168,0.045)' : (industrial ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.12)');
    for (var band = 0; band < 4; band++) {
      var bx = 96 + band * 248;
      ctx.fillRect(bx, 0, 18, 1024);
      ctx.fillRect(0, bx, 1024, 14);
    }
    var seed = 17;
    function rnd() {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    }
    for (var dot = 0; dot < 1800; dot++) {
      var alpha = style === 'tech' ? 0.055 + rnd() * 0.055 : (industrial ? 0.012 + rnd() * 0.018 : 0.045 + rnd() * 0.05);
      ctx.fillStyle = 'rgba(255,255,255,' + alpha.toFixed(3) + ')';
      ctx.fillRect(Math.floor(rnd() * 1024), Math.floor(rnd() * 1024), rnd() > 0.72 ? 2 : 1, rnd() > 0.82 ? 2 : 1);
    }
    tex.update();
    tex.wrapU = BABYLON.Texture.WRAP_ADDRESSMODE;
    tex.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
    tex.uScale = 7;
    tex.vScale = 4;

    var mat = pbr(name + '-mat', {
      color: '#ffffff',
      metallic: style === 'tech' ? 0.22 : (industrial ? 0.06 : 0.04),
      roughness: style === 'tech' ? 0.26 : (industrial ? 0.34 : 0.58)
    });
    mat.albedoTexture = tex;
    return mat;
  }

  function normalizeBuilding(building) {
    var src = building || DEFAULT_BUILDING;
    var width = clamp(toNumber(src.width, DEFAULT_BUILDING.width), 24, 140);
    var depth = clamp(toNumber(src.depth, DEFAULT_BUILDING.depth), 18, 110);
    var wallH = clamp(toNumber(src.wallH, DEFAULT_BUILDING.wallH), 12, 56);
    var ridgeH = clamp(toNumber(src.ridgeH, DEFAULT_BUILDING.ridgeH), wallH + 6, 84);
    return {
      configWidth: width,
      configDepth: depth,
      width: width * SCALE,
      depth: depth * SCALE,
      wallH: wallH,
      ridgeH: ridgeH,
      halfW: width * SCALE / 2,
      halfD: depth * SCALE / 2
    };
  }

  function normalizeLight(light, index) {
    var item = light || {};
    var gridColumn = Number(item.grid_column);
    var gridStart = Number(item.grid_start);
    var gridCount = Number(item.grid_count);
    var gridArea = String(item.grid_area || item.area || 'main').trim().toLowerCase();
    return {
      name: cleanName(item.name, '灯具 ' + pad(index + 1)),
      rawName: item.name || '',
      type: item.type || 'lamp',
      scale: clamp(toNumber(item.scale, 3), 1.2, 6),
      device_ip: item.device_ip || '',
      channel: Math.max(0, Math.floor(toNumber(item.channel, index))),
      group: cleanName(item.group, '默认分组'),
      x: toNumber(item.x, 0),
      z: toNumber(item.z, 0),
      mount: item.mount || 'ceiling',
      grid_area: gridArea === 'extension' ? 'extension' : 'main',
      grid_column: Number.isFinite(gridColumn) ? Math.floor(gridColumn) : null,
      grid_start: Number.isFinite(gridStart) ? Math.floor(gridStart) : null,
      grid_count: Number.isFinite(gridCount) ? Math.floor(gridCount) : null
    };
  }

  function normalizeLightingGridFallback(grid) {
    var source = grid || {};
    var columns = clamp(Math.floor(toNumber(source.columns, 12)), 1, 40);
    var lightsPerColumn = clamp(Math.floor(toNumber(source.lightsPerColumn, 75)), 1, 240);
    return {
      enabled: !!source.enabled,
      columns: columns,
      lightsPerColumn: lightsPerColumn,
      orientation: source.orientation === 'x' ? 'x' : 'z'
    };
  }

  function normalizeExtensionRoomFallback(room, building) {
    var source = room || {};
    var doorCount = Math.round(toNumber(source.doorCount, 3));
    var lightColumns = Math.round(toNumber(source.lightColumns, 12));
    var lightsPerColumn = Math.round(toNumber(source.lightsPerColumn, 14));
    return {
      enabled: !!source.enabled,
      length: clamp(toNumber(source.length, 240), 60, 360),
      width: building.depth,
      wallHeight: clamp(toNumber(source.wallHeight, building.wallH), 8, building.wallH),
      doorCount: clamp(doorCount, 1, 6),
      doorWidth: clamp(toNumber(source.doorWidth, 52), 24, 96),
      doorHeight: clamp(toNumber(source.doorHeight, 21), 8, building.wallH),
      lightColumns: clamp(lightColumns, 1, 40),
      lightsPerColumn: clamp(lightsPerColumn, 1, 120)
    };
  }

  function pad(value) {
    return String(value).padStart(2, '0');
  }

  function getRuntimeConfig() {
    return (typeof config !== 'undefined' && config) ? config : null;
  }

  function getRuntimeStatus() {
    return (typeof deviceStatus !== 'undefined' && deviceStatus) ? deviceStatus : {};
  }

  function syncRuntimeState() {
    var cfg = getRuntimeConfig() || {};
    var layout = cfg.layout || {};
    var building = normalizeBuilding(layout.building || DEFAULT_BUILDING);
    var rawLights = Array.isArray(cfg.lights) ? cfg.lights : [];
    var lightingGrid = typeof normalizeLightingGridConfig === 'function'
      ? normalizeLightingGridConfig(layout.lightingGrid)
      : normalizeLightingGridFallback(layout.lightingGrid);
    var extensionRoom = normalizeExtensionRoomFallback(layout.extensionRoom, building);
    // The main workshop and the packing-machine extension are two independent
    // physical grids.  Never feed extension circuits into the legacy automatic
    // main-grid allocator: their 1..12 / 1..14 coordinates would otherwise look
    // valid and could occupy (or overwrite) cells in the 12 x 75 workshop grid.
    var gridSegments = null;
    if (lightingGrid.enabled && typeof assignLightingGridSegments === 'function') {
      var mainLightIndexes = [];
      var mainLights = [];
      rawLights.forEach(function(light, index) {
        if (getLightGridArea(light) === 'extension') return;
        mainLightIndexes.push(index);
        mainLights.push(light);
      });
      var assignedMainLights = assignLightingGridSegments(mainLights, lightingGrid);
      if (Array.isArray(assignedMainLights)) {
        gridSegments = rawLights.map(function(light) { return light; });
        mainLightIndexes.forEach(function(lightIndex, assignedIndex) {
          gridSegments[lightIndex] = assignedMainLights[assignedIndex];
        });
      }
    }
    var positions = null;
    if (typeof computeLayout === 'function') {
      try {
        positions = computeLayout(rawLights);
      } catch (error) {
        positions = null;
      }
    }
    var lights = rawLights.map(function(light, index) {
      var next = normalizeLight(light, index);
      var segment = gridSegments && gridSegments[index];
      if (segment) {
        next.grid_column = segment.grid_column;
        next.grid_start = segment.grid_start;
        next.grid_count = segment.grid_count;
      }
      var point = positions && positions[index];
      var sourceX = point && Number.isFinite(point.x) ? point.x : next.x;
      var sourceZ = point && Number.isFinite(point.z) ? point.z : next.z;
      var mapped = mapConfigPoint(sourceX, sourceZ);
      next.x = mapped.x;
      next.z = mapped.z;
      return next;
    });

    state.config = {
      devices: Array.isArray(cfg.devices) ? cfg.devices : [],
      lights: lights,
      scenes: Array.isArray(cfg.scenes) ? cfg.scenes : [],
      layout: {
        building: building,
        lightingGrid: lightingGrid,
        extensionRoom: extensionRoom,
        walls: mapLayoutItems(layout.walls),
        zones: mapLayoutItems(layout.zones),
        pillars: mapLayoutItems(layout.pillars),
        doors: mapLayoutItems(layout.doors),
        paths: mapLayoutItems(layout.paths),
        workstations: mapLayoutItems(layout.workstations),
        racks: mapLayoutItems(layout.racks),
        safetyStations: mapLayoutItems(layout.safetyStations)
      }
    };
    state.status = getRuntimeStatus();
  }

  function isLightConnected(light) {
    var status = state.status[light.device_ip];
    return !!(status && status.connected);
  }

  function getLightGridArea(light) {
    var value = String(light && (light.grid_area || light.area) || 'main').trim().toLowerCase();
    return value === 'extension' ? 'extension' : 'main';
  }

  function isLightOn(light, index) {
    var status = state.status[light.device_ip];
    if (status && status.relay_states && Object.prototype.hasOwnProperty.call(status.relay_states, light.channel)) {
      return !!(status.connected && status.relay_states[light.channel]);
    }
    return false;
  }

  function getLightActivity() {
    var lights = state.config.lights || [];
    var grid = state.config.layout && state.config.layout.lightingGrid;
    var total = grid && grid.enabled ? grid.columns * grid.lightsPerColumn : lights.length;
    var room = state.config.layout && state.config.layout.extensionRoom;
    if (room && room.enabled) {
      total += Math.max(1, Math.round(toNumber(room.lightColumns, 12))) *
        Math.max(1, Math.round(toNumber(room.lightsPerColumn, 14)));
    }
    var on = 0;
    lights.forEach(function (light, index) {
      if (!isLightOn(light, index)) return;
      on += light.type === 'lamp' && Number.isFinite(Number(light.grid_count))
        ? Math.max(0, toNumber(light.grid_count, 0))
        : 1;
    });
    return {
      total: total,
      on: on,
      ratio: total ? on / total : 0
    };
  }

  var sceneLightingTarget = null;
  var sceneLightingShadow = 0.22;

  function updateSceneLighting() {
    var activity = getLightActivity();
    var ratio = clamp(activity.ratio, 0, 1);
    var hasLight = activity.on > 0 ? 1 : 0;
    var coverage = Math.sqrt(ratio);
    var style = state.activeStyle;
    var base = style === 'tech'
      ? { hemi: 0.48, key: 1.18, glow: 0.30, env: 0.46, fog: 0.00072, exposure: 1.00, contrast: 1.05, bloom: 0.20, threshold: 0.68, shadow: 0.34, ssao: 0.76, ssaoBase: 0.07 }
      : (style === 'industrial'
        ? { hemi: 0.42, key: 0.58, glow: 0.11, env: 0.42, fog: 0.00038, exposure: 0.88, contrast: 1.06, bloom: 0.08, threshold: 0.90, shadow: 0.34, ssao: 0.64, ssaoBase: 0.08 }
        : { hemi: 0.46, key: 0.92, glow: 0.22, env: 0.44, fog: 0.00086, exposure: 0.98, contrast: 1.03, bloom: 0.14, threshold: 0.78, shadow: 0.36, ssao: 0.72, ssaoBase: 0.08 });
    // A single illuminated circuit should already be visible, while the square
    // root keeps large installations from becoming overexposed too quickly.
    var lift = Math.min(1.15, hasLight * 0.28 + coverage * (style === 'industrial' ? 0.92 : 0.82));
    sceneLightingTarget = {
      env: base.env + lift * (style === 'industrial' ? 0.42 : 0.46),
      fog: Math.max(base.fog * (1 - lift * 0.22), base.fog * 0.68),
      hemi: base.hemi + lift * (style === 'industrial' ? 0.75 : 0.68),
      key: base.key + lift * (style === 'industrial' ? 0.95 : 1.08),
      glow: base.glow + lift * (style === 'industrial' ? 0.20 : 0.28),
      shadow: Math.max(0.18, base.shadow - lift * 0.12),
      exposure: base.exposure + lift * (style === 'industrial' ? 0.32 : 0.36),
      contrast: base.contrast,
      bloom: base.bloom + lift * (style === 'industrial' ? 0.22 : 0.28),
      threshold: Math.max(0.50, base.threshold - lift * 0.20),
      ssao: Math.max(0.44, base.ssao - lift * 0.15),
      ssaoBase: base.ssaoBase + lift * 0.045
    };
  }

  function animateSceneLighting(delta) {
    if (!sceneLightingTarget) return;
    var amount = 1 - Math.exp(-Math.max(0.001, delta) * 3.4);
    function blend(current, target) {
      return current + (target - current) * amount;
    }
    scene.environmentIntensity = blend(scene.environmentIntensity, sceneLightingTarget.env);
    scene.fogDensity = blend(scene.fogDensity, sceneLightingTarget.fog);
    hemi.intensity = blend(hemi.intensity, sceneLightingTarget.hemi);
    keyLight.intensity = blend(keyLight.intensity, sceneLightingTarget.key);
    glow.intensity = blend(glow.intensity, sceneLightingTarget.glow);
    sceneLightingShadow = blend(sceneLightingShadow, sceneLightingTarget.shadow);
    shadow.setDarkness(sceneLightingShadow);
    if (scene.imageProcessingConfiguration) {
      scene.imageProcessingConfiguration.exposure = blend(scene.imageProcessingConfiguration.exposure, sceneLightingTarget.exposure);
      scene.imageProcessingConfiguration.contrast = blend(scene.imageProcessingConfiguration.contrast, sceneLightingTarget.contrast);
    }
    if (pipeline) {
      pipeline.bloomWeight = blend(pipeline.bloomWeight, sceneLightingTarget.bloom);
      pipeline.bloomThreshold = blend(pipeline.bloomThreshold, sceneLightingTarget.threshold);
    }
    if (ssaoPipeline) {
      ssaoPipeline.totalStrength = blend(ssaoPipeline.totalStrength, sceneLightingTarget.ssao);
      ssaoPipeline.base = blend(ssaoPipeline.base, sceneLightingTarget.ssaoBase);
    }
  }

  var sceneLightingFrame = 0;

  function scheduleSceneLightingUpdate() {
    if (sceneLightingFrame) return;
    sceneLightingFrame = requestAnimationFrame(function () {
      sceneLightingFrame = 0;
      updateSceneLighting();
    });
  }

  function prepareWalkCameraForGrid() {
    var layout = state.config.layout || {};
    var grid = layout.lightingGrid;
    if (!grid || !grid.enabled) {
      state.gridWalkCameraKey = '';
      return;
    }

    var building = layout.building || DEFAULT_BUILDING;
    var cameraKey = [building.wallH, building.halfW, building.halfD, grid.orientation].join('|');
    if (state.gridWalkCameraKey === cameraKey) return;

    // Keep the first-person view below the suspended light strips. Rebuilding the
    // same layout (for example after a style change) must not reset user movement.
    var eyeY = clamp(toNumber(building.wallH, DEFAULT_BUILDING.wallH) - 11, 12, 26);
    walkCamera.position.y = eyeY;
    walkCamera.setTarget(new BABYLON.Vector3(0, eyeY - 2, 0));
    state.gridWalkCameraKey = cameraKey;
  }

  function rebuildScene() {
    state.sceneBuildId += 1;
    syncRuntimeState();
    prepareWalkCameraForGrid();
    disposeGridSelectionOverlay();
    if (state.sceneRoot) {
      state.sceneRoot.dispose(false, true);
      state.sceneRoot = null;
    }
    state.dynamicLightPool = [];
    state.extensionGridMetrics = null;
    state.extensionGrid = null;
    buildMaterials();
    state.lightEntries = [];
    state.layoutEntries = [];
    highlight.removeAllMeshes();

    var root = new BABYLON.TransformNode('babylon-app-root', scene);
    state.sceneRoot = root;

    createFactory(root);
    createLayoutObjects(root);
    createLights(root);
    renderGridSelectionOverlay();
  }

  function addShadow(mesh, cast, receive) {
    if (cast !== false) shadow.addShadowCaster(mesh, true);
    mesh.receiveShadows = receive !== false;
    return mesh;
  }

  function box(name, size, position, material, parent, cast, receive) {
    var mesh = BABYLON.MeshBuilder.CreateBox(name, {
      width: size.x,
      height: size.y,
      depth: size.z
    }, scene);
    mesh.position.copyFrom(position);
    mesh.material = material;
    if (parent) mesh.parent = parent;
    mesh.checkCollisions = true;
    return addShadow(mesh, cast, receive);
  }

  // Build many identical panels into one mesh. A 12 x 75 ceiling contains 900
  // physical panels, so creating a full Babylon node/material/texture stack for
  // every panel would overwhelm the browser. Each controllable consecutive
  // section is instead merged into two small draw calls (housing + diffuser).
  function repeatedBox(name, size, offsets, position, material, parent, cast, receive) {
    var template = BABYLON.VertexData.CreateBox({
      width: size.x,
      height: size.y,
      depth: size.z
    });
    var positions = [];
    var normals = [];
    var uvs = [];
    var indices = [];

    offsets.forEach(function (offset) {
      var vertexOffset = positions.length / 3;
      for (var p = 0; p < template.positions.length; p += 3) {
        positions.push(
          template.positions[p] + offset.x,
          template.positions[p + 1] + offset.y,
          template.positions[p + 2] + offset.z
        );
      }
      Array.prototype.push.apply(normals, template.normals);
      if (template.uvs) Array.prototype.push.apply(uvs, template.uvs);
      template.indices.forEach(function (value) {
        indices.push(value + vertexOffset);
      });
    });

    var data = new BABYLON.VertexData();
    data.positions = positions;
    data.normals = normals;
    data.indices = indices;
    if (uvs.length) data.uvs = uvs;

    var mesh = new BABYLON.Mesh(name, scene);
    data.applyToMesh(mesh, false);
    mesh.position.copyFrom(position || BABYLON.Vector3.Zero());
    mesh.material = material;
    mesh.parent = parent || null;
    mesh.checkCollisions = false;
    mesh.isPickable = true;
    return addShadow(mesh, cast, receive);
  }

  function cylinder(name, options, position, material, parent, cast, receive) {
    var mesh = BABYLON.MeshBuilder.CreateCylinder(name, options, scene);
    mesh.position.copyFrom(position);
    mesh.material = material;
    if (parent) mesh.parent = parent;
    return addShadow(mesh, cast, receive);
  }

  function createFactory(root) {
    var b = state.config.layout.building;
    var extensionRoom = state.config.layout.extensionRoom;
    var extensionLength = extensionRoom && extensionRoom.enabled ? extensionRoom.length : 0;
    var outdoor = BABYLON.MeshBuilder.CreateGround('outdoor-ground', {
      width: b.width + 320 + extensionLength,
      height: b.depth + 280,
      subdivisions: 2
    }, scene);
    outdoor.position.x = -extensionLength / 2;
    outdoor.position.y = -2;
    outdoor.material = state.materials.outdoor;
    outdoor.receiveShadows = true;
    outdoor.parent = root;

    var floor = BABYLON.MeshBuilder.CreateGround('factory-floor', {
      width: b.width,
      height: b.depth,
      subdivisions: 2
    }, scene);
    floor.material = state.materials.floor;
    floor.receiveShadows = true;
    floor.parent = root;
    createFloorAccents(root, b);

    box('center-path', new BABYLON.Vector3(b.width * 0.94, 1.2, Math.max(26, b.depth * 0.07)), new BABYLON.Vector3(0, 1.2, 0), state.materials.path, root, false, true);
    box('front-zone', new BABYLON.Vector3(b.width * 0.88, 1.2, b.depth * 0.28), new BABYLON.Vector3(0, 1.4, -b.depth * 0.28), state.materials.zone, root, false, true);
    box('back-zone', new BABYLON.Vector3(b.width * 0.88, 1.2, b.depth * 0.28), new BABYLON.Vector3(0, 1.4, b.depth * 0.28), state.materials.zone, root, false, true);

    var wallH = b.wallH;
    var sideDoorW = Math.min(190, b.depth * 0.34);
    var sideDoorH = wallH * 0.72;
    var sideWallSegment = Math.max(20, (b.depth - sideDoorW) / 2);
    box('back-wall', new BABYLON.Vector3(b.width, wallH, 5), new BABYLON.Vector3(0, wallH / 2, b.halfD), state.materials.wall, root, true, true);
    if (extensionRoom && extensionRoom.enabled) {
      createFarEndExtension(root, b, extensionRoom);
    } else {
      box('left-wall', new BABYLON.Vector3(5, wallH, b.depth), new BABYLON.Vector3(-b.halfW, wallH / 2, 0), state.materials.wall, root, true, true);
    }
    box('right-wall-front', new BABYLON.Vector3(5, wallH, sideWallSegment), new BABYLON.Vector3(b.halfW, wallH / 2, -sideDoorW / 2 - sideWallSegment / 2), state.materials.wall, root, true, true);
    box('right-wall-back', new BABYLON.Vector3(5, wallH, sideWallSegment), new BABYLON.Vector3(b.halfW, wallH / 2, sideDoorW / 2 + sideWallSegment / 2), state.materials.wall, root, true, true);
    box('right-door-header', new BABYLON.Vector3(5, wallH - sideDoorH, sideDoorW), new BABYLON.Vector3(b.halfW, sideDoorH + (wallH - sideDoorH) / 2, 0), state.materials.wall, root, true, true);
    box('front-wall', new BABYLON.Vector3(b.width, wallH, 5), new BABYLON.Vector3(0, wallH / 2, -b.halfD), state.materials.wall, root, true, true);

    createRightMiddleGate(root, b, sideDoorW, sideDoorH);

    createRoof(root, b);
    createFrame(root, b);
    createIndustrialOverhead(root, b);
    createIndustrialEdgeDetails(root, b);
  }

  function createFarEndExtension(root, building, room) {
    var length = clamp(toNumber(room.length, 180), 60, 360);
    // This room is a continuation of the factory footprint, so its two long
    // walls must stay exactly flush with the main building.
    var width = building.depth;
    var wallHeight = clamp(toNumber(room.wallHeight, 27), 8, building.wallH);
    var doorCount = clamp(Math.round(toNumber(room.doorCount, 3)), 1, 6);
    var doorHeight = clamp(toNumber(room.doorHeight, 21), 8, wallHeight - 2);
    var doorWidth = Math.min(
      clamp(toNumber(room.doorWidth, 52), 24, 96),
      width / doorCount * 0.58
    );
    var wallThickness = 5;
    var boundaryX = -building.halfW;
    var outerX = boundaryX - length;
    var centerX = boundaryX - length / 2;
    var zMin = -width / 2;
    var zMax = width / 2;

    var floor = box(
      'extension-room-floor',
      new BABYLON.Vector3(length, 1.2, width),
      new BABYLON.Vector3(centerX, 0.7, 0),
      state.materials.zone,
      root,
      false,
      true
    );
    floor.checkCollisions = false;

    box(
      'extension-room-outer-wall',
      new BABYLON.Vector3(wallThickness, wallHeight, width),
      new BABYLON.Vector3(outerX, wallHeight / 2, 0),
      state.materials.roomWall,
      root,
      true,
      true
    );
    box(
      'extension-room-front-wall',
      new BABYLON.Vector3(length + wallThickness, wallHeight, wallThickness),
      new BABYLON.Vector3(centerX, wallHeight / 2, zMin),
      state.materials.roomWall,
      root,
      true,
      true
    );
    box(
      'extension-room-back-wall',
      new BABYLON.Vector3(length + wallThickness, wallHeight, wallThickness),
      new BABYLON.Vector3(centerX, wallHeight / 2, zMax),
      state.materials.roomWall,
      root,
      true,
      true
    );

    var cursor = zMin;
    for (var doorIndex = 0; doorIndex < doorCount; doorIndex++) {
      var doorCenter = zMin + (doorIndex + 0.5) * width / doorCount;
      var gapStart = doorCenter - doorWidth / 2;
      var gapEnd = doorCenter + doorWidth / 2;
      createExtensionBoundarySegment(root, boundaryX, cursor, gapStart, wallHeight, wallThickness, doorIndex);
      var headerHeight = wallHeight - doorHeight;
      if (headerHeight > 0.2) {
        box(
          'extension-room-door-header-' + doorIndex,
          new BABYLON.Vector3(wallThickness, headerHeight, doorWidth),
          new BABYLON.Vector3(boundaryX, doorHeight + headerHeight / 2, doorCenter),
          state.materials.roomWall,
          root,
          true,
          true
        );
      }
      createLayoutDoor({
        id: 'extension-room-door-' + (doorIndex + 1),
        name: '\u6269\u5efa\u623f\u95f4\u95e8 ' + (doorIndex + 1),
        x: boundaryX,
        z: doorCenter,
        length: doorWidth,
        height: doorHeight,
        thickness: 2.8,
        rotation: 90,
        variant: 'double'
      }, 100 + doorIndex, root);
      cursor = gapEnd;
    }
    createExtensionBoundarySegment(root, boundaryX, cursor, zMax, wallHeight, wallThickness, doorCount);

    var roof = box(
      'extension-room-roof',
      new BABYLON.Vector3(length + 8, 1.2, width + 8),
      new BABYLON.Vector3(centerX, wallHeight + 1.2, 0),
      state.materials.glass,
      root,
      false,
      true
    );
    roof.isPickable = false;

    [[boundaryX, zMin], [boundaryX, zMax], [outerX, zMin], [outerX, zMax]].forEach(function (point, index) {
      box(
        'extension-room-column-' + index,
        new BABYLON.Vector3(7, wallHeight, 7),
        new BABYLON.Vector3(point[0], wallHeight / 2, point[1]),
        state.materials.steel,
        root,
        true,
        true
      );
    });

    createExtensionRoomLights(root, building, room, {
      boundaryX: boundaryX,
      outerX: outerX,
      centerX: centerX,
      width: width,
      wallHeight: wallHeight
    });
    createExtensionRoomSign(root, new BABYLON.Vector3(boundaryX - 6, wallHeight + 7, 0));
    state.layoutEntries.push({
      kind: 'room',
      name: '\u5c01\u7bb1\u673a\u533a\u57df',
      meta: Math.round(length) + ' \u00d7 ' + Math.round(width),
      focus: new BABYLON.Vector3(centerX, wallHeight / 2, 0)
    });
  }

  function createExtensionRoomLights(parent, building, room, bounds) {
    var columns = clamp(Math.round(toNumber(room.lightColumns, 12)), 1, 40);
    var lightsPerColumn = clamp(Math.round(toNumber(room.lightsPerColumn, 14)), 1, 120);
    var roomGrid = {
      enabled: true,
      columns: columns,
      lightsPerColumn: lightsPerColumn,
      orientation: 'x',
      gridArea: 'extension'
    };
    var factoryGrid = state.config.layout.lightingGrid;
    var factoryAligned = !!(factoryGrid && factoryGrid.enabled && factoryGrid.orientation === 'x');
    var referenceGrid = factoryAligned ? factoryGrid : {
      columns: columns,
      lightsPerColumn: Math.max(2, Math.round(building.width / 15)),
      orientation: 'x'
    };
    var metrics = getGridMetrics(referenceGrid, building);
    metrics.orientation = 'x';

    var columnPositions = [];
    if (factoryAligned && factoryGrid.columns === columns) {
      for (var alignedColumn = 1; alignedColumn <= columns; alignedColumn++) {
        columnPositions.push(getGridPanelPosition(metrics, alignedColumn, 1).z);
      }
    } else {
      var columnEdge = clamp(bounds.width * 0.06, 22, 78);
      var usableWidth = Math.max(1, bounds.width - columnEdge * 2);
      var columnPitch = columns > 1 ? usableWidth / (columns - 1) : 0;
      for (var roomColumn = 0; roomColumn < columns; roomColumn++) {
        columnPositions.push(columns > 1 ? -usableWidth / 2 + roomColumn * columnPitch : 0);
      }
    }

    var pitch = Math.max(1, metrics.lightPitch);
    var firstX;
    if (factoryAligned) {
      var factoryFirst = getGridPanelPosition(metrics, 1, 1).x;
      var factoryLast = getGridPanelPosition(metrics, 1, factoryGrid.lightsPerColumn).x;
      var innerFactoryX = Math.min(factoryFirst, factoryLast);
      var desiredFirstX = bounds.centerX + (lightsPerColumn - 1) * pitch / 2;
      var phaseSteps = Math.max(1, Math.round((innerFactoryX - desiredFirstX) / pitch));
      firstX = innerFactoryX - phaseSteps * pitch;
    } else {
      firstX = bounds.centerX + (lightsPerColumn - 1) * pitch / 2;
    }

    var edgePadding = metrics.panelDepth / 2 + 6;
    var lastX = firstX - (lightsPerColumn - 1) * pitch;
    if (firstX > bounds.boundaryX - edgePadding || lastX < bounds.outerX + edgePadding) {
      pitch = lightsPerColumn > 1
        ? Math.min(pitch, Math.max(1, (bounds.boundaryX - bounds.outerX - edgePadding * 2) / (lightsPerColumn - 1)))
        : 0;
      firstX = bounds.centerX + (lightsPerColumn - 1) * pitch / 2;
      factoryAligned = false;
    }

    var lightY = Math.min(metrics.y, bounds.wallHeight - 1.5);
    var roomMetrics = Object.assign({}, metrics, { orientation: 'x', y: lightY, lightPitch: pitch });
    var lightRoot = new BABYLON.TransformNode('extension-room-light-grid', scene);
    lightRoot.parent = parent;
    lightRoot.metadata = {
      extensionRoomLightGrid: true,
      columns: columns,
      lightsPerColumn: lightsPerColumn,
      totalLights: columns * lightsPerColumn,
      factoryAligned: factoryAligned,
      configurable: true,
      gridArea: 'extension'
    };

    roomMetrics.columns = columns;
    roomMetrics.lightsPerColumn = lightsPerColumn;
    roomMetrics.extensionColumnPositions = columnPositions;
    roomMetrics.extensionFirstX = firstX;
    roomMetrics.gridArea = 'extension';
    state.extensionGridMetrics = roomMetrics;
    state.extensionGrid = roomGrid;

    var renderOptions = {
      gridArea: 'extension',
      metrics: roomMetrics,
      getPanelPosition: getExtensionRoomPanelPosition,
      namePrefix: 'extension-room-light',
      metadata: { extensionRoomLight: true }
    };
    var extensionLights = state.config.lights.filter(function(light) {
      return getLightGridArea(light) === 'extension';
    });

    // Unassigned cells remain visible so the operator can map them in either
    // the 2D or 3D configuration surface.  They deliberately have no lightIndex
    // and therefore can never pretend to be on or issue a relay command.
    createUnboundGridPanels(extensionLights, roomGrid, building, lightRoot, renderOptions);

    state.config.lights.forEach(function(light, index) {
      if (getLightGridArea(light) !== 'extension' || !isGridLightSegment(light, roomGrid, 'extension')) return;
      state.lightEntries[index] = createGridLightSegment(
        light,
        index,
        roomGrid,
        building,
        lightRoot,
        renderOptions
      );
    });
  }

  function getExtensionRoomPanelPosition(metrics, column, lightNumber) {
    var columnIndex = clamp(Math.round(toNumber(column, 1)), 1, metrics.columns) - 1;
    var numberIndex = clamp(Math.round(toNumber(lightNumber, 1)), 1, metrics.lightsPerColumn) - 1;
    return {
      x: metrics.extensionFirstX - numberIndex * metrics.lightPitch,
      z: metrics.extensionColumnPositions[columnIndex]
    };
  }

  function createExtensionBoundarySegment(parent, x, z1, z2, height, thickness, index) {
    var length = z2 - z1;
    if (length <= 0.2) return;
    box(
      'extension-room-inner-wall-' + index,
      new BABYLON.Vector3(thickness, height, length),
      new BABYLON.Vector3(x, height / 2, (z1 + z2) / 2),
      state.materials.roomWall,
      parent,
      true,
      true
    );
  }

  function createExtensionRoomSign(parent, position) {
    var texture = new BABYLON.DynamicTexture('extension-room-sign-texture', { width: 360, height: 100 }, scene, false);
    texture.hasAlpha = true;
    var context = texture.getContext();
    context.clearRect(0, 0, 360, 100);
    context.fillStyle = 'rgba(10,24,31,0.88)';
    roundRect(context, 12, 12, 336, 76, 14);
    context.fill();
    context.lineWidth = 3;
    context.strokeStyle = 'rgba(90,200,250,0.90)';
    context.stroke();
    context.fillStyle = '#e8fbff';
    context.font = '700 32px Microsoft YaHei, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('\u5c01\u7bb1\u673a\u533a\u57df', 180, 50);
    texture.update();

    var material = new BABYLON.StandardMaterial('extension-room-sign-material', scene);
    material.diffuseTexture = texture;
    material.emissiveTexture = texture;
    material.opacityTexture = texture;
    material.disableLighting = true;
    material.backFaceCulling = false;
    var sign = BABYLON.MeshBuilder.CreatePlane('extension-room-sign', { width: 90, height: 25 }, scene);
    sign.position.copyFrom(position);
    sign.material = material;
    sign.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
    sign.isPickable = false;
    sign.parent = parent;
  }

  function createFloorAccents(root, b) {
    var y = 1.92;
    var lineW = Math.max(3, b.width * 0.004);
    [
      [0, -b.depth * 0.24, b.width * 0.86, lineW],
      [0, b.depth * 0.24, b.width * 0.86, lineW]
    ].forEach(function (item, index) {
      var mesh = box(
        'floor-safety-line-' + index,
        new BABYLON.Vector3(item[2], 0.22, item[3]),
        new BABYLON.Vector3(item[0], y, item[1]),
        state.materials.safetyLine,
        root,
        false,
        false
      );
      mesh.checkCollisions = false;
      mesh.isPickable = false;
    });
  }

  function createRightMiddleGate(root, b, width, height) {
    var x = b.halfW + 3.4;
    var panelDepth = width * 0.46;
    box('main-gate-left-panel', new BABYLON.Vector3(3.2, height, panelDepth), new BABYLON.Vector3(x, height / 2, -width * 0.24), state.materials.door, root, true, true);
    box('main-gate-right-panel', new BABYLON.Vector3(3.2, height, panelDepth), new BABYLON.Vector3(x, height / 2, width * 0.24), state.materials.door, root, true, true);
    box('main-gate-center-line', new BABYLON.Vector3(3.6, height * 0.92, 1.2), new BABYLON.Vector3(x + 0.1, height * 0.46, 0), state.materials.steel, root, true, true);
    box('main-gate-top-track', new BABYLON.Vector3(6.4, 3.0, width * 1.08), new BABYLON.Vector3(x, height + 1.5, 0), state.materials.steel, root, true, true);
    box('main-gate-floor-track', new BABYLON.Vector3(6.0, 1.0, width * 1.1), new BABYLON.Vector3(x, 0.7, 0), state.materials.steel, root, true, true);
    box('main-gate-apron', new BABYLON.Vector3(86, 0.9, width * 1.08), new BABYLON.Vector3(b.halfW + 46, 0.8, 0), state.materials.path, root, false, true).checkCollisions = false;
    createGateSign(root, new BABYLON.Vector3(b.halfW + 22, height + 30, 0));
  }

  function createGateSign(parent, position) {
    var tex = new BABYLON.DynamicTexture('main-gate-sign-texture', { width: 360, height: 120 }, scene, false);
    tex.hasAlpha = true;
    var ctx = tex.getContext();
    ctx.clearRect(0, 0, 360, 120);
    ctx.fillStyle = 'rgba(8,18,25,0.82)';
    roundRect(ctx, 18, 18, 324, 84, 16);
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(53,230,168,0.88)';
    ctx.stroke();
    ctx.fillStyle = '#eafff6';
    ctx.font = '700 38px Microsoft YaHei, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('主入口', 180, 60);
    tex.update();

    var mat = new BABYLON.StandardMaterial('main-gate-sign-material', scene);
    mat.diffuseTexture = tex;
    mat.emissiveTexture = tex;
    mat.opacityTexture = tex;
    mat.disableLighting = true;
    mat.backFaceCulling = false;

    var sign = BABYLON.MeshBuilder.CreatePlane('main-gate-sign', { width: 112, height: 37 }, scene);
    sign.position.copyFrom(position);
    sign.material = mat;
    sign.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
    sign.isPickable = false;
    sign.parent = parent;
  }

  function createRoof(root, b) {
    var width = b.width + 46;
    var depth = b.depth + 42;
    var hw = width / 2;
    var hd = depth / 2;
    var positions = [
      -hw, b.wallH, -hd, 0, b.ridgeH, -hd, 0, b.ridgeH, hd, -hw, b.wallH, hd,
      hw, b.wallH, -hd, 0, b.ridgeH, -hd, 0, b.ridgeH, hd, hw, b.wallH, hd
    ];
    var indices = [0, 1, 2, 0, 2, 3, 4, 7, 6, 4, 6, 5];
    var normals = [];
    BABYLON.VertexData.ComputeNormals(positions, indices, normals);

    var mesh = new BABYLON.Mesh('factory-roof', scene);
    var data = new BABYLON.VertexData();
    data.positions = positions;
    data.indices = indices;
    data.normals = normals;
    data.uvs = [0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1];
    data.applyToMesh(mesh);
    mesh.material = pbr('roof-material', {
      color: state.activeStyle === 'tech' ? '#2e4050' : (state.activeStyle === 'industrial' ? '#d9e0e3' : '#aeb6b6'),
      metallic: state.activeStyle === 'tech' ? 0.46 : (state.activeStyle === 'industrial' ? 0.12 : 0.18),
      roughness: state.activeStyle === 'tech' ? 0.25 : (state.activeStyle === 'industrial' ? 0.40 : 0.48),
      alpha: state.activeStyle === 'tech' ? 0.045 : (state.activeStyle === 'industrial' ? 0.035 : 0.48)
    });
    mesh.parent = root;
    mesh.isPickable = false;
    addShadow(mesh, true, true);
  }

  function createFrame(root, b) {
    var count = Math.max(4, Math.round(b.width / 260));
    for (var i = 0; i < count; i++) {
      var x = -b.halfW + 48 + i * ((b.width - 96) / Math.max(1, count - 1));
      box('steel-column-front-' + i, new BABYLON.Vector3(7, b.wallH, 7), new BABYLON.Vector3(x, b.wallH / 2, -b.halfD + 22), state.materials.steel, root, true, true);
      box('steel-column-back-' + i, new BABYLON.Vector3(7, b.wallH, 7), new BABYLON.Vector3(x, b.wallH / 2, b.halfD - 22), state.materials.steel, root, true, true);
    }

  }

  function finalizeIndustrialMesh(mesh, name, material, parent, metadata, castShadow) {
    if (!mesh) return null;
    mesh.name = name;
    mesh.id = name;
    mesh.material = material;
    mesh.parent = parent || null;
    mesh.isPickable = false;
    mesh.checkCollisions = false;
    mesh.receiveShadows = false;
    mesh.metadata = Object.assign({ visualDetail: true }, metadata || {});
    if (castShadow) shadow.addShadowCaster(mesh, true);
    mesh.freezeWorldMatrix();
    return mesh;
  }

  function mergeIndustrialBoxes(name, specs, material, parent, metadata, castShadow) {
    if (!specs || !specs.length) return null;
    var parts = specs.map(function (spec, index) {
      var mesh = BABYLON.MeshBuilder.CreateBox(name + '-part-' + index, {
        width: spec.size.x,
        height: spec.size.y,
        depth: spec.size.z
      }, scene);
      mesh.position.copyFrom(spec.position);
      if (spec.rotation) mesh.rotation.copyFrom(spec.rotation);
      mesh.isPickable = false;
      mesh.checkCollisions = false;
      mesh.computeWorldMatrix(true);
      return mesh;
    });
    var merged = BABYLON.Mesh.MergeMeshes(parts, true, true, undefined, false, false);
    return finalizeIndustrialMesh(
      merged,
      name,
      material,
      parent,
      Object.assign({ physicalParts: specs.length }, metadata || {}),
      castShadow
    );
  }

  function mergeIndustrialCylinders(name, specs, material, parent, metadata, castShadow) {
    if (!specs || !specs.length) return null;
    var parts = specs.map(function (spec, index) {
      var mesh = BABYLON.MeshBuilder.CreateCylinder(name + '-part-' + index, {
        height: spec.length,
        diameter: spec.diameter,
        diameterTop: spec.diameterTop == null ? spec.diameter : spec.diameterTop,
        diameterBottom: spec.diameterBottom == null ? spec.diameter : spec.diameterBottom,
        tessellation: spec.tessellation || 12
      }, scene);
      mesh.position.copyFrom(spec.position);
      if (spec.axis === 'x') mesh.rotation.z = Math.PI / 2;
      else if (spec.axis === 'z') mesh.rotation.x = Math.PI / 2;
      mesh.isPickable = false;
      mesh.checkCollisions = false;
      mesh.computeWorldMatrix(true);
      return mesh;
    });
    var merged = BABYLON.Mesh.MergeMeshes(parts, true, true, undefined, false, false);
    return finalizeIndustrialMesh(
      merged,
      name,
      material,
      parent,
      Object.assign({ physicalParts: specs.length }, metadata || {}),
      castShadow
    );
  }

  function addIndustrialYzBeam(specs, x, startY, startZ, endY, endZ, thickness) {
    var dy = endY - startY;
    var dz = endZ - startZ;
    var length = Math.sqrt(dy * dy + dz * dz);
    specs.push({
      size: new BABYLON.Vector3(thickness, thickness, length),
      position: new BABYLON.Vector3(x, (startY + endY) / 2, (startZ + endZ) / 2),
      rotation: new BABYLON.Vector3(-Math.atan2(dy, dz), 0, 0)
    });
  }

  function industrialRoofY(building, z) {
    var roofHalfDepth = building.halfD + 21;
    var ratio = clamp(Math.abs(z) / Math.max(1, roofHalfDepth), 0, 1);
    return building.ridgeH - (building.ridgeH - building.wallH) * ratio;
  }

  function createIndustrialOverhead(parent, building) {
    var hangerRods = [];
    var hangerBrackets = [];
    createIndustrialRoofTrusses(parent, building);
    createIndustrialFireNetwork(parent, building, hangerRods, hangerBrackets);
    var hangerGroupCount = hangerBrackets.length;
    mergeIndustrialCylinders(
      'industrial-hanger-rods',
      hangerRods,
      state.materials.industrialCableTray,
      parent,
      { detailKind: 'hanger', hangerGroups: hangerGroupCount },
      false
    );
    mergeIndustrialBoxes(
      'industrial-hanger-brackets',
      hangerBrackets,
      state.materials.industrialCableTray,
      parent,
      { detailKind: 'hanger', hangerGroups: hangerGroupCount },
      false
    );
  }

  function createIndustrialRoofTrusses(parent, building) {
    var frameXs = [-480, -360, -240, -120, 0, 120, 240, 360, 480];
    var lowerY = building.wallH + 1.2;
    frameXs.forEach(function (x, index) {
      var specs = [];
      [[-250, -168], [-88, 88], [168, 250]].forEach(function (range) {
        specs.push({
          size: new BABYLON.Vector3(2.2, 1.5, range[1] - range[0]),
          position: new BABYLON.Vector3(x, lowerY, (range[0] + range[1]) / 2)
        });
      });

      var edgeTopY = industrialRoofY(building, 300) - 1.0;
      var ridgeTopY = building.ridgeH - 1.2;
      addIndustrialYzBeam(specs, x, edgeTopY, -300, ridgeTopY, 0, 2.1);
      addIndustrialYzBeam(specs, x, ridgeTopY, 0, edgeTopY, 300, 2.1);

      var nodes = [-230, -190, -70, 0, 70, 190, 230];
      nodes.forEach(function (z) {
        var topY = industrialRoofY(building, z) - 1.3;
        var height = Math.max(1.2, topY - lowerY);
        specs.push({
          size: new BABYLON.Vector3(1.15, height, 1.15),
          position: new BABYLON.Vector3(x, lowerY + height / 2, z)
        });
      });
      for (var n = 0; n < nodes.length - 1; n++) {
        var startZ = nodes[n];
        var endZ = nodes[n + 1];
        if (n % 2) {
          addIndustrialYzBeam(specs, x, industrialRoofY(building, startZ) - 1.5, startZ, lowerY + 0.8, endZ, 1.0);
        } else {
          addIndustrialYzBeam(specs, x, lowerY + 0.8, startZ, industrialRoofY(building, endZ) - 1.5, endZ, 1.0);
        }
      }
      mergeIndustrialBoxes(
        'industrial-roof-truss-' + pad(index + 1),
        specs,
        state.materials.industrialTruss,
        parent,
        { detailKind: 'roofTruss', bayIndex: index + 1 },
        true
      );
    });

    var purlinSpecs = [];
    [-240, -180, -120, -60, 0, 60, 120, 180, 240].forEach(function (z) {
      purlinSpecs.push({
        size: new BABYLON.Vector3(building.width - 100, 1.25, 1.25),
        position: new BABYLON.Vector3(0, industrialRoofY(building, z) - 1.55, z)
      });
    });
    mergeIndustrialBoxes(
      'industrial-roof-purlins',
      purlinSpecs,
      state.materials.industrialTruss,
      parent,
      { detailKind: 'roofPurlin' },
      false
    );
  }

  function createIndustrialCableTrays(parent, building, hangerRods, hangerBrackets) {
    var trayZs = [-256, -102.4, 102.4, 256];
    var trayLength = building.width - 160;
    var cableSpecs = [];
    trayZs.forEach(function (z, index) {
      var specs = [
        { size: new BABYLON.Vector3(trayLength, 0.5, 14), position: new BABYLON.Vector3(0, 32.25, z) },
        { size: new BABYLON.Vector3(trayLength, 1.8, 1.1), position: new BABYLON.Vector3(0, 32.9, z - 6.45) },
        { size: new BABYLON.Vector3(trayLength, 1.8, 1.1), position: new BABYLON.Vector3(0, 32.9, z + 6.45) }
      ];
      for (var connectorX = -440; connectorX <= 440; connectorX += 110) {
        specs.push({
          size: new BABYLON.Vector3(1.0, 2.0, 15.2),
          position: new BABYLON.Vector3(connectorX, 32.85, z)
        });
      }
      mergeIndustrialBoxes(
        'industrial-cable-tray-' + pad(index + 1),
        specs,
        state.materials.industrialCableTray,
        parent,
        { detailKind: 'cableTray', trayIndex: index + 1 },
        false
      );

      [-4.1, 0, 4.1].forEach(function (offset) {
        cableSpecs.push({
          size: new BABYLON.Vector3(trayLength - 20, 0.58, 1.15),
          position: new BABYLON.Vector3(0, 32.8, z + offset)
        });
      });
      for (var slotX = -500; slotX <= 500; slotX += 32) {
        cableSpecs.push({
          size: new BABYLON.Vector3(4.5, 0.18, 10.8),
          position: new BABYLON.Vector3(slotX, 32.58, z)
        });
      }

      [-490, -350, -210, -70, 70, 210, 350, 490].forEach(function (x) {
        var topY = industrialRoofY(building, z) - 1.2;
        var bottomY = 33.85;
        [-7.5, 7.5].forEach(function (offset) {
          hangerRods.push({
            length: Math.max(0.8, topY - bottomY),
            diameter: 0.42,
            axis: 'y',
            position: new BABYLON.Vector3(x, (topY + bottomY) / 2, z + offset)
          });
        });
        hangerBrackets.push({
          size: new BABYLON.Vector3(1.1, 0.7, 18),
          position: new BABYLON.Vector3(x, bottomY, z)
        });
      });
    });
    mergeIndustrialBoxes(
      'industrial-cable-core-batch',
      cableSpecs,
      state.materials.industrialCable,
      parent,
      { detailKind: 'cableCore', trayCount: trayZs.length },
      false
    );
  }

  function createIndustrialDucts(parent, building, hangerRods, hangerBrackets) {
    var ductZs = [-153.6, 153.6];
    var flangeSpecs = [];
    var branchXs = [-300, 60, 300];
    var branchIndex = 0;
    ductZs.forEach(function (z, index) {
      var specs = [];
      [-350, -210, -70, 70, 210, 350].forEach(function (x) {
        specs.push({
          size: new BABYLON.Vector3(136, 1.8, 18),
          position: new BABYLON.Vector3(x, 33.15, z)
        });
      });
      [-420, -280, -140, 0, 140, 280, 420].forEach(function (x) {
        flangeSpecs.push({
          size: new BABYLON.Vector3(1.4, 2.25, 19.4),
          position: new BABYLON.Vector3(x, 33.15, z)
        });
      });
      mergeIndustrialBoxes(
        'industrial-duct-main-' + pad(index + 1),
        specs,
        state.materials.industrialDuct,
        parent,
        { detailKind: 'ductMain', ductIndex: index + 1 },
        false
      );

      branchXs.forEach(function (x) {
        branchIndex += 1;
        var outerZ = z < 0 ? -256 : 256;
        var centerZ = (z + outerZ) / 2;
        var branchSpecs = [
          {
            size: new BABYLON.Vector3(14, 1.55, Math.abs(outerZ - z)),
            position: new BABYLON.Vector3(x, 33.0, centerZ)
          },
          {
            size: new BABYLON.Vector3(16, 2.2, 18),
            position: new BABYLON.Vector3(x, 32.9, outerZ)
          },
          {
            size: new BABYLON.Vector3(14, 10.0, 14),
            position: new BABYLON.Vector3(x, 27.0, outerZ)
          },
          {
            size: new BABYLON.Vector3(20, 1.8, 20),
            position: new BABYLON.Vector3(x, 21.3, outerZ)
          }
        ];
        mergeIndustrialBoxes(
          'industrial-duct-branch-' + pad(branchIndex),
          branchSpecs,
          state.materials.industrialDuct,
          parent,
          { detailKind: 'ductBranch', branchIndex: branchIndex },
          false
        );
      });

      [-375, -225, -75, 75, 225, 375].forEach(function (x) {
        var topY = industrialRoofY(building, z) - 1.15;
        var bottomY = 34.35;
        [-10.2, 10.2].forEach(function (offset) {
          hangerRods.push({
            length: Math.max(0.8, topY - bottomY),
            diameter: 0.46,
            axis: 'y',
            position: new BABYLON.Vector3(x, (topY + bottomY) / 2, z + offset)
          });
        });
        hangerBrackets.push({
          size: new BABYLON.Vector3(1.2, 0.75, 24),
          position: new BABYLON.Vector3(x, bottomY, z)
        });
      });
    });
    mergeIndustrialBoxes(
      'industrial-duct-flange-batch',
      flangeSpecs,
      state.materials.industrialCableTray,
      parent,
      { detailKind: 'ductFlange', ductCount: ductZs.length },
      false
    );
  }

  function createIndustrialFireNetwork(parent, building, hangerRods, hangerBrackets) {
    [-305, 305].forEach(function (z, index) {
      mergeIndustrialCylinders(
        'industrial-fire-pipe-main-' + pad(index + 1),
        [{
          length: building.width - 200,
          diameter: 1.8,
          axis: 'x',
          position: new BABYLON.Vector3(0, 32.9, z)
        }],
        state.materials.industrialFire,
        parent,
        { detailKind: 'firePipeMain', pipeIndex: index + 1 },
        false
      );
      [-250, 250].forEach(function (x) {
        var topY = industrialRoofY(building, z) - 0.65;
        var bottomY = 33.85;
        hangerRods.push({
          length: Math.max(0.5, topY - bottomY),
          diameter: 0.40,
          axis: 'y',
          position: new BABYLON.Vector3(x, (topY + bottomY) / 2, z)
        });
        hangerBrackets.push({
          size: new BABYLON.Vector3(5.0, 0.65, 1.0),
          position: new BABYLON.Vector3(x, bottomY, z)
        });
      });
    });

    var crossXs = [-420, -300, -180, -60, 60, 180, 300, 420];
    var sprinklerSpecs = [];
    crossXs.forEach(function (x, index) {
      mergeIndustrialCylinders(
        'industrial-fire-pipe-cross-' + pad(index + 1),
        [{
          length: 604,
          diameter: 1.05,
          axis: 'z',
          position: new BABYLON.Vector3(x, 33.0, 0)
        }],
        state.materials.industrialFire,
        parent,
        { detailKind: 'firePipeCross', pipeIndex: index + 1 },
        false
      );
      [-51.2, 51.2].forEach(function (z) {
        sprinklerSpecs.push({
          length: 1.45,
          diameter: 0.48,
          axis: 'y',
          position: new BABYLON.Vector3(x, 32.25, z)
        });
        sprinklerSpecs.push({
          length: 0.42,
          diameter: 2.2,
          diameterTop: 0.8,
          diameterBottom: 2.2,
          axis: 'y',
          position: new BABYLON.Vector3(x, 31.45, z)
        });
      });
    });
    mergeIndustrialCylinders(
      'industrial-sprinkler-batch',
      sprinklerSpecs,
      state.materials.industrialFire,
      parent,
      { detailKind: 'sprinkler', sprinklerCount: 16 },
      false
    );
  }

  function createIndustrialEdgeDetails(parent, building) {
    createIndustrialColumnGuards(parent, building);
    createIndustrialSigns(parent, building);
  }

  function createIndustrialMaintenancePlatforms(parent, building) {
    var platforms = [
      { x: -360, z: -296, innerZ: -283.5, ladderZ: -307.5 },
      { x: 240, z: 296, innerZ: 283.5, ladderZ: 307.5 }
    ];
    platforms.forEach(function (platform, index) {
      var supportZ = platform.z < 0 ? platform.z - 7 : platform.z + 7;
      var platformSpecs = [
        { size: new BABYLON.Vector3(84, 1.2, 24), position: new BABYLON.Vector3(platform.x, 12.5, platform.z) },
        { size: new BABYLON.Vector3(80, 1.0, 3.0), position: new BABYLON.Vector3(platform.x, 10.8, supportZ) }
      ];
      [-38, 38].forEach(function (offsetX) {
        [-8, 8].forEach(function (offsetZ) {
          platformSpecs.push({
            size: new BABYLON.Vector3(3.2, 12.0, 3.2),
            position: new BABYLON.Vector3(platform.x + offsetX, 6.0, platform.z + offsetZ)
          });
        });
      });
      mergeIndustrialBoxes(
        'industrial-maintenance-platform-' + pad(index + 1),
        platformSpecs,
        state.materials.industrialDeck,
        parent,
        { detailKind: 'maintenancePlatform', platformIndex: index + 1 },
        true
      );

      var guardrailSpecs = [];
      [-40, -20, 0, 20, 40].forEach(function (offsetX) {
        guardrailSpecs.push({
          size: new BABYLON.Vector3(1.0, 8.0, 1.0),
          position: new BABYLON.Vector3(platform.x + offsetX, 17.1, platform.innerZ)
        });
      });
      [16.0, 20.6].forEach(function (y) {
        guardrailSpecs.push({
          size: new BABYLON.Vector3(82, 0.9, 0.9),
          position: new BABYLON.Vector3(platform.x, y, platform.innerZ)
        });
        [-41, 41].forEach(function (offsetX) {
          guardrailSpecs.push({
            size: new BABYLON.Vector3(0.9, 0.9, 23),
            position: new BABYLON.Vector3(platform.x + offsetX, y, platform.z)
          });
        });
      });
      mergeIndustrialBoxes(
        'industrial-guardrail-' + pad(index + 1),
        guardrailSpecs,
        state.materials.industrialSafety,
        parent,
        { detailKind: 'guardrail', platformIndex: index + 1 },
        false
      );

      var ladderSpecs = [
        { size: new BABYLON.Vector3(1.0, 13.0, 1.0), position: new BABYLON.Vector3(platform.x - 4.0, 6.5, platform.ladderZ) },
        { size: new BABYLON.Vector3(1.0, 13.0, 1.0), position: new BABYLON.Vector3(platform.x + 4.0, 6.5, platform.ladderZ) }
      ];
      for (var rungY = 1.2; rungY <= 12.2; rungY += 1.65) {
        ladderSpecs.push({
          size: new BABYLON.Vector3(8.0, 0.55, 0.75),
          position: new BABYLON.Vector3(platform.x, rungY, platform.ladderZ)
        });
      }
      mergeIndustrialBoxes(
        'industrial-ladder-' + pad(index + 1),
        ladderSpecs,
        state.materials.industrialTruss,
        parent,
        { detailKind: 'ladder', platformIndex: index + 1 },
        false
      );
    });
  }

  function createIndustrialColumnGuards(parent, building) {
    var count = Math.max(4, Math.round(building.width / 260));
    var guardSpecs = [];
    var stripeSpecs = [];
    for (var i = 0; i < count; i++) {
      var x = -building.halfW + 48 + i * ((building.width - 96) / Math.max(1, count - 1));
      [-building.halfD + 22, building.halfD - 22].forEach(function (z) {
        guardSpecs.push({
          size: new BABYLON.Vector3(10.2, 3.8, 10.2),
          position: new BABYLON.Vector3(x, 1.9, z)
        });
        [0.8, 2.4].forEach(function (y) {
          stripeSpecs.push({
            size: new BABYLON.Vector3(10.6, 0.48, 10.6),
            position: new BABYLON.Vector3(x, y, z)
          });
        });
      });
    }
    mergeIndustrialBoxes(
      'industrial-column-guard-batch',
      guardSpecs,
      state.materials.industrialSafety,
      parent,
      { detailKind: 'columnGuard', guardCount: guardSpecs.length },
      false
    );
    mergeIndustrialBoxes(
      'industrial-column-hazard-stripe-batch',
      stripeSpecs,
      state.materials.industrialCable,
      parent,
      { detailKind: 'hazardStripe', stripeCount: stripeSpecs.length },
      false
    );
  }

  function createIndustrialSigns(parent, building) {
    var signs = [
      { text: 'A区生产线', x: 300, y: 18.5, z: -building.halfD + 8, color: '#2f383a', accent: '#3b8d86' },
      { text: 'B区生产线', x: 300, y: 18.5, z: building.halfD - 8, color: '#2f383a', accent: '#3b8d86' },
      { text: '消防设施', x: building.halfW - 12, y: 17.5, z: -112, color: '#783630', accent: '#d86a5d', fixedRotationY: Math.PI / 2 },
      { text: '安全出口', x: building.halfW - 12, y: 17.5, z: 112, color: '#315e4d', accent: '#68b88f', fixedRotationY: Math.PI / 2 }
    ];
    signs.forEach(function (sign, index) {
      createIndustrialSign('industrial-sign-' + pad(index + 1), sign, parent);
    });
  }

  function createIndustrialSign(name, options, parent) {
    var texture = new BABYLON.DynamicTexture(name + '-texture', { width: 320, height: 96 }, scene, false);
    texture.hasAlpha = true;
    var context = texture.getContext();
    context.clearRect(0, 0, 320, 96);
    context.fillStyle = options.color;
    roundRect(context, 8, 8, 304, 80, 12);
    context.fill();
    context.lineWidth = 4;
    context.strokeStyle = options.accent;
    context.stroke();
    context.fillStyle = '#f5f6f4';
    context.font = '700 30px Microsoft YaHei, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(options.text, 160, 48);
    texture.update();

    var material = new BABYLON.StandardMaterial(name + '-material', scene);
    material.diffuseTexture = texture;
    material.emissiveTexture = texture;
    material.opacityTexture = texture;
    material.emissiveColor = new BABYLON.Color3(0.32, 0.32, 0.32);
    material.backFaceCulling = false;

    var sign = BABYLON.MeshBuilder.CreatePlane(name, { width: 58, height: 17.4 }, scene);
    sign.position = new BABYLON.Vector3(options.x, options.y, options.z);
    sign.material = material;
    if (Number.isFinite(options.fixedRotationY)) {
      sign.billboardMode = BABYLON.Mesh.BILLBOARDMODE_NONE;
      sign.rotation.y = options.fixedRotationY;
    } else {
      sign.billboardMode = BABYLON.Mesh.BILLBOARDMODE_Y;
    }
    sign.isPickable = false;
    sign.checkCollisions = false;
    sign.receiveShadows = false;
    sign.metadata = { visualDetail: true, detailKind: 'industrialSign' };
    sign.parent = parent;
  }

  function createLayoutObjects(root) {
    var layout = state.config.layout;
    layout.zones.forEach(function (item, index) {
      createZone(item, index, root);
    });
    layout.walls.forEach(function (item, index) {
      createLayoutWall(item, index, root);
    });
    layout.doors.forEach(function (item, index) {
      createLayoutDoor(item, index, root);
    });
    layout.workstations.forEach(function (item, index) {
      createWorkstation(item, index, root);
    });
    layout.racks.forEach(function (item, index) {
      createRack(item, index, root);
    });
    layout.paths.forEach(function (item, index) {
      createPath(item, index, root);
    });
  }

  function createRotatedRoot(name, item, parent) {
    var node = new BABYLON.TransformNode(name, scene);
    node.position = new BABYLON.Vector3(toNumber(item.x, 0), 0, toNumber(item.z, 0));
    node.rotation.y = toNumber(item.rotation, 0) * Math.PI / 180;
    node.parent = parent;
    return node;
  }

  function createLayoutWall(item, index, parent) {
    var x1 = toNumber(item.x1, 0);
    var z1 = toNumber(item.z1, 0);
    var x2 = toNumber(item.x2, x1);
    var z2 = toNumber(item.z2, z1);
    var dx = x2 - x1;
    var dz = z2 - z1;
    var length = Math.max(0.1, Math.hypot(dx, dz));
    var height = Math.max(4, toNumber(item.height, 26));
    var thickness = Math.max(2.4, toNumber(item.thickness, 4));
    var root = new BABYLON.TransformNode('layout-wall-root-' + index, scene);
    root.position = new BABYLON.Vector3((x1 + x2) / 2, 0, (z1 + z2) / 2);
    root.rotation.y = Math.atan2(dx, dz);
    root.parent = parent;
    root.metadata = { layoutKind: 'wall', layoutId: item.id || index };

    box(
      'layout-wall-' + index,
      new BABYLON.Vector3(thickness, height, length),
      new BABYLON.Vector3(0, height / 2, 0),
      state.materials.roomWall,
      root,
      true,
      true
    );
    box(
      'layout-wall-cap-' + index,
      new BABYLON.Vector3(thickness + 1.2, 0.8, length + 0.6),
      new BABYLON.Vector3(0, height + 0.4, 0),
      state.materials.steel,
      root,
      true,
      true
    );
    state.layoutEntries.push({
      kind: 'wall',
      name: cleanName(item.name, '墙体 ' + pad(index + 1)),
      meta: '长度 ' + Math.round(length) + ' · 高 ' + Math.round(height),
      focus: root.position.add(new BABYLON.Vector3(0, height / 2, 0))
    });
  }

  function createLayoutDoor(item, index, parent) {
    var length = Math.max(18, toNumber(item.length, 48));
    var height = Math.max(8, toNumber(item.height, 20));
    var thickness = Math.max(1.2, toNumber(item.thickness, 2.4));
    var root = createRotatedRoot('layout-door-root-' + index, item, parent);
    root.metadata = { layoutKind: 'door', layoutId: item.id || index };
    var postWidth = Math.max(2.2, thickness * 0.9);
    var beamHeight = 1.8;

    box(
      'layout-door-left-post-' + index,
      new BABYLON.Vector3(postWidth, height + beamHeight, thickness * 1.6),
      new BABYLON.Vector3(-length / 2, (height + beamHeight) / 2, 0),
      state.materials.steel,
      root,
      true,
      true
    );
    box(
      'layout-door-right-post-' + index,
      new BABYLON.Vector3(postWidth, height + beamHeight, thickness * 1.6),
      new BABYLON.Vector3(length / 2, (height + beamHeight) / 2, 0),
      state.materials.steel,
      root,
      true,
      true
    );
    box(
      'layout-door-header-' + index,
      new BABYLON.Vector3(length + postWidth, beamHeight, thickness * 1.8),
      new BABYLON.Vector3(0, height + beamHeight / 2, 0),
      state.materials.steel,
      root,
      true,
      true
    );

    if (item.variant === 'double') {
      var leafWidth = length * 0.46;
      box(
        'layout-door-left-leaf-' + index,
        new BABYLON.Vector3(leafWidth, height * 0.9, thickness),
        new BABYLON.Vector3(-length * 0.245, height * 0.45, 0),
        state.materials.door,
        root,
        true,
        true
      );
      box(
        'layout-door-right-leaf-' + index,
        new BABYLON.Vector3(leafWidth, height * 0.9, thickness),
        new BABYLON.Vector3(length * 0.245, height * 0.45, 0),
        state.materials.door,
        root,
        true,
        true
      );
      box(
        'layout-door-divider-' + index,
        new BABYLON.Vector3(0.9, height * 0.9, thickness * 1.25),
        new BABYLON.Vector3(0, height * 0.45, 0),
        state.materials.steel,
        root,
        true,
        true
      );
    } else {
      box(
        'layout-door-leaf-' + index,
        new BABYLON.Vector3(length * 0.92, height * 0.9, thickness),
        new BABYLON.Vector3(0, height * 0.45, 0),
        state.materials.door,
        root,
        true,
        true
      );
      for (var seam = 1; seam <= 6; seam++) {
        box(
          'layout-door-seam-' + index + '-' + seam,
          new BABYLON.Vector3(length * 0.9, 0.18, thickness * 1.15),
          new BABYLON.Vector3(0, seam * height / 7, 0),
          state.materials.steel,
          root,
          false,
          false
        ).checkCollisions = false;
      }
    }

    state.layoutEntries.push({
      kind: 'door',
      name: cleanName(item.name, '门 ' + pad(index + 1)),
      meta: '开口 ' + Math.round(length) + ' · 高 ' + Math.round(height),
      focus: root.position.add(new BABYLON.Vector3(0, height / 2, 0))
    });
  }

  function createWorkstation(item, index, parent) {
    var width = Math.max(24, toNumber(item.width, 80));
    var depth = Math.max(16, toNumber(item.depth, 42));
    var height = Math.max(5, toNumber(item.height, 9));
    var root = createRotatedRoot('workstation-' + index, item, parent);
    var surface = box('workstation-zone-' + index, new BABYLON.Vector3(width, 0.8, depth), new BABYLON.Vector3(0, 0.7, 0), state.materials.zone, root, false, true);
    surface.checkCollisions = false;
    createWorkstationAreaOutline(root, index, width, depth);

    if (item.variant === 'cigarette') {
      var baseW = width * 0.86;
      var baseD = depth * 0.30;
      box('cig-base-' + index, new BABYLON.Vector3(baseW, height * 0.18, baseD), new BABYLON.Vector3(0, height * 0.09 + 1, 0), state.materials.body, root, true, true);
      box('cig-left-block-' + index, new BABYLON.Vector3(width * 0.16, height * 0.48, depth * 0.44), new BABYLON.Vector3(-width * 0.34, height * 0.35 + 1, 0), state.materials.dark, root, true, true);
      box('cig-top-arm-' + index, new BABYLON.Vector3(width * 0.55, height * 0.12, depth * 0.14), new BABYLON.Vector3(width * 0.12, height * 0.88 + 1, 0), state.materials.steel, root, true, true);
      box('cig-motor-' + index, new BABYLON.Vector3(width * 0.18, height * 0.42, depth * 0.48), new BABYLON.Vector3(-width * 0.12, height * 1.08 + 1, 0), state.materials.body, root, true, true);
      box('cig-plate-' + index, new BABYLON.Vector3(width * 0.07, height * 0.54, depth * 0.45), new BABYLON.Vector3(width * 0.40, height * 1.06 + 1, 0), state.materials.steel, root, true, true);
      cylinder('cig-drum-' + index, { height: depth * 0.28, diameter: depth * 0.24, tessellation: 24 }, new BABYLON.Vector3(width * 0.29, height * 0.48 + 1, 0), state.materials.steel, root, true, false).rotation.x = Math.PI / 2;
      createIndustrialMachineDetails(root, index, width, depth, height);
    } else {
      box('work-base-' + index, new BABYLON.Vector3(width * 0.7, height * 0.28, depth * 0.42), new BABYLON.Vector3(0, height * 0.18 + 1, 0), state.materials.body, root, true, true);
      box('work-post-' + index, new BABYLON.Vector3(width * 0.12, height * 0.72, depth * 0.14), new BABYLON.Vector3(-width * 0.22, height * 0.48 + 1, 0), state.materials.steel, root, true, true);
    }

    createPlatformTrolley(root, index, width, depth, toNumber(item.z, 0));

    state.layoutEntries.push({
      kind: 'workstation',
      name: cleanName(item.name, '工位 ' + pad(index + 1)),
      meta: Math.round(width) + ' × ' + Math.round(depth),
      focus: new BABYLON.Vector3(toNumber(item.x, 0), 12, toNumber(item.z, 0))
    });
  }

  function createPlatformTrolley(parent, workstationIndex, workstationWidth, workstationDepth, workstationZ) {
    var buildId = state.sceneBuildId;
    var trolleyNumber = workstationIndex + 1;
    var trolleyId = pad(trolleyNumber);
    var rootName = workstationIndex === 0 ? 'platform-trolley-root' : 'platform-trolley-root-' + trolleyId;
    var parentRotation = parent.rotation.y;
    var halfWorldZ = Math.abs(Math.sin(parentRotation)) * workstationWidth / 2 +
      Math.abs(Math.cos(parentRotation)) * workstationDepth / 2;
    var centerDeltaZ = (workstationZ <= 0 ? 1 : -1) * (halfWorldZ + 18);
    var trolleyRoot = new BABYLON.TransformNode(rootName, scene);
    trolleyRoot.position = new BABYLON.Vector3(
      -centerDeltaZ * Math.sin(parentRotation),
      2.25,
      centerDeltaZ * Math.cos(parentRotation)
    );
    trolleyRoot.rotation.y = -parentRotation;
    trolleyRoot.parent = parent;
    trolleyRoot.metadata = {
      visualDetail: true,
      detailKind: 'platformTrolley',
      workstationIndex: trolleyNumber,
      towardFactoryCenter: true,
      assetLicense: 'CC0-1.0',
      assetSource: 'https://3dmodelscc0.itch.io/free-cc0-industrial-3d-models'
    };
    trolleyRoot.setEnabled(false);

    if (!BABYLON.SceneLoader || typeof BABYLON.SceneLoader.LoadAssetContainerAsync !== 'function') {
      trolleyRoot.dispose();
      console.warn('Platform trolley loader is unavailable.');
      return;
    }

    BABYLON.SceneLoader.LoadAssetContainerAsync(
      './assets/models/',
      'platform-trolley.glb',
      scene
    ).then(function (container) {
      if (buildId !== state.sceneBuildId || trolleyRoot.isDisposed()) {
        container.dispose();
        return;
      }

      var modelRoot = new BABYLON.TransformNode('platform-trolley-model-root-' + trolleyId, scene);
      modelRoot.scaling = new BABYLON.Vector3(10, 10, 10);
      modelRoot.parent = trolleyRoot;

      var nodes = container.meshes.concat(container.transformNodes || []);
      var topLevelNodes = nodes.filter(function (node) {
        return !node.parent || nodes.indexOf(node.parent) === -1;
      });
      var originalMaterials = (container.materials || []).slice();

      container.addAllToScene();
      topLevelNodes.forEach(function (node) {
        node.parent = modelRoot;
      });

      var visibleMeshCount = 0;
      container.meshes.forEach(function (mesh) {
        mesh.isPickable = false;
        mesh.checkCollisions = false;
        if (mesh.getTotalVertices && mesh.getTotalVertices() > 0) {
          visibleMeshCount += 1;
          var meshBaseName = workstationIndex === 0
            ? 'platform-trolley-mesh'
            : 'platform-trolley-mesh-' + trolleyId;
          mesh.name = meshBaseName + (visibleMeshCount > 1 ? '-part-' + visibleMeshCount : '');
          mesh.material = state.materials.trolleyYellow;
          addShadow(mesh, true, true);
        } else {
          mesh.name = 'platform-trolley-import-root-' + trolleyId;
        }
      });
      (container.transformNodes || []).forEach(function (node, index) {
        node.name = 'platform-trolley-transform-' + trolleyId + '-' + (index + 1);
      });
      originalMaterials.forEach(function (material) {
        if (material && material.dispose) material.dispose(true, true);
      });

      createPlatformTrolleyWheels(trolleyRoot, workstationIndex);
      trolleyRoot.setEnabled(true);
    }).catch(function (error) {
      if (!trolleyRoot.isDisposed()) trolleyRoot.dispose(false, true);
      console.warn('Platform trolley asset could not be loaded.', error);
    });
  }

  function createPlatformTrolleyWheels(parent, workstationIndex) {
    var trolleyId = pad(workstationIndex + 1);
    [-5.8, 5.8].forEach(function (x, xIndex) {
      [-3.45, 3.45].forEach(function (z, zIndex) {
        var wheelNumber = xIndex * 2 + zIndex + 1;
        var wheelName = workstationIndex === 0
          ? 'platform-trolley-wheel-' + wheelNumber
          : 'platform-trolley-wheel-' + trolleyId + '-' + wheelNumber;
        var wheel = cylinder(
          wheelName,
          { height: 1.25, diameter: 2.15, tessellation: 20 },
          new BABYLON.Vector3(x, -0.08, z),
          state.materials.trolleyWheel,
          parent,
          true,
          true
        );
        wheel.rotation.x = Math.PI / 2;
        wheel.isPickable = false;
        wheel.checkCollisions = false;
      });
    });
  }

  function createWorkstationAreaOutline(parent, index, width, depth) {
    var clearance = 6;
    var outerWidth = width + clearance * 2;
    var outerDepth = depth + clearance * 2;
    var lineWidth = clamp(Math.min(width, depth) * 0.036, 1.8, 2.8);
    var lineHeight = 0.24;
    var y = 0.18;
    var specs = [
      {
        size: new BABYLON.Vector3(outerWidth, lineHeight, lineWidth),
        position: new BABYLON.Vector3(0, y, -outerDepth / 2)
      },
      {
        size: new BABYLON.Vector3(outerWidth, lineHeight, lineWidth),
        position: new BABYLON.Vector3(0, y, outerDepth / 2)
      },
      {
        size: new BABYLON.Vector3(lineWidth, lineHeight, outerDepth - lineWidth * 2),
        position: new BABYLON.Vector3(-outerWidth / 2, y, 0)
      },
      {
        size: new BABYLON.Vector3(lineWidth, lineHeight, outerDepth - lineWidth * 2),
        position: new BABYLON.Vector3(outerWidth / 2, y, 0)
      }
    ];
    mergeIndustrialBoxes(
      'workstation-area-outline-' + pad(index + 1),
      specs,
      state.materials.equipmentAreaLine,
      parent,
      {
        detailKind: 'workstationAreaOutline',
        workstationIndex: index + 1,
        closed: true,
        areaWidth: outerWidth,
        areaDepth: outerDepth
      },
      false
    );
  }

  function createIndustrialMachineDetails(parent, index, width, depth, height) {
    var panelSpecs = [];
    [-0.24, 0, 0.24].forEach(function (ratio) {
      panelSpecs.push({
        size: new BABYLON.Vector3(width * 0.19, height * 0.54, depth * 0.34),
        position: new BABYLON.Vector3(width * ratio, height * 0.42 + 1.2, 0)
      });
      panelSpecs.push({
        size: new BABYLON.Vector3(width * 0.17, 0.75, depth * 0.37),
        position: new BABYLON.Vector3(width * ratio, height * 0.72 + 1.45, 0)
      });
    });
    [-0.39, 0.39].forEach(function (ratioX) {
      [-0.14, 0.14].forEach(function (ratioZ) {
        panelSpecs.push({
          size: new BABYLON.Vector3(2.4, height * 0.55, 2.4),
          position: new BABYLON.Vector3(width * ratioX, height * 0.30 + 1, depth * ratioZ)
        });
      });
    });
    panelSpecs.push({
      size: new BABYLON.Vector3(width * 0.82, 1.1, depth * 0.08),
      position: new BABYLON.Vector3(0, height * 0.80 + 1.5, -depth * 0.18)
    });
    mergeIndustrialBoxes(
      'industrial-machine-panel-' + pad(index + 1),
      panelSpecs,
      state.materials.industrialMachinePanel,
      parent,
      { detailKind: 'machinePanel', workstationIndex: index + 1 },
      false
    );

    var darkSpecs = [
      {
        size: new BABYLON.Vector3(width * 0.72, 0.78, depth * 0.12),
        position: new BABYLON.Vector3(0, height * 0.34 + 1.2, depth * 0.22)
      },
      {
        size: new BABYLON.Vector3(width * 0.76, 0.5, depth * 0.04),
        position: new BABYLON.Vector3(0, height * 0.62 + 1.3, -depth * 0.205)
      }
    ];
    for (var vent = -2; vent <= 2; vent++) {
      darkSpecs.push({
        size: new BABYLON.Vector3(width * 0.045, height * 0.18, 0.7),
        position: new BABYLON.Vector3(width * vent * 0.075, height * 0.42 + 1.15, -depth * 0.205)
      });
    }
    mergeIndustrialBoxes(
      'industrial-machine-dark-' + pad(index + 1),
      darkSpecs,
      state.materials.industrialCable,
      parent,
      { detailKind: 'machineVent', workstationIndex: index + 1 },
      false
    );

    var glassSpecs = [];
    [-0.24, 0, 0.24].forEach(function (ratio) {
      glassSpecs.push({
        size: new BABYLON.Vector3(width * 0.14, height * 0.23, 0.72),
        position: new BABYLON.Vector3(width * ratio, height * 0.54 + 1.35, -depth * 0.207)
      });
    });
    mergeIndustrialBoxes(
      'industrial-machine-glass-' + pad(index + 1),
      glassSpecs,
      state.materials.industrialMachineGlass,
      parent,
      { detailKind: 'machineWindow', workstationIndex: index + 1 },
      false
    );

    var safetySpecs = [
      {
        size: new BABYLON.Vector3(width * 0.84, 0.65, 1.0),
        position: new BABYLON.Vector3(0, height * 0.83 + 1.7, -depth * 0.23)
      },
      {
        size: new BABYLON.Vector3(1.0, height * 0.55, 1.0),
        position: new BABYLON.Vector3(-width * 0.42, height * 0.55 + 1.1, -depth * 0.23)
      },
      {
        size: new BABYLON.Vector3(1.0, height * 0.55, 1.0),
        position: new BABYLON.Vector3(width * 0.42, height * 0.55 + 1.1, -depth * 0.23)
      }
    ];
    mergeIndustrialBoxes(
      'industrial-machine-safety-' + pad(index + 1),
      safetySpecs,
      state.materials.industrialSafety,
      parent,
      { detailKind: 'machineSafety', workstationIndex: index + 1 },
      false
    );

    var consoleX = width * 0.39;
    var consoleZ = -depth * 0.30;
    mergeIndustrialBoxes(
      'industrial-machine-console-' + pad(index + 1),
      [
        {
          size: new BABYLON.Vector3(width * 0.11, height * 0.48, depth * 0.12),
          position: new BABYLON.Vector3(consoleX, height * 0.34 + 1.1, consoleZ)
        },
        {
          size: new BABYLON.Vector3(width * 0.15, height * 0.24, depth * 0.13),
          position: new BABYLON.Vector3(consoleX, height * 0.68 + 1.2, consoleZ)
        }
      ],
      state.materials.industrialMachinePanel,
      parent,
      { detailKind: 'machineConsole', workstationIndex: index + 1 },
      false
    );
    mergeIndustrialBoxes(
      'industrial-machine-screen-' + pad(index + 1),
      [{
        size: new BABYLON.Vector3(width * 0.105, height * 0.13, 0.55),
        position: new BABYLON.Vector3(consoleX, height * 0.70 + 1.25, consoleZ - depth * 0.07)
      }],
      state.materials.industrialMachineScreen,
      parent,
      { detailKind: 'machineScreen', workstationIndex: index + 1 },
      false
    );

    mergeIndustrialCylinders(
      'industrial-machine-exhaust-' + pad(index + 1),
      [
        {
          length: 6.8,
          diameter: 5.4,
          axis: 'y',
          position: new BABYLON.Vector3(-width * 0.18, height + 4.2, depth * 0.05)
        },
        {
          length: 13.0,
          diameter: 4.2,
          axis: 'x',
          position: new BABYLON.Vector3(-width * 0.12, height + 7.4, depth * 0.05)
        }
      ],
      state.materials.industrialDuct,
      parent,
      { detailKind: 'machineExhaust', workstationIndex: index + 1 },
      false
    );
  }

  function createRack(item, index, parent) {
    var root = createRotatedRoot('rack-' + index, item, parent);
    var width = Math.max(24, toNumber(item.width, 80));
    var depth = Math.max(16, toNumber(item.depth, 32));
    var height = Math.max(8, toNumber(item.height, 16));
    box('rack-zone-' + index, new BABYLON.Vector3(width, 0.8, depth), new BABYLON.Vector3(0, 0.7, 0), state.materials.zone, root, false, true);
    var legW = Math.max(1.2, depth * 0.08);
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (pair) {
      box('rack-leg-' + index + pair.join('-'), new BABYLON.Vector3(legW, height, legW), new BABYLON.Vector3(pair[0] * (width / 2 - legW), height / 2 + 1, pair[1] * (depth / 2 - legW)), state.materials.steel, root, true, true);
    });
    for (var i = 1; i <= 3; i++) {
      box('rack-shelf-' + index + '-' + i, new BABYLON.Vector3(width * 0.9, 0.42, depth * 0.82), new BABYLON.Vector3(0, 1 + i * height / 4, 0), state.materials.body, root, true, true);
    }
  }

  function createPath(item, index, parent) {
    var root = createRotatedRoot('path-' + index, item, parent);
    box('path-fill-' + index, new BABYLON.Vector3(Math.max(8, toNumber(item.width, 80)), 0.9, Math.max(8, toNumber(item.depth, 24))), new BABYLON.Vector3(0, 0.8, 0), state.materials.path, root, false, true);
  }

  function createZone(item, index, parent) {
    var root = createRotatedRoot('zone-' + index, item, parent);
    box('zone-fill-' + index, new BABYLON.Vector3(Math.max(8, toNumber(item.width, 80)), 0.75, Math.max(8, toNumber(item.depth, 42))), new BABYLON.Vector3(0, 0.7, 0), state.materials.zone, root, false, true);
  }

  function createLights(root) {
    var lights = state.config.lights;
    var b = state.config.layout.building;
    var grid = state.config.layout.lightingGrid;
    var gridEnabled = !!(grid && grid.enabled);

    var mainLights = lights.filter(function(light) {
      return getLightGridArea(light) !== 'extension';
    });
    if (gridEnabled) {
      createUnboundGridPanels(mainLights, grid, b, root, { gridArea: 'main' });
      createGridColumnLabels(grid, b, root);
    }

    lights.forEach(function (light, index) {
      // Extension entries are created inside their physical room by
      // createExtensionRoomLights().  Do not duplicate them in the workshop.
      if (getLightGridArea(light) === 'extension') return;
      var entry = gridEnabled && isGridLightSegment(light, grid)
        ? createGridLightSegment(light, index, grid, b, root)
        : createLightNode(light, index, b, root);
      state.lightEntries[index] = entry;
    });
    createDynamicLightPool(root);
    lights.forEach(function (_, index) { updateLightVisual(index); });
    updateDynamicLightAssignments();
    updateSceneLighting();
  }

  function createDynamicLightPool(root) {
    state.dynamicLightPool = [];
    for (var index = 0; index < MAX_DYNAMIC_LIGHTS; index++) {
      var point = new BABYLON.PointLight('active-lamp-point-' + index, BABYLON.Vector3.Zero(), scene);
      point.parent = root;
      point.diffuse = color3(palette[state.activeStyle].glow);
      point.specular = color3(palette[state.activeStyle].glow);
      point.range = 190;
      point.intensity = 0;
      state.dynamicLightPool.push(point);
    }
  }

  function getEntryLightWorldPosition(entry) {
    if (!entry || !entry.root || !entry.pointPosition) return BABYLON.Vector3.Zero();
    entry.root.computeWorldMatrix(true);
    return BABYLON.Vector3.TransformCoordinates(entry.pointPosition, entry.root.getWorldMatrix());
  }

  function selectDynamicLightEntries(activeEntries, limit) {
    if (activeEntries.length <= limit) return activeEntries.slice();
    var selected = [];
    var selectedEntry = state.selectedLight == null ? null : state.lightEntries[state.selectedLight];
    if (selectedEntry && activeEntries.indexOf(selectedEntry) >= 0) selected.push(selectedEntry);
    if (!selected.length) selected.push(activeEntries[Math.floor((activeEntries.length - 1) / 2)]);

    var positions = new Map();
    activeEntries.forEach(function (entry) { positions.set(entry, getEntryLightWorldPosition(entry)); });
    while (selected.length < limit) {
      var best = null;
      var bestDistance = -1;
      activeEntries.forEach(function (candidate) {
        if (selected.indexOf(candidate) >= 0) return;
        var position = positions.get(candidate);
        var nearest = Infinity;
        selected.forEach(function (chosen) {
          nearest = Math.min(nearest, BABYLON.Vector3.DistanceSquared(position, positions.get(chosen)));
        });
        if (nearest > bestDistance) {
          bestDistance = nearest;
          best = candidate;
        }
      });
      if (!best) break;
      selected.push(best);
    }
    return selected;
  }

  var dynamicLightAssignmentFrame = 0;

  function scheduleDynamicLightAssignments() {
    if (dynamicLightAssignmentFrame) return;
    dynamicLightAssignmentFrame = requestAnimationFrame(function () {
      dynamicLightAssignmentFrame = 0;
      updateDynamicLightAssignments();
    });
  }

  function updateDynamicLightAssignments() {
    var pool = state.dynamicLightPool || [];
    if (!pool.length) return;
    var activeEntries = state.lightEntries.filter(function (entry) {
      return entry && entry.visualTarget > 0.01 && entry.pointPosition;
    });
    var assigned = selectDynamicLightEntries(activeEntries, pool.length);

    state.lightEntries.forEach(function (entry) {
      if (entry) entry.point = null;
    });
    pool.forEach(function (point, index) {
      var entry = assigned[index];
      point.intensity = 0;
      if (!entry) {
        point.parent = state.sceneRoot;
        point.position.copyFromFloats(0, 0, 0);
        return;
      }
      point.parent = entry.root;
      point.position.copyFrom(entry.pointPosition);
      point.range = entry.pointRange || 190;
      entry.point = point;
    });
  }

  function isGridLightSegment(light, grid, expectedArea) {
    if (!light || light.type !== 'lamp' || !grid || !grid.enabled) return false;
    if (expectedArea && getLightGridArea(light) !== expectedArea) return false;
    var column = Math.floor(toNumber(light.grid_column, 0));
    var start = Math.floor(toNumber(light.grid_start, 0));
    var count = Math.floor(toNumber(light.grid_count, 0));
    return column >= 1 && column <= grid.columns &&
      start >= 1 && start <= grid.lightsPerColumn &&
      count >= 1 && start + count - 1 <= grid.lightsPerColumn;
  }

  function getGridMetrics(grid, building) {
    var columns = Math.max(1, grid.columns);
    var lightsPerColumn = Math.max(1, grid.lightsPerColumn);
    var orientation = grid.orientation === 'x' ? 'x' : 'z';
    var columnSpan = orientation === 'x' ? building.depth : building.width;
    var lightSpan = orientation === 'x' ? building.width : building.depth;
    var columnEdge = clamp(columnSpan * 0.06, 22, 78);
    var lightEdge = clamp(lightSpan * 0.045, 22, 48);
    var usableColumnSpan = Math.max(1, columnSpan - columnEdge * 2);
    var usableLightSpan = Math.max(1, lightSpan - lightEdge * 2);
    var columnPitch = columns > 1 ? usableColumnSpan / (columns - 1) : 0;
    var lightPitch = lightsPerColumn > 1 ? usableLightSpan / (lightsPerColumn - 1) : 0;
    var panelWidth = columns > 1
      ? clamp(columnPitch * 0.24, 12, 24)
      : clamp(columnSpan * 0.04, 14, 28);
    var panelDepth = lightsPerColumn > 1
      ? clamp(lightPitch * 0.94, 3.4, 14)
      : 10;
    return {
      columns: columns,
      lightsPerColumn: lightsPerColumn,
      orientation: orientation,
      column0: columns > 1 ? -usableColumnSpan / 2 : 0,
      light0: lightsPerColumn > 1 ? -usableLightSpan / 2 : 0,
      columnPitch: columnPitch,
      lightPitch: lightPitch,
      panelWidth: panelWidth,
      panelDepth: panelDepth,
      panelHeight: clamp(panelDepth * 0.085, 0.48, 0.92),
      // The reference factory uses a level suspended ceiling. Keep the whole
      // array just below the eaves so the outer columns never pierce the
      // building's pitched shell.
      y: Math.max(10, building.wallH - 1.5)
    };
  }

  function getGridPanelPosition(metrics, column, lightNumber) {
    var columnPosition = metrics.column0 + (column - 1) * metrics.columnPitch;
    var lightPosition = metrics.light0 + (lightNumber - 1) * metrics.lightPitch;
    return {
      x: metrics.orientation === 'x' ? lightPosition : columnPosition,
      z: metrics.orientation === 'x' ? columnPosition : lightPosition
    };
  }

  function getGridPanelBoxSize(metrics, acrossScale, height, alongScale) {
    return metrics.orientation === 'x'
      ? new BABYLON.Vector3(metrics.panelDepth * alongScale, height, metrics.panelWidth * acrossScale)
      : new BABYLON.Vector3(metrics.panelWidth * acrossScale, height, metrics.panelDepth * alongScale);
  }

  function createGridColumnLabels(grid, building, parent) {
    var metrics = getGridMetrics(grid, building);
    var root = new BABYLON.TransformNode('lighting-grid-column-labels', scene);
    root.parent = parent;
    root.metadata = { gridColumnLabels: true, order: '12-to-1' };
    for (var column = 1; column <= grid.columns; column++) {
      var anchor = getGridPanelPosition(metrics, column, 1);
      var texture = new BABYLON.DynamicTexture(
        'lighting-grid-column-label-texture-' + column,
        { width: 256, height: 80 },
        scene,
        false
      );
      texture.hasAlpha = true;
      var context = texture.getContext();
      context.clearRect(0, 0, 256, 80);
      context.fillStyle = 'rgba(16,24,28,0.88)';
      roundRect(context, 5, 5, 246, 70, 12);
      context.fill();
      context.lineWidth = 4;
      context.strokeStyle = state.activeStyle === 'tech' ? '#35e6a8' : '#65b9b0';
      context.stroke();
      context.fillStyle = '#f5fbff';
      context.font = '700 38px Microsoft YaHei, sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(column + '\u5217', 128, 42);
      texture.update();

      var material = new BABYLON.StandardMaterial('lighting-grid-column-label-material-' + column, scene);
      material.diffuseTexture = texture;
      material.emissiveTexture = texture;
      material.opacityTexture = texture;
      material.disableLighting = true;
      material.backFaceCulling = false;
      var label = BABYLON.MeshBuilder.CreatePlane(
        'lighting-grid-column-label-' + column,
        { width: 36, height: 11.25 },
        scene
      );
      // Place labels at the main-factory end opposite the extension room so they
      // stay readable and never overlap the packing-machine ceiling lights.
      label.position = new BABYLON.Vector3(building.halfW - 20, metrics.y - 8, anchor.z);
      label.material = material;
      label.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
      label.isPickable = false;
      label.checkCollisions = false;
      label.metadata = {
        gridColumnLabel: true,
        gridArea: 'main',
        column: column,
        worldZ: anchor.z
      };
      label.parent = root;
    }
  }

  function readGridField(source, names) {
    if (!source) return null;
    for (var i = 0; i < names.length; i++) {
      var value = source[names[i]];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return null;
  }

  function normalizeGridCell(cell, grid) {
    if (!cell || !grid) return null;
    var column = Number(readGridField(cell, ['column', 'grid_column']));
    var number = Number(readGridField(cell, ['number', 'grid_number', 'lightNumber', 'light_number']));
    if (!Number.isInteger(column) || !Number.isInteger(number)) return null;
    if (column < 1 || column > grid.columns || number < 1 || number > grid.lightsPerColumn) return null;
    return { column: column, number: number };
  }

  function normalizeGridSelectionRange(range, grid) {
    if (!range || !grid) return null;
    var column = Number(readGridField(range, ['column', 'grid_column']));
    var start = Number(readGridField(range, ['start', 'grid_start', 'from', 'number']));
    var endValue = readGridField(range, ['end', 'grid_end', 'to']);
    var countValue = readGridField(range, ['count', 'grid_count']);
    var end = endValue == null ? NaN : Number(endValue);
    var count = countValue == null ? NaN : Number(countValue);
    if (!Number.isInteger(end) && Number.isInteger(start) && Number.isInteger(count)) end = start + count - 1;
    if (!Number.isInteger(end) && Number.isInteger(start)) end = start;
    if (!Number.isInteger(column) || column < 1 || column > grid.columns || !Number.isInteger(start) || !Number.isInteger(end)) return null;
    if (start > end) {
      var swap = start;
      start = end;
      end = swap;
    }
    start = clamp(start, 1, grid.lightsPerColumn);
    end = clamp(end, 1, grid.lightsPerColumn);
    return { column: column, start: start, end: end };
  }

  function findLightingGridPickSurface(mesh) {
    var node = mesh;
    while (node) {
      if (node.metadata && node.metadata.lightingGridPickSurface) return node;
      node = node.parent;
    }
    return null;
  }

  function getLightingGridCellFromPick(pick) {
    var layout = state.config.layout || {};
    if (!pick || !pick.hit || !pick.pickedPoint || !pick.pickedMesh) return null;
    var pickSurface = findLightingGridPickSurface(pick.pickedMesh);
    if (!pickSurface) return null;
    var gridArea = pickSurface.metadata && pickSurface.metadata.gridArea === 'extension'
      ? 'extension'
      : 'main';
    var grid = gridArea === 'extension' ? state.extensionGrid : layout.lightingGrid;
    if (!grid || !grid.enabled) return null;

    var point = pick.pickedPoint;
    if (state.sceneRoot && state.sceneRoot.getWorldMatrix) {
      var world = state.sceneRoot.getWorldMatrix();
      if (world && world.clone) {
        var inverse = world.clone();
        inverse.invert();
        point = BABYLON.Vector3.TransformCoordinates(point, inverse);
      }
    }

    var metrics = gridArea === 'extension'
      ? state.extensionGridMetrics
      : getGridMetrics(grid, layout.building || DEFAULT_BUILDING);
    if (!metrics) return null;
    if (gridArea === 'extension') {
      var nearestColumn = 1;
      var nearestDistance = Infinity;
      (metrics.extensionColumnPositions || []).forEach(function(value, index) {
        var distance = Math.abs(point.z - value);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestColumn = index + 1;
        }
      });
      var extensionNumber = Math.abs(metrics.lightPitch) < 0.0001
        ? 1
        : Math.round((metrics.extensionFirstX - point.x) / metrics.lightPitch) + 1;
      var extensionCell = normalizeGridCell({
        column: nearestColumn,
        number: clamp(extensionNumber, 1, metrics.lightsPerColumn)
      }, grid);
      if (extensionCell) {
        extensionCell.grid_area = 'extension';
        extensionCell.area = 'extension';
      }
      return extensionCell;
    }
    var columnCoordinate = metrics.orientation === 'x' ? point.z : point.x;
    var numberCoordinate = metrics.orientation === 'x' ? point.x : point.z;
    var column = metrics.columns <= 1 || Math.abs(metrics.columnPitch) < 0.0001
      ? 1
      : Math.round((columnCoordinate - metrics.column0) / metrics.columnPitch) + 1;
    var number = metrics.lightsPerColumn <= 1 || Math.abs(metrics.lightPitch) < 0.0001
      ? 1
      : Math.round((numberCoordinate - metrics.light0) / metrics.lightPitch) + 1;

    var mainCell = normalizeGridCell({
      column: clamp(column, 1, metrics.columns),
      number: clamp(number, 1, metrics.lightsPerColumn)
    }, grid);
    if (mainCell) {
      mainCell.grid_area = 'main';
      mainCell.area = 'main';
    }
    return mainCell;
  }

  function disposeGridSelectionOverlay() {
    var overlay = state.gridSelectionOverlay;
    state.gridSelectionOverlay = null;
    if (!overlay || !overlay.root) return;
    var alreadyDisposed = typeof overlay.root.isDisposed === 'function' && overlay.root.isDisposed();
    if (!alreadyDisposed && overlay.root.dispose) overlay.root.dispose(false, true);
  }

  function makeGridSelectionMaterial(name, color, alpha) {
    var material = standard(name, { color: color, emissive: color, alpha: alpha });
    material.disableLighting = true;
    material.backFaceCulling = false;
    material.disableDepthWrite = true;
    material.alphaMode = BABYLON.Engine.ALPHA_ADD;
    return material;
  }

  function renderGridSelectionOverlay() {
    disposeGridSelectionOverlay();
    var layout = state.config.layout || {};
    if (!state.sceneRoot) return;

    var ranges = Array.isArray(state.gridSelectionRanges) ? state.gridSelectionRanges : [];
    var rawActiveCell = state.gridSelectionActiveCell;
    var areaConfigs = [];
    var mainGrid = layout.lightingGrid;
    if (mainGrid && mainGrid.enabled) {
      areaConfigs.push({
        area: 'main',
        grid: mainGrid,
        metrics: getGridMetrics(mainGrid, layout.building || DEFAULT_BUILDING),
        getPosition: getGridPanelPosition
      });
    }
    if (state.extensionGrid && state.extensionGrid.enabled && state.extensionGridMetrics) {
      areaConfigs.push({
        area: 'extension',
        grid: state.extensionGrid,
        metrics: state.extensionGridMetrics,
        getPosition: getExtensionRoomPanelPosition
      });
    }

    var root = null;
    var overlay = null;
    function ensureOverlay() {
      if (overlay) return overlay;
      root = new BABYLON.TransformNode('lighting-grid-selection-overlay-root', scene);
      root.parent = state.sceneRoot;
      overlay = { root: root, selectedMeshes: [], activeMeshes: [] };
      state.gridSelectionOverlay = overlay;
      return overlay;
    }

    areaConfigs.forEach(function (areaConfig) {
      var grid = areaConfig.grid;
      var metrics = areaConfig.metrics;
      var selected = Object.create(null);
      var selectedOffsets = [];
      ranges.forEach(function (sourceRange) {
        var sourceArea = sourceRange && (sourceRange.area === 'extension' || sourceRange.grid_area === 'extension')
          ? 'extension'
          : 'main';
        if (sourceArea !== areaConfig.area) return;
        var range = normalizeGridSelectionRange(sourceRange, grid);
        if (!range) return;
        for (var number = range.start; number <= range.end; number++) {
          var key = range.column + '#' + number;
          if (selected[key]) continue;
          selected[key] = true;
          var point = areaConfig.getPosition(metrics, range.column, number);
          selectedOffsets.push(new BABYLON.Vector3(
            point.x,
            metrics.y + metrics.panelHeight * 0.62,
            point.z
          ));
        }
      });

      var activeArea = rawActiveCell && (rawActiveCell.area === 'extension' || rawActiveCell.grid_area === 'extension')
        ? 'extension'
        : 'main';
      var activeCell = activeArea === areaConfig.area ? normalizeGridCell(rawActiveCell, grid) : null;
      if (!selectedOffsets.length && !activeCell) return;
      ensureOverlay();

      if (selectedOffsets.length) {
        var selectedMaterial = makeGridSelectionMaterial(
          'lighting-grid-selection-overlay-material-' + areaConfig.area,
          state.activeStyle === 'tech' ? '#35e6a8' : '#35c8ff',
          0.42
        );
        var selectedMesh = repeatedBox(
          'lighting-grid-selection-overlay-' + areaConfig.area,
          getGridPanelBoxSize(metrics, 0.96, Math.max(0.12, metrics.panelHeight * 0.12), 0.96),
          selectedOffsets,
          BABYLON.Vector3.Zero(),
          selectedMaterial,
          root,
          false,
          false
        );
        selectedMesh.isPickable = false;
        selectedMesh.checkCollisions = false;
        selectedMesh.metadata = { gridSelectionOverlay: true, gridArea: areaConfig.area };
        overlay.selectedMeshes.push(selectedMesh);
        if (!overlay.selectedMesh) overlay.selectedMesh = selectedMesh;
      }

      if (activeCell) {
        var activePoint = areaConfig.getPosition(metrics, activeCell.column, activeCell.number);
        var activeMaterial = makeGridSelectionMaterial(
          'lighting-grid-active-cell-overlay-material-' + areaConfig.area,
          '#ffd36a',
          0.78
        );
        var activeMesh = repeatedBox(
          'lighting-grid-active-cell-overlay-' + areaConfig.area,
          getGridPanelBoxSize(metrics, 1.08, Math.max(0.16, metrics.panelHeight * 0.16), 1.08),
          [new BABYLON.Vector3(
            activePoint.x,
            metrics.y + metrics.panelHeight * 0.82,
            activePoint.z
          )],
          BABYLON.Vector3.Zero(),
          activeMaterial,
          root,
          false,
          false
        );
        activeMesh.isPickable = false;
        activeMesh.checkCollisions = false;
        activeMesh.metadata = { gridSelectionOverlay: true, gridArea: areaConfig.area, activeCell: activeCell };
        overlay.activeMeshes.push(activeMesh);
        if (!overlay.activeMesh) overlay.activeMesh = activeMesh;
      }
    });
  }

  function setGridSelectionOverlay(ranges, activeCell) {
    var sources = Array.isArray(ranges) ? ranges : (ranges ? [ranges] : []);
    state.gridSelectionRanges = sources.map(function (range) {
      return range && typeof range === 'object' ? Object.assign({}, range) : range;
    });
    state.gridSelectionActiveCell = activeCell && typeof activeCell === 'object'
      ? Object.assign({}, activeCell)
      : null;
    renderGridSelectionOverlay();
  }

  function clearGridSelectionOverlay() {
    state.gridSelectionRanges = [];
    state.gridSelectionActiveCell = null;
    disposeGridSelectionOverlay();
  }

  function getGridOccupancy(lights, grid, gridArea) {
    var occupied = [];
    for (var column = 0; column < grid.columns; column++) {
      occupied[column] = new Array(grid.lightsPerColumn).fill(false);
    }
    lights.forEach(function (light) {
      if (gridArea && getLightGridArea(light) !== gridArea) return;
      if (!isGridLightSegment(light, grid, gridArea)) return;
      var columnIndex = light.grid_column - 1;
      var startIndex = light.grid_start - 1;
      for (var n = 0; n < light.grid_count; n++) {
        if (startIndex + n < grid.lightsPerColumn) occupied[columnIndex][startIndex + n] = true;
      }
    });
    return occupied;
  }

  function createUnboundGridPanels(lights, grid, building, parent, options) {
    options = options || {};
    var gridArea = options.gridArea || 'main';
    var occupancy = getGridOccupancy(lights, grid, gridArea);
    var metrics = options.metrics || getGridMetrics(grid, building);
    var getPanelPosition = options.getPanelPosition || getGridPanelPosition;
    var namePrefix = options.namePrefix || 'lighting-grid-unbound';
    var bodyOffsets = [];
    var faceOffsets = [];
    for (var column = 1; column <= grid.columns; column++) {
      for (var number = 1; number <= grid.lightsPerColumn; number++) {
        if (occupancy[column - 1][number - 1]) continue;
        var point = getPanelPosition(metrics, column, number);
        bodyOffsets.push(new BABYLON.Vector3(point.x, metrics.y, point.z));
        faceOffsets.push(new BABYLON.Vector3(point.x, metrics.y - metrics.panelHeight * 0.55, point.z));
      }
    }
    if (!bodyOffsets.length) return;

    var root = new BABYLON.TransformNode(namePrefix + '-unbound-root', scene);
    root.parent = parent;
    var offFace = standard(namePrefix + '-unbound-face-material', {
      color: state.activeStyle === 'tech' ? '#222a30' : (state.activeStyle === 'industrial' ? '#9ba6ab' : '#c2c8ca'),
      emissive: state.activeStyle === 'industrial' ? '#000000' : '#07090b',
      alpha: 0.82
    });
    var body = repeatedBox(
      namePrefix + '-unbound-body',
      getGridPanelBoxSize(metrics, 1, metrics.panelHeight, 1),
      bodyOffsets,
      BABYLON.Vector3.Zero(),
      state.materials.lampBody,
      root,
      false,
      false
    );
    var face = repeatedBox(
      namePrefix + '-unbound-face',
      getGridPanelBoxSize(metrics, 0.88, metrics.panelHeight * 0.24, 0.88),
      faceOffsets,
      BABYLON.Vector3.Zero(),
      offFace,
      root,
      false,
      false
    );
    body.isPickable = true;
    face.isPickable = true;
    body.metadata = Object.assign({}, options.metadata || {}, {
      lightingGridPickSurface: true,
      unboundGridPanels: true,
      gridArea: gridArea,
      panelCount: bodyOffsets.length
    });
    face.metadata = Object.assign({}, body.metadata);
    body.checkCollisions = false;
    face.checkCollisions = false;
  }

  function createGridLightSegment(light, index, grid, building, parent, options) {
    options = options || {};
    var metrics = options.metrics || getGridMetrics(grid, building);
    var getPanelPosition = options.getPanelPosition || getGridPanelPosition;
    var gridArea = options.gridArea || getLightGridArea(light);
    var namePrefix = options.namePrefix || 'grid-light';
    var first = getPanelPosition(metrics, light.grid_column, light.grid_start);
    var last = getPanelPosition(metrics, light.grid_column, light.grid_start + light.grid_count - 1);
    var centerX = (first.x + last.x) / 2;
    var centerZ = (first.z + last.z) / 2;
    var root = new BABYLON.TransformNode(namePrefix + '-root-' + index, scene);
    root.position = new BABYLON.Vector3(centerX, 0, centerZ);
    root.parent = parent;
    root.metadata = Object.assign({}, options.metadata || {}, {
      lightIndex: index,
      gridSegment: true,
      gridArea: gridArea
    });

    var bodyOffsets = [];
    var faceOffsets = [];
    var coreOffsets = [];
    var haloOffsets = [];
    for (var n = 0; n < light.grid_count; n++) {
      var panelPoint = getPanelPosition(metrics, light.grid_column, light.grid_start + n);
      var localX = panelPoint.x - centerX;
      var localZ = panelPoint.z - centerZ;
      bodyOffsets.push(new BABYLON.Vector3(localX, metrics.y, localZ));
      faceOffsets.push(new BABYLON.Vector3(localX, metrics.y - metrics.panelHeight * 0.55, localZ));
      coreOffsets.push(new BABYLON.Vector3(localX, metrics.y - metrics.panelHeight * 0.73, localZ));
      haloOffsets.push(new BABYLON.Vector3(localX, metrics.y - metrics.panelHeight * 0.95, localZ));
    }

    var meshes = [];
    var bodyMat = standard('grid-light-body-material-' + index, {
      color: state.activeStyle === 'industrial' ? '#737d82' : '#4f5960',
      emissive: '#000000'
    });
    bodyMat.specularColor = color3('#b8c0c4');
    var bulbMat = standard('grid-light-diffuser-' + index, {
      color: palette[state.activeStyle].glow,
      emissive: palette[state.activeStyle].glow,
      alpha: 0.78
    });
    bulbMat.specularColor = color3('#d9ffff');
    var coreMat = standard('grid-light-core-' + index, {
      color: '#ffffff',
      emissive: '#ffffff',
      alpha: 0.02
    });
    coreMat.disableLighting = true;
    coreMat.disableDepthWrite = true;
    coreMat.alphaMode = BABYLON.Engine.ALPHA_ADD;
    var haloMat = standard('grid-light-halo-' + index, {
      color: palette[state.activeStyle].glow,
      emissive: palette[state.activeStyle].glow,
      alpha: 0.0
    });
    haloMat.disableLighting = true;
    haloMat.disableDepthWrite = true;
    haloMat.alphaMode = BABYLON.Engine.ALPHA_ADD;

    meshes.push(repeatedBox(
      namePrefix + '-body-' + index,
      getGridPanelBoxSize(metrics, 1, metrics.panelHeight, 1),
      bodyOffsets,
      BABYLON.Vector3.Zero(),
      bodyMat,
      root,
      false,
      false
    ));
    var bulb = repeatedBox(
      namePrefix + '-face-' + index,
      getGridPanelBoxSize(metrics, 0.88, metrics.panelHeight * 0.24, 0.88),
      faceOffsets,
      BABYLON.Vector3.Zero(),
      bulbMat,
      root,
      false,
      false
    );
    meshes.push(bulb);
    var core = repeatedBox(
      namePrefix + '-core-' + index,
      getGridPanelBoxSize(metrics, 0.72, Math.max(0.08, metrics.panelHeight * 0.08), 0.72),
      coreOffsets,
      BABYLON.Vector3.Zero(),
      coreMat,
      root,
      false,
      false
    );
    core.isPickable = false;
    var halo = repeatedBox(
      namePrefix + '-halo-' + index,
      getGridPanelBoxSize(metrics, 1.18, metrics.panelHeight * 0.16, 1.08),
      haloOffsets,
      BABYLON.Vector3.Zero(),
      haloMat,
      root,
      false,
      false
    );
    halo.isPickable = false;
    halo.isVisible = false;

    meshes.forEach(function (mesh) {
      mesh.metadata = Object.assign({}, options.metadata || {}, {
        lightIndex: index,
        gridSegment: true,
        lightingGridPickSurface: true,
        gridArea: gridArea
      });
      mesh.isPickable = true;
      mesh.checkCollisions = false;
    });

    var segmentLength = Math.max(metrics.panelDepth, (light.grid_count - 1) * metrics.lightPitch + metrics.panelDepth);
    var pool = createLightPool(
      index,
      metrics.panelWidth,
      metrics.panelDepth,
      Math.min(20, light.grid_count),
      root,
      metrics.orientation === 'x'
        ? { width: segmentLength * 1.12, height: metrics.panelWidth * 2.4 }
        : { width: metrics.panelWidth * 2.4, height: segmentLength * 1.12 }
    );
    return {
      light: light,
      root: root,
      meshes: meshes,
      bulb: bulb,
      core: core,
      indicator: null,
      halo: halo,
      pool: pool.mesh,
      label: null,
      labelY: metrics.y + 12,
      point: null,
      pointPosition: new BABYLON.Vector3(0, metrics.y - 8, 0),
      pointRange: 210,
      bodyMat: bodyMat,
      bulbMat: bulbMat,
      coreMat: coreMat,
      indicatorMat: null,
      haloMat: haloMat,
      poolMat: pool.material,
      poolTex: pool.texture,
      isGridSegment: true,
      gridArea: gridArea
    };
  }

  function createLightNode(light, index, b, parent) {
    var root = new BABYLON.TransformNode('light-root-' + index, scene);
    root.position = new BABYLON.Vector3(clamp(light.x, -b.halfW + 10, b.halfW - 10), 0, clamp(light.z, -b.halfD + 10, b.halfD - 10));
    root.parent = parent;
    root.metadata = { lightIndex: index };

    var size = clamp(light.scale * 4.5, 8, 24);
    var y = light.mount === 'floor' ? 16 : Math.max(b.wallH + 6, b.ridgeH - 8);
    var meshes = [];

    // Modern surface-mounted LED panel: a shallow rear housing, four metal
    // bezel rails and one large opal diffuser.  The proportions mirror a
    // common 1200 x 600 x 55 mm factory panel while still following the
    // per-light scale from the configuration.
    var panelW = size * 2.35;
    var panelH = Math.max(1.8, size * 0.15);
    var panelD = size * 1.16;
    var bodyMat = standard('lamp-body-material-' + index, {
      color: state.activeStyle === 'industrial' ? '#737d82' : '#4f5960',
      emissive: '#000000'
    });
    bodyMat.specularColor = color3('#b8c0c4');

    var supportHeight = Math.max(10, y - b.wallH);
    var supportOffset = Math.max(4.6, panelW * 0.31);
    if (light.mount === 'floor') {
      meshes.push(cylinder('lamp-floor-base-' + index, { height: 1.0, diameter: Math.max(10, panelD * 0.82), tessellation: 28 }, new BABYLON.Vector3(0, 0.5, 0), state.materials.lampEndCap, root, true, false));
      meshes.push(cylinder('lamp-floor-post-' + index, { height: Math.max(8, y - panelH), diameter: 1.7, tessellation: 12 }, new BABYLON.Vector3(0, Math.max(8, y - panelH) / 2 + 1, panelD * 0.42), state.materials.lampCable, root, true, false));
    } else {
      [-supportOffset, supportOffset].forEach(function (offset, cableIndex) {
        meshes.push(cylinder(
          'lamp-suspension-cable-' + index + '-' + cableIndex,
          { height: supportHeight, diameter: Math.max(0.42, panelH * 0.18), tessellation: 10 },
          new BABYLON.Vector3(offset, y + panelH * 0.48 + supportHeight / 2, 0),
          state.materials.lampCable,
          root,
          true,
          false
        ));
        meshes.push(box(
          'lamp-ceiling-anchor-' + index + '-' + cableIndex,
          new BABYLON.Vector3(Math.max(3.2, panelH * 1.35), Math.max(0.55, panelH * 0.22), panelD * 0.28),
          new BABYLON.Vector3(offset, y + panelH * 0.48 + supportHeight + panelH * 0.1, 0),
          state.materials.lampTrim,
          root,
          true,
          false
        ));
      });
    }

    meshes.push(box(
      'lamp-body-' + index,
      new BABYLON.Vector3(panelW, panelH * 0.62, panelD),
      new BABYLON.Vector3(0, y + panelH * 0.16, 0),
      bodyMat,
      root,
      true,
      true
    ));
    meshes.push(box(
      'lamp-driver-box-' + index,
      new BABYLON.Vector3(panelW * 0.38, panelH * 0.3, panelD * 0.34),
      new BABYLON.Vector3(0, y + panelH * 0.62, 0),
      state.materials.lampEndCap,
      root,
      true,
      false
    ));

    var bulbMat = standard('lamp-diffuser-' + index, { color: palette[state.activeStyle].glow, emissive: palette[state.activeStyle].glow, alpha: 0.78 });
    bulbMat.specularColor = color3('#d9ffff');
    var coreMat = standard('lamp-core-' + index, { color: palette[state.activeStyle].glow, emissive: palette[state.activeStyle].glow, alpha: 1 });
    coreMat.disableLighting = true;
    coreMat.disableDepthWrite = true;
    coreMat.alphaMode = BABYLON.Engine.ALPHA_ADD;
    var haloMat = standard('lamp-halo-' + index, { color: palette[state.activeStyle].glow, emissive: palette[state.activeStyle].glow, alpha: 0.18 });
    haloMat.disableLighting = true;
    haloMat.disableDepthWrite = true;
    haloMat.alphaMode = BABYLON.Engine.ALPHA_ADD;
    var indicatorMat = standard('lamp-indicator-' + index, { color: '#53ffae', emissive: '#53ffae', alpha: 0.95 });
    var pool = createLightPool(index, panelW, panelD, size, root);
    var bulb = BABYLON.MeshBuilder.CreateBox('lamp-bulb-mesh-' + index, {
      width: panelW * 0.9,
      height: Math.max(0.38, panelH * 0.18),
      depth: panelD * 0.78
    }, scene);
    bulb.position = new BABYLON.Vector3(0, y - panelH * 0.38, 0);
    bulb.material = bulbMat;
    bulb.parent = root;
    bulb.metadata = { skipLampHighlight: true };
    meshes.push(addShadow(bulb, false, false));

    var core = BABYLON.MeshBuilder.CreateBox('lamp-core-mesh-' + index, {
      width: panelW * 0.84,
      height: Math.max(0.16, panelH * 0.055),
      depth: panelD * 0.71
    }, scene);
    core.position = new BABYLON.Vector3(0, y - panelH * 0.5, 0);
    core.material = coreMat;
    core.parent = root;
    core.isPickable = false;

    createPanelLightFrame(root, index, panelW, panelH, panelD, bulb.position.y, meshes, bodyMat);

    var indicator = BABYLON.MeshBuilder.CreateSphere('lamp-indicator-mesh-' + index, {
      diameter: Math.max(0.72, panelH * 0.34),
      segments: 12
    }, scene);
    indicator.position = new BABYLON.Vector3(panelW * 0.43, y + panelH * 0.12, -panelD * 0.51);
    indicator.material = indicatorMat;
    indicator.parent = root;
    indicator.metadata = { skipLampHighlight: true };
    meshes.push(addShadow(indicator, false, false));

    var halo = BABYLON.MeshBuilder.CreateBox('lamp-halo-mesh-' + index, {
      width: panelW * 1.36,
      height: panelH * 0.72,
      depth: panelD * 1.42
    }, scene);
    halo.position = new BABYLON.Vector3(0, y - panelH * 0.6, 0);
    halo.material = haloMat;
    halo.parent = root;
    halo.isPickable = false;
    halo.checkCollisions = false;

    meshes.forEach(function (mesh) {
      mesh.metadata = mesh.metadata || {};
      mesh.metadata.lightIndex = index;
      mesh.isPickable = true;
      mesh.checkCollisions = false;
    });

    var label = createLabel(index);
    label.parent = root;
    label.position = new BABYLON.Vector3(0, y + 15, 0);

    return {
      light: light,
      root: root,
      meshes: meshes,
      bulb: bulb,
      core: core,
      indicator: indicator,
      halo: halo,
      pool: pool.mesh,
      label: label,
      point: null,
      pointPosition: new BABYLON.Vector3(0, y - size * 0.32, 0),
      pointRange: 170,
      bodyMat: bodyMat,
      bulbMat: bulbMat,
      coreMat: coreMat,
      indicatorMat: indicatorMat,
      haloMat: haloMat,
      poolMat: pool.material,
      poolTex: pool.texture
    };
  }

  function createLightPool(index, panelW, panelD, size, root, dimensions) {
    var tex = new BABYLON.DynamicTexture('lamp-pool-tex-' + index, { width: 256, height: 128 }, scene, false);
    tex.hasAlpha = true;
    var mat = new BABYLON.StandardMaterial('lamp-pool-mat-' + index, scene);
    mat.diffuseTexture = tex;
    mat.emissiveTexture = tex;
    mat.opacityTexture = tex;
    mat.useAlphaFromDiffuseTexture = true;
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    mat.disableDepthWrite = true;
    mat.alphaMode = BABYLON.Engine.ALPHA_ADD;
    mat.alpha = 0;

    var mesh = BABYLON.MeshBuilder.CreateGround('lamp-light-pool-' + index, {
      width: dimensions ? dimensions.width : Math.max(52, panelW * 4.5),
      height: dimensions ? dimensions.height : Math.max(38, panelD * 7.2),
      subdivisions: 1
    }, scene);
    mesh.position = new BABYLON.Vector3(0, 2.16 + index * 0.002, 0);
    mesh.material = mat;
    mesh.parent = root;
    mesh.isPickable = false;
    mesh.checkCollisions = false;
    mesh.receiveShadows = false;

    paintLightPool(tex, palette[state.activeStyle].glow, false, size);
    return { mesh: mesh, material: mat, texture: tex };
  }

  function paintLightPool(tex, hex, on, size) {
    var ctx = tex.getContext();
    ctx.clearRect(0, 0, 256, 128);
    if (!on) {
      tex.update();
      return;
    }

    var rgb = hexToRgb(hex);
    function rgba(alpha) {
      return 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + alpha + ')';
    }

    var strength = clamp(size / 18, 0.68, 1);
    var outer = ctx.createRadialGradient(128, 64, 7, 128, 64, 126);
    outer.addColorStop(0, rgba(0.58 * strength));
    outer.addColorStop(0.28, rgba(0.39 * strength));
    outer.addColorStop(0.64, rgba(0.16 * strength));
    outer.addColorStop(0.86, rgba(0.055 * strength));
    outer.addColorStop(1, rgba(0));
    ctx.fillStyle = outer;
    ctx.beginPath();
    ctx.ellipse(128, 64, 116, 54, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalCompositeOperation = 'lighter';
    [
      [28, 24, 200, 80, 22, 0.19],
      [48, 35, 160, 58, 17, 0.18],
      [70, 44, 116, 40, 12, 0.16],
      [94, 53, 68, 22, 8, 0.14]
    ].forEach(function (item) {
      ctx.fillStyle = rgba(item[5] * strength);
      roundRect(ctx, item[0], item[1], item[2], item[3], item[4]);
      ctx.fill();
    });
    ctx.strokeStyle = rgba(0.56 * strength);
    ctx.lineWidth = 3;
    roundRect(ctx, 20, 15, 216, 98, 20);
    ctx.stroke();
    ctx.strokeStyle = rgba(0.26 * strength);
    ctx.lineWidth = 1.5;
    roundRect(ctx, 42, 31, 172, 66, 15);
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
    tex.update();
  }

  function createPanelLightFrame(root, index, panelW, panelH, panelD, y, meshes, frameMaterial) {
    var rail = Math.max(0.72, panelH * 0.34);
    var z = panelD * 0.5 - rail * 0.5;
    var x = panelW * 0.5 - rail * 0.5;
    var railH = Math.max(0.42, panelH * 0.24);
    [
      { name: 'front', size: new BABYLON.Vector3(panelW, railH, rail), pos: new BABYLON.Vector3(0, y, -z) },
      { name: 'back', size: new BABYLON.Vector3(panelW, railH, rail), pos: new BABYLON.Vector3(0, y, z) },
      { name: 'left', size: new BABYLON.Vector3(rail, railH, panelD - rail * 2), pos: new BABYLON.Vector3(-x, y, 0) },
      { name: 'right', size: new BABYLON.Vector3(rail, railH, panelD - rail * 2), pos: new BABYLON.Vector3(x, y, 0) }
    ].forEach(function (part) {
      var mesh = box('lamp-frame-' + part.name + '-' + index, part.size, part.pos, frameMaterial || state.materials.lampFrame, root, true, false);
      mesh.checkCollisions = false;
      meshes.push(mesh);
    });
  }

  function createLabel(index) {
    var tex = new BABYLON.DynamicTexture('label-tex-' + index, { width: 420, height: 142 }, scene, false);
    tex.hasAlpha = true;
    var mat = new BABYLON.StandardMaterial('label-mat-' + index, scene);
    mat.diffuseTexture = tex;
    mat.emissiveTexture = tex;
    mat.opacityTexture = tex;
    mat.backFaceCulling = false;
    mat.disableLighting = true;

    var plane = BABYLON.MeshBuilder.CreatePlane('label-' + index, { width: 70, height: 23 }, scene);
    plane.material = mat;
    plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
    plane.isPickable = false;
    plane.metadata = { labelTexture: tex };
    return plane;
  }

  function drawLabel(entry, index, on, pending) {
    var tex = entry.label.metadata.labelTexture;
    var ctx = tex.getContext();
    var light = entry.light;
    pending = !!pending;
    var areaPrefix = entry.gridArea === 'extension' ? '封箱机区域 · ' : '';
    var gridLine = entry.isGridSegment
      ? areaPrefix + '第 ' + pad(light.grid_column) + ' 列 · ' + light.grid_start + '–' +
        (light.grid_start + light.grid_count - 1) + ' 号 · ' + light.grid_count + ' 盏'
      : light.group;
    var labelKey = [state.activeStyle, light.name, gridLine, on ? 1 : 0, pending ? 1 : 0].join('|');
    if (entry.label.metadata.renderKey === labelKey) return;
    entry.label.metadata.renderKey = labelKey;
    var color = pending ? '#ffd36a' : (on ? palette[state.activeStyle].glow : 'rgba(255,255,255,0.18)');
    ctx.clearRect(0, 0, 420, 142);
    ctx.fillStyle = pending ? 'rgba(58,43,14,0.84)' : (on ? 'rgba(12,22,20,0.82)' : 'rgba(16,18,20,0.70)');
    roundRect(ctx, 12, 12, 396, 118, 18);
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 33px Microsoft YaHei, sans-serif';
    ctx.fillText(light.name, 28, 60);
    ctx.fillStyle = pending ? '#ffd36a' : (on ? palette[state.activeStyle].glow : '#9aa2aa');
    ctx.font = '700 23px Microsoft YaHei, sans-serif';
    ctx.fillText(gridLine + ' / ' + (pending ? '\u786e\u8ba4\u4e2d' : (on ? 'ON' : 'OFF')), 28, 101);
    tex.update();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function mixVisualColor(from, to, amount) {
    var t = clamp(amount, 0, 1);
    return new BABYLON.Color3(
      from.r + (to.r - from.r) * t,
      from.g + (to.g - from.g) * t,
      from.b + (to.b - from.b) * t
    );
  }

  function animateLightEntry(entry, index, delta, time) {
    if (!entry || !entry.bulbMat || entry.visualTarget == null) return;
    var light = state.config.lights[index] || entry.light || {};
    var level = Number.isFinite(entry.visualLevel) ? entry.visualLevel : 0;
    var speed = entry.visualTarget > level ? 7.4 : 5.0;
    var amount = delta > 0 ? 1 - Math.exp(-delta * speed) : 0;
    level += (entry.visualTarget - level) * amount;
    if (Math.abs(entry.visualTarget - level) < 0.002) level = entry.visualTarget;
    entry.visualLevel = level;

    entry.visualFlash = Math.max(0, (entry.visualFlash || 0) - delta * 1.7);
    var pulse = entry.visualFlash > 0
      ? entry.visualFlash * (0.45 + Math.sin(time * 18 + index * 0.7) * 0.12)
      : 0;
    var effective = clamp(level + pulse * 0.18, 0, 1.12);
    var face = entry.visualFaceColor || color3(palette[state.activeStyle].glow);
    var status = entry.visualStatusColor || face;
    var industrial = state.activeStyle === 'industrial';
    var offDiffuse = color3(industrial ? '#8c979c' : '#58636a');
    var offEmissive = color3('#11161a');
    var brightFace = face.scale(industrial ? 2.35 + pulse * 0.42 : 2.15 + pulse * 0.36);
    if (entry.bodyMat) {
      var offBody = color3(industrial ? '#737d82' : '#4f5960');
      var whiteBody = color3('#ffffff');
      entry.bodyMat.diffuseColor = mixVisualColor(offBody, whiteBody, effective);
      entry.bodyMat.emissiveColor = mixVisualColor(color3('#000000'), whiteBody.scale(0.82), effective);
      entry.bodyMat.specularColor = mixVisualColor(color3('#b8c0c4'), color3('#ffffff'), effective);
    }

    entry.bulbMat.emissiveColor = mixVisualColor(offEmissive, brightFace, effective);
    entry.bulbMat.diffuseColor = mixVisualColor(offDiffuse, face, effective);
    entry.bulbMat.alpha = 0.50 + clamp(effective, 0, 1) * 0.50;
    if (entry.coreMat) {
      entry.coreMat.emissiveColor = mixVisualColor(color3('#000000'), brightFace.scale(1.72), effective);
      entry.coreMat.diffuseColor = mixVisualColor(color3('#2e363b'), face, effective);
      entry.coreMat.alpha = 0.02 + clamp(effective, 0, 1) * 0.98;
    }
    if (entry.indicatorMat) {
      entry.indicatorMat.emissiveColor = mixVisualColor(color3('#080a0b'), status.scale(1.18), effective);
      entry.indicatorMat.diffuseColor = mixVisualColor(color3('#465057'), status, effective);
      entry.indicatorMat.alpha = 0.48 + clamp(effective, 0, 1) * 0.48;
    }
    if (entry.haloMat) {
      entry.haloMat.emissiveColor = brightFace;
      entry.haloMat.diffuseColor = face;
      entry.haloMat.alpha = effective * (industrial ? 0.46 : 0.52);
    }
    if (entry.halo) entry.halo.isVisible = effective > 0.004 || entry.visualTarget > 0;
    if (entry.poolMat) entry.poolMat.alpha = clamp(effective * (industrial ? 1.18 : 1.08) + pulse * 0.18, 0, 1);
    if (entry.pool) {
      var poolPulse = 1 + pulse * 0.045;
      entry.pool.scaling.x = poolPulse;
      entry.pool.scaling.z = poolPulse;
    }
    if (entry.pool) entry.pool.isVisible = effective > 0.004 || entry.visualTarget > 0;
    if (entry.poolClearPending && entry.visualTarget <= 0 && level <= 0.004) {
      paintLightPool(entry.poolTex, entry.visualPoolColor || '#fff0c7', false, 1);
      entry.poolClearPending = false;
      if (entry.pool) entry.pool.isVisible = false;
    }
    if (entry.point) {
      entry.point.diffuse = face;
      entry.point.specular = face;
      var coveredPanels = Math.max(1, toNumber(light.grid_count, 1));
      var localStrength = 1.65 + Math.min(1.15, Math.sqrt(coveredPanels) * 0.24);
      entry.point.intensity = effective * localStrength * (industrial ? 1.08 : 0.96) + pulse * 0.24;
    }
  }

  function animateLightVisuals(delta, time) {
    state.lightEntries.forEach(function (entry, index) {
      animateLightEntry(entry, index, delta, time);
    });
  }

  function updateLightVisual(index) {
    state.status = getRuntimeStatus();
    var entry = state.lightEntries[index];
    var light = state.config.lights[index];
    if (!entry || !light) return;
    var on = isLightOn(light, index);
    var relayStatus = state.status[light.device_ip];
    var connected = !!(relayStatus && relayStatus.connected);
    var pending = connected && typeof isChannelPending === 'function' && isChannelPending(light.device_ip, light.channel);
    var visualKey = [state.activeStyle, connected ? 1 : 0, on ? 1 : 0, pending ? 1 : 0].join('|');
    if (entry.visualKey === visualKey) return;
    entry.visualKey = visualKey;
    var statusColor = on ? (light.group.indexOf('工位') >= 0 ? palette[state.activeStyle].warm : palette[state.activeStyle].glow) : '#3b4248';
    if (pending) statusColor = '#ffd36a';
    var faceColor = pending ? '#ffe1a0' : (on ? (state.activeStyle === 'tech' ? '#eefcff' : (state.activeStyle === 'industrial' ? '#f5fbff' : '#fff8e9')) : '#1b2025');
    var poolColor = pending ? '#ffd36a' : (state.activeStyle === 'tech' ? '#9fffe0' : (state.activeStyle === 'industrial' ? '#ffe1a3' : '#fff0c7'));
    var nextTarget = pending ? 0.48 : (on ? 1 : 0);
    var previousTarget = Number.isFinite(entry.visualTarget) ? entry.visualTarget : 0;
    entry.visualLevel = Number.isFinite(entry.visualLevel) ? entry.visualLevel : 0;
    entry.visualTarget = nextTarget;
    entry.visualFaceColor = color3(faceColor);
    entry.visualPoolColor = poolColor;
    entry.visualStatusColor = color3(statusColor);
    entry.visualPending = !!pending;
    if (nextTarget > previousTarget) entry.visualFlash = 1;
    if (pending || on) {
      paintLightPool(entry.poolTex, poolColor, true, light.scale * (pending ? 3.7 : 4.5));
      entry.poolClearPending = false;
    } else if (previousTarget > 0 || entry.visualLevel > 0.004) {
      entry.poolClearPending = true;
    } else {
      paintLightPool(entry.poolTex, poolColor, false, light.scale);
      entry.poolClearPending = false;
    }
    animateLightEntry(entry, index, 0, performance.now() * 0.001);
    scheduleDynamicLightAssignments();
    scheduleSceneLightingUpdate();
    if (entry.label) drawLabel(entry, index, on, pending);
  }

  function ensureGridSegmentLabel(entry, index) {
    if (!entry || !entry.isGridSegment) return entry && entry.label;
    if (!entry.label) {
      entry.label = createLabel(index);
      entry.label.parent = entry.root;
      entry.label.position = new BABYLON.Vector3(0, entry.labelY, 0);
      var light = state.config.lights[index];
      var relayStatus = light && state.status[light.device_ip];
      var pending = !!(relayStatus && relayStatus.connected &&
        typeof isChannelPending === 'function' && isChannelPending(light.device_ip, light.channel));
      drawLabel(entry, index, !!(light && isLightOn(light, index)), pending);
    }
    return entry.label;
  }

  function focusLight(index, moveCamera, showPopup) {
    if (state.selectedLight != null) {
      var previousEntry = state.lightEntries[state.selectedLight];
      if (previousEntry && previousEntry.isGridSegment && previousEntry.label) {
        previousEntry.label.isVisible = false;
      }
    }
    if (index == null) {
      state.selectedLight = null;
      highlight.removeAllMeshes();
      scheduleDynamicLightAssignments();
      var popEl = document.getElementById('device-pop');
      if (popEl) popEl.hidden = true;
      return;
    }
    state.selectedLight = index;
    scheduleDynamicLightAssignments();
    highlight.removeAllMeshes();
    var entry = state.lightEntries[index];
    if (!entry) {
      var emptyPop = document.getElementById('device-pop');
      if (emptyPop) emptyPop.hidden = true;
      return;
    }
    if (entry.isGridSegment) {
      var gridLabel = ensureGridSegmentLabel(entry, index);
      if (gridLabel) gridLabel.isVisible = true;
    }
    entry.meshes.forEach(function (mesh) {
      if (!mesh.metadata || !mesh.metadata.skipLampHighlight) {
        highlight.addMesh(mesh, color3('#ffd68a'));
      }
    });
    if (moveCamera !== false) {
      orbitCamera.setTarget(entry.root.position.add(new BABYLON.Vector3(0, 25, 0)));
    }
    if (showPopup === false) {
      var pop = document.getElementById('device-pop');
      if (pop) pop.hidden = true;
    } else {
      renderDevicePop(index);
    }
  }

  function renderDevicePop(index) {
    var pop = document.getElementById('device-pop');
    var entry = state.lightEntries[index];
    var light = state.config.lights[index];
    if (!entry || !light) {
      pop.hidden = true;
      return;
    }
    var screen = BABYLON.Vector3.Project(
      entry.root.position.add(new BABYLON.Vector3(0, 56, 0)),
      BABYLON.Matrix.Identity(),
      scene.getTransformMatrix(),
      orbitCamera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight())
    );
    pop.style.left = clamp(screen.x + 16, 16, engine.getRenderWidth() - 300) + 'px';
    pop.style.top = clamp(screen.y - 38, 84, engine.getRenderHeight() - 170) + 'px';
    pop.innerHTML =
      '<div class="pop-title">' + escapeHtml(light.name) + '</div>' +
      '<div class="pop-meta">' + escapeHtml(entry.isGridSegment
        ? ((entry.gridArea === 'extension' ? '封箱机区域 · ' : '') + '第 ' + pad(light.grid_column) + ' 列 · ' + light.grid_start + '–' + (light.grid_start + light.grid_count - 1) + ' 号 · 连续 ' + light.grid_count + ' 盏')
        : light.group) + '</div>' +
      '<div class="pop-meta">' + escapeHtml(light.device_ip) + ' / CH ' + pad(Number(light.channel) + 1) + '</div>' +
      '<div class="pop-meta">状态: ' + (isLightOn(light, index) ? '已开启' : '关闭') + '</div>' +
      '<div class="pop-actions">' +
        '<button class="btn btn-primary" data-pop="toggle" type="button">切换</button>' +
        '<button class="btn btn-ghost" data-pop="close" type="button">关闭</button>' +
      '</div>';
    pop.querySelector('[data-pop="toggle"]').onclick = function () {
      toggleConfiguredLight(index);
    };
    pop.querySelector('[data-pop="close"]').onclick = function () { pop.hidden = true; };
    pop.hidden = false;
  }

  function findPickedLight(mesh) {
    var node = mesh;
    while (node) {
      if (node.metadata && node.metadata.lightIndex != null) return node.metadata.lightIndex;
      node = node.parent;
    }
    return null;
  }

  function toggleConfiguredLight(index) {
    var light = state.config.lights[index];
    if (!light) return false;
    // Use the shared indexed control path when available.  Besides issuing the
    // /api/toggle request it owns the operation lock, pending state, status
    // reconciliation and user-facing offline/error feedback.
    if (typeof toggleLight === 'function') {
      toggleLight(index);
      return true;
    }
    if (typeof toggleDeviceChannel === 'function') {
      toggleDeviceChannel(light.device_ip, light.channel);
      return true;
    }
    return false;
  }

  scene.onPointerObservable.add(function (pointerInfo) {
    if (pointerInfo.type !== BABYLON.PointerEventTypes.POINTERPICK) return;
    var pick = pointerInfo.pickInfo;
    var gridMapModeActive = typeof window.isLightingGridMapModeActive === 'function' &&
      window.isLightingGridMapModeActive();
    if (gridMapModeActive) {
      var cell = getLightingGridCellFromPick(pick);
      if (typeof window.handleLightingGridScenePick === 'function') {
        window.handleLightingGridScenePick(cell);
      }
      return;
    }
    if (!pick || !pick.hit || !pick.pickedMesh) return;
    var index = findPickedLight(pick.pickedMesh);
    if (index == null) return;
    var light = state.config.lights[index];
    var controlViewActive = document.body.classList.contains('view-control') ||
      (typeof topView !== 'undefined' && topView === 'control');
    if (controlViewActive && light) {
      // Keep the clicked circuit selected while the command is pending, and
      // always control by its config.lights index so extension-room circuits use
      // exactly the same device_ip/channel mapping as the main workshop.
      focusLight(index, false, false);
      toggleConfiguredLight(index);
    } else if (typeof focusLamp === 'function') {
      focusLamp(index);
    } else {
      focusLight(index);
    }
  });

  function updateHud() {
    var source = document.getElementById('hud-source');
    var style = document.getElementById('hud-style');
    if (source) source.textContent = '后端实时配置';
    if (style) style.textContent = state.activeStyle === 'industrial'
      ? '冷白工业'
      : (state.activeStyle === 'tech' ? '科技夜景' : '柔和日景');
  }

  function fmtTemp(value) {
    var n = Number(value);
    return Number.isFinite(n) ? (Math.round(n * 10) / 10).toFixed(1) + ' °C' : '— °C';
  }

  async function fetchWeatherJson() {
    var urls = ['/api/weather'];
    if (location.port !== '8888') urls.push('http://127.0.0.1:8888/api/weather');
    var lastError = null;
    for (var i = 0; i < urls.length; i++) {
      try {
        var res = await fetch(urls[i], { cache: 'no-store' });
        if (!res.ok) throw new Error('weather ' + res.status);
        return await res.json();
      } catch (error) {
        lastError = error;
      }
    }
    try {
      return await fetchOpenMeteoWeather();
    } catch (error) {
      throw lastError || error || new Error('weather unavailable');
    }
  }

  function getWeatherText(code) {
    var map = {
      0: '晴',
      1: '晴间多云',
      2: '多云',
      3: '阴',
      45: '雾',
      48: '雾凇',
      51: '小毛毛雨',
      53: '毛毛雨',
      55: '大毛毛雨',
      56: '冻雨',
      57: '冻雨',
      61: '小雨',
      63: '中雨',
      65: '大雨',
      66: '冻雨',
      67: '冻雨',
      71: '小雪',
      73: '中雪',
      75: '大雪',
      77: '雪粒',
      80: '阵雨',
      81: '阵雨',
      82: '强阵雨',
      85: '阵雪',
      86: '强阵雪',
      95: '雷雨',
      96: '雷雨伴冰雹',
      99: '雷雨伴冰雹'
    };
    return map[code] || '--';
  }

  async function fetchOpenMeteoWeather() {
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=27.8983&longitude=102.2641&current_weather=true&daily=temperature_2m_max,temperature_2m_min&timezone=Asia%2FShanghai&forecast_days=1';
    var res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('open-meteo ' + res.status);
    var payload = await res.json();
    var current = payload.current_weather || {};
    var daily = payload.daily || {};
    var highs = daily.temperature_2m_max || [];
    var lows = daily.temperature_2m_min || [];
    var code = current.weathercode == null ? null : Number(current.weathercode);
    return {
      ok: true,
      city: '西昌',
      temperature: current.temperature,
      high: highs.length ? highs[0] : null,
      low: lows.length ? lows[0] : null,
      weather_code: code,
      weather_text: getWeatherText(code)
    };
  }

  async function tickWeather() {
    var next = 600000;
    try {
      var json = await fetchWeatherJson();
      if (!json || !json.ok) throw new Error('weather not ok');
      var main = document.getElementById('hud-temp-main');
      var high = document.getElementById('hud-temp-high');
      var low = document.getElementById('hud-temp-low');
      var text = document.getElementById('hud-weather-text');
      if (main) main.textContent = fmtTemp(json.temperature);
      if (high) high.textContent = fmtTemp(json.high);
      if (low) low.textContent = fmtTemp(json.low);
      if (text) text.textContent = (json.city || '西昌') + ' · ' + (json.weather_text || '--');
    } catch (error) {
      next = 120000;
    } finally {
      setTimeout(tickWeather, next);
    }
  }

  function fitCamera() {
    var b = state.config.layout.building || normalizeBuilding(DEFAULT_BUILDING);
    var bounds = getContentBounds();
    var centerX = bounds ? (bounds.minX + bounds.maxX) / 2 : 0;
    var centerZ = bounds ? (bounds.minZ + bounds.maxZ) / 2 : 0;
    var spanX = bounds ? Math.max(180, bounds.maxX - bounds.minX) : b.width;
    var spanZ = bounds ? Math.max(180, bounds.maxZ - bounds.minZ) : b.depth;
    orbitCamera.setTarget(new BABYLON.Vector3(centerX, 32, centerZ));
    orbitCamera.alpha = DEFAULT_VIEW_ALPHA;
    orbitCamera.beta = DEFAULT_VIEW_BETA;
    orbitCamera.radius = Math.max(spanX, spanZ, b.depth * 0.72) * DEFAULT_VIEW_RADIUS_SCALE;
  }

  function focusGridRange(sourceRange) {
    var layout = state.config.layout || {};
    var gridArea = sourceRange && (sourceRange.area === 'extension' || sourceRange.grid_area === 'extension')
      ? 'extension'
      : 'main';
    var grid = gridArea === 'extension' ? state.extensionGrid : layout.lightingGrid;
    if (!grid || !grid.enabled) return false;

    var range = normalizeGridSelectionRange(sourceRange, grid);
    if (!range) return false;

    var metrics = gridArea === 'extension'
      ? state.extensionGridMetrics
      : getGridMetrics(grid, layout.building || DEFAULT_BUILDING);
    if (!metrics) return false;
    var getPosition = gridArea === 'extension' ? getExtensionRoomPanelPosition : getGridPanelPosition;
    var first = getPosition(metrics, range.column, range.start);
    var last = getPosition(metrics, range.column, range.end);
    var centerX = (first.x + last.x) / 2;
    var centerZ = (first.z + last.z) / 2;
    var alongSpan = Math.hypot(last.x - first.x, last.z - first.z) + metrics.panelDepth;
    var focusSpan = Math.max(alongSpan, metrics.panelWidth * 3);
    var lowerLimit = Math.max(180, Number(orbitCamera.lowerRadiusLimit) || 0);
    var upperLimit = Math.min(900, Number(orbitCamera.upperRadiusLimit) || 900);
    if (upperLimit < lowerLimit) upperLimit = lowerLimit;
    var radius = clamp(focusSpan * 1.25 + 120, lowerLimit, upperLimit);

    var alpha = orbitCamera.alpha;
    var beta = orbitCamera.beta;
    orbitCamera.setTarget(new BABYLON.Vector3(centerX, metrics.y, centerZ));
    orbitCamera.alpha = alpha;
    orbitCamera.beta = beta;
    orbitCamera.radius = radius;
    orbitCamera.inertialAlphaOffset = 0;
    orbitCamera.inertialBetaOffset = 0;
    orbitCamera.inertialRadiusOffset = 0;
    orbitCamera.inertialPanningX = 0;
    orbitCamera.inertialPanningY = 0;
    return true;
  }

  function getContentBounds() {
    var xs = [];
    var zs = [];
    state.config.lights.forEach(function (light) {
      xs.push(light.x);
      zs.push(light.z);
    });
    (state.config.layout.workstations || []).forEach(function (item) {
      var x = toNumber(item.x, 0);
      var z = toNumber(item.z, 0);
      var halfW = Math.max(20, toNumber(item.width, 60) / 2);
      var halfD = Math.max(20, toNumber(item.depth, 40) / 2);
      xs.push(x - halfW, x + halfW);
      zs.push(z - halfD, z + halfD);
    });
    var b = state.config.layout.building;
    if (b) {
      xs.push(-b.halfW - 92, -b.halfW + 24);
      zs.push(-110, 110);
      if (state.config.layout.lightingGrid && state.config.layout.lightingGrid.enabled) {
        xs.push(-b.halfW, b.halfW);
        zs.push(-b.halfD, b.halfD);
      }
      var extensionRoom = state.config.layout.extensionRoom;
      if (extensionRoom && extensionRoom.enabled) {
        xs.push(-b.halfW - extensionRoom.length, -b.halfW);
        zs.push(-extensionRoom.width / 2, extensionRoom.width / 2);
      }
    }
    if (!xs.length || !zs.length) return null;
    return {
      minX: Math.min.apply(Math, xs),
      maxX: Math.max.apply(Math, xs),
      minZ: Math.min.apply(Math, zs),
      maxZ: Math.max.apply(Math, zs)
    };
  }

  function setStyle(style) {
    if (!palette[style]) return;
    if (style === state.activeStyle) return;
    state.activeStyle = style;
    var p = palette[style];
    scene.clearColor = p.clear;
    scene.fogColor = p.fog;
    scene.fogDensity = style === 'tech' ? 0.00072 : (style === 'industrial' ? 0.00028 : 0.0009);
    hemi.intensity = style === 'tech' ? 0.86 : (style === 'industrial' ? 1.08 : 0.68);
    keyLight.intensity = style === 'tech' ? 3.05 : (style === 'industrial' ? 1.45 : 1.65);
    glow.intensity = style === 'tech' ? 0.58 : (style === 'industrial' ? 0.22 : 0.42);
    if (pipeline) {
      pipeline.bloomWeight = style === 'tech' ? 0.34 : (style === 'industrial' ? 0.14 : 0.24);
      pipeline.bloomThreshold = style === 'tech' ? 0.62 : (style === 'industrial' ? 0.82 : 0.76);
    }
    rebuildScene();
    state.config.lights.forEach(function (_, i) { updateLightVisual(i); });
    updateSceneLighting();
    updateHud();
  }

  function toggleWalkMode(forceValue) {
    state.walkMode = typeof forceValue === 'boolean' ? forceValue : !state.walkMode;
    clearOrbitPanKeys();
    if (typeof walkMode !== 'undefined') walkMode = state.walkMode;
    var btn = document.getElementById('hud-walk') || document.getElementById('walk-toggle');
    var label = document.getElementById('walk-label');
    if (state.walkMode) {
      orbitCamera.detachControl(canvas);
      scene.activeCamera = walkCamera;
      walkCamera.attachControl(canvas, true);
      if (btn) btn.classList.add('active');
      if (label) label.textContent = '第一人称: 开';
      canvas.focus();
    } else {
      walkCamera.detachControl(canvas);
      scene.activeCamera = orbitCamera;
      orbitCamera.attachControl(canvas, true);
      if (btn) btn.classList.remove('active');
      if (label) label.textContent = '第一人称: 关';
    }
    var reticle = document.getElementById('walk-reticle');
    if (reticle) reticle.classList.toggle('show', state.walkMode);
  }

  function bindUI() {
    var walkToggle = document.getElementById('hud-walk') || document.getElementById('walk-toggle');
    if (walkToggle) walkToggle.onclick = function () {
      if (typeof window.toggleWalkMode === 'function') window.toggleWalkMode();
      else toggleWalkMode();
    };
  }

  function tickClock() {
    var now = new Date();
    document.getElementById('hud-clock').textContent = pad(now.getHours()) + ':' + pad(now.getMinutes());
  }

  var lastRenderTime = performance.now();
  engine.runRenderLoop(function () {
    var renderTime = performance.now();
    var renderDelta = Math.min(0.05, Math.max(0.001, (renderTime - lastRenderTime) / 1000));
    lastRenderTime = renderTime;
    updateOrbitKeyboardPan();
    animateLightVisuals(renderDelta, renderTime * 0.001);
    animateSceneLighting(renderDelta);
    if (state.selectedLight != null && !document.getElementById('device-pop').hidden) {
      renderDevicePop(state.selectedLight);
    }
    scene.render();
  });

  setInterval(function () {
    document.getElementById('hud-fps').textContent = Math.round(engine.getFps()) + ' FPS';
  }, 500);

  window.addEventListener('resize', resizeScene);

  window.BabylonApp = {
    engine: engine,
    scene: scene,
    rebuildScene: rebuildScene,
    updateLightVisual: updateLightVisual,
    focusLight: focusLight,
    fitCamera: fitCamera,
    focusGridRange: focusGridRange,
    toggleWalkMode: toggleWalkMode,
    setStyle: setStyle,
    setGridSelectionOverlay: setGridSelectionOverlay,
    clearGridSelectionOverlay: clearGridSelectionOverlay,
    toggleLight: toggleConfiguredLight,
    findPickedLight: findPickedLight,
    getLightingGridCellFromPick: getLightingGridCellFromPick
  };

  bindUI();
  tickClock();
  setInterval(tickClock, 1000);
  tickWeather();
  buildMaterials();
  rebuildScene();
  resizeScene();
  if (window.requestAnimationFrame) window.requestAnimationFrame(resizeScene);
  setTimeout(resizeScene, 80);
  updateHud();
})();
