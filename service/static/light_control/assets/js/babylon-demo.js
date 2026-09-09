(function () {
  'use strict';

  if (typeof BABYLON === 'undefined') {
    var missing = document.createElement('div');
    missing.className = 'demo-hint';
    missing.textContent = 'Babylon.js 没有加载成功，请检查 libs/babylon.js。';
    document.body.appendChild(missing);
    return;
  }

  var canvas = document.getElementById('babylon-scene');
  var engine = new BABYLON.Engine(canvas, true, {
    antialias: true,
    stencil: true,
    preserveDrawingBuffer: false
  });

  var scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0.046, 0.050, 0.058, 1);
  scene.fogMode = BABYLON.Scene.FOGMODE_EXP2;
  scene.fogDensity = 0.0012;
  scene.fogColor = new BABYLON.Color3(0.035, 0.041, 0.052);
  scene.collisionsEnabled = true;
  scene.environmentIntensity = 0.72;

  if (scene.imageProcessingConfiguration) {
    scene.imageProcessingConfiguration.toneMappingEnabled = true;
    scene.imageProcessingConfiguration.toneMappingType = BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES;
    scene.imageProcessingConfiguration.exposure = 1.05;
    scene.imageProcessingConfiguration.contrast = 1.16;
  }

  var orbitCamera = new BABYLON.ArcRotateCamera(
    'orbit-camera',
    -Math.PI / 2.18,
    0.82,
    740,
    new BABYLON.Vector3(0, 34, 0),
    scene
  );
  orbitCamera.attachControl(canvas, true);
  orbitCamera.lowerBetaLimit = 0.35;
  orbitCamera.upperBetaLimit = 1.35;
  orbitCamera.lowerRadiusLimit = 190;
  orbitCamera.upperRadiusLimit = 1120;
  orbitCamera.wheelPrecision = 22;
  orbitCamera.panningSensibility = 38;
  orbitCamera.inertia = 0.72;
  orbitCamera.minZ = 0.3;
  orbitCamera.maxZ = 2500;

  var walkCamera = new BABYLON.UniversalCamera('walk-camera', new BABYLON.Vector3(-230, 42, 145), scene);
  walkCamera.setTarget(new BABYLON.Vector3(0, 34, 0));
  walkCamera.speed = 5.2;
  walkCamera.angularSensibility = 2600;
  walkCamera.inertia = 0.66;
  walkCamera.minZ = 0.25;
  walkCamera.maxZ = 1800;
  walkCamera.ellipsoid = new BABYLON.Vector3(8, 18, 8);
  walkCamera.checkCollisions = true;
  walkCamera.applyGravity = false;
  walkCamera.keysUp = [87, 38];
  walkCamera.keysDown = [83, 40];
  walkCamera.keysLeft = [65, 37];
  walkCamera.keysRight = [68, 39];

  scene.activeCamera = orbitCamera;

  var hemi = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0.1, 1, 0.25), scene);
  hemi.intensity = 0.56;
  hemi.diffuse = new BABYLON.Color3(0.64, 0.74, 0.86);
  hemi.groundColor = new BABYLON.Color3(0.08, 0.11, 0.09);

  var keyLight = new BABYLON.DirectionalLight('key-light', new BABYLON.Vector3(0.42, -0.82, 0.38), scene);
  keyLight.position = new BABYLON.Vector3(-320, 520, -360);
  keyLight.intensity = 2.55;
  keyLight.diffuse = new BABYLON.Color3(1.0, 0.88, 0.68);

  var shadow = new BABYLON.ShadowGenerator(2048, keyLight);
  shadow.useBlurExponentialShadowMap = true;
  shadow.blurKernel = 24;
  shadow.setDarkness(0.34);

  var glow = new BABYLON.GlowLayer('demo-glow', scene, { mainTextureSamples: 4 });
  glow.intensity = 0.58;

  var highlight = new BABYLON.HighlightLayer('selected-highlight', scene);
  highlight.innerGlow = false;
  highlight.outerGlow = true;
  highlight.blurHorizontalSize = 0.8;
  highlight.blurVerticalSize = 0.8;

  var pipeline = null;
  if (BABYLON.DefaultRenderingPipeline) {
    pipeline = new BABYLON.DefaultRenderingPipeline('demo-pipeline', true, scene, [orbitCamera, walkCamera]);
    pipeline.samples = 4;
    pipeline.fxaaEnabled = true;
    pipeline.bloomEnabled = true;
    pipeline.bloomThreshold = 0.62;
    pipeline.bloomWeight = 0.34;
    pipeline.bloomKernel = 72;
    pipeline.imageProcessingEnabled = true;
  }

  var palette = {
    tech: {
      clear: new BABYLON.Color4(0.025, 0.029, 0.037, 1),
      fog: new BABYLON.Color3(0.035, 0.041, 0.052),
      floor: '#101922',
      ground: '#07090d',
      wall: '#12202b',
      steel: '#7f8b95',
      glow: '#35e6a8',
      warm: '#ffbf67'
    },
    soft: {
      clear: new BABYLON.Color4(0.70, 0.73, 0.75, 1),
      fog: new BABYLON.Color3(0.70, 0.73, 0.75),
      floor: '#d4d8d7',
      ground: '#8b9492',
      wall: '#c8cecc',
      steel: '#6e767a',
      glow: '#30d158',
      warm: '#ff9f0a'
    }
  };

  var activeStyle = 'tech';
  var selectedId = null;
  var selectedMeshes = [];
  var animatedFans = [];
  var flowStrips = [];
  var deviceMap = Object.create(null);

  var devices = [
    { id: 'A01', name: 'A区 主灯 01', group: '生产区', type: 'lamp', x: -230, z: -78, on: true, color: '#35e6a8' },
    { id: 'A02', name: 'A区 主灯 02', group: '生产区', type: 'lamp', x: -130, z: -78, on: true, color: '#35e6a8' },
    { id: 'A03', name: 'A区 主灯 03', group: '生产区', type: 'lamp', x: -30, z: -78, on: false, color: '#35e6a8' },
    { id: 'B01', name: 'B区 工位灯 01', group: '装配区', type: 'lamp', x: 92, z: -78, on: true, color: '#ffbf67' },
    { id: 'B02', name: 'B区 工位灯 02', group: '装配区', type: 'lamp', x: 215, z: -78, on: true, color: '#ffbf67' },
    { id: 'F01', name: '吊扇 01', group: '通风', type: 'fan', x: -185, z: 55, on: true, color: '#66d9ff' },
    { id: 'F02', name: '吊扇 02', group: '通风', type: 'fan', x: 24, z: 55, on: false, color: '#66d9ff' },
    { id: 'F03', name: '吊扇 03', group: '通风', type: 'fan', x: 226, z: 55, on: true, color: '#66d9ff' },
    { id: 'P01', name: '配电柜 01', group: '控制柜', type: 'panel', x: -282, z: 103, on: true, color: '#35e6a8' },
    { id: 'P02', name: '配电柜 02', group: '控制柜', type: 'panel', x: 282, z: 103, on: false, color: '#35e6a8' }
  ];

  var mats = {};

  function color3(hex) {
    return BABYLON.Color3.FromHexString(hex);
  }

  function pbr(name, options) {
    var mat = new BABYLON.PBRMaterial(name, scene);
    options = options || {};
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
    var mat = new BABYLON.StandardMaterial(name, scene);
    options = options || {};
    mat.diffuseColor = color3(options.color || '#ffffff');
    mat.specularColor = color3(options.specular || '#050505');
    if (options.emissive) mat.emissiveColor = color3(options.emissive);
    if (options.alpha != null && options.alpha < 1) {
      mat.alpha = options.alpha;
      mat.backFaceCulling = false;
    }
    return mat;
  }

  function rebuildMaterials() {
    Object.keys(mats).forEach(function (key) {
      if (mats[key] && mats[key].dispose) mats[key].dispose();
    });

    var p = palette[activeStyle];
    mats.outdoor = pbr('outdoor', { color: p.ground, metallic: 0.05, roughness: 0.72 });
    mats.floor = pbr('floor', { color: p.floor, metallic: 0.22, roughness: 0.30 });
    mats.wall = pbr('wall', { color: p.wall, metallic: 0.12, roughness: 0.42, alpha: activeStyle === 'tech' ? 0.28 : 0.72 });
    mats.glass = pbr('glass', { color: '#a9d7d7', metallic: 0.0, roughness: 0.18, alpha: activeStyle === 'tech' ? 0.18 : 0.42 });
    mats.steel = pbr('steel', { color: p.steel, metallic: 0.74, roughness: 0.28 });
    mats.dark = pbr('dark-shell', { color: activeStyle === 'tech' ? '#171b20' : '#5d676b', metallic: 0.42, roughness: 0.38 });
    mats.black = pbr('black', { color: '#08090b', metallic: 0.2, roughness: 0.58 });
    mats.path = pbr('path', { color: activeStyle === 'tech' ? '#19332f' : '#9aa7a2', metallic: 0.05, roughness: 0.56 });
    mats.zone = pbr('zone', { color: activeStyle === 'tech' ? '#183039' : '#b9c2c0', metallic: 0.05, roughness: 0.52, alpha: activeStyle === 'tech' ? 0.44 : 0.64 });
    mats.label = standard('label', { color: '#ffffff', emissive: '#ffffff' });
    mats.grid = makeGridMaterial('grid', activeStyle);
  }

  function makeGridMaterial(name, style) {
    var tex = new BABYLON.DynamicTexture(name + '-texture', { width: 1024, height: 1024 }, scene, false);
    var ctx = tex.getContext();
    var bg = style === 'tech' ? '#111922' : '#cdd3d1';
    var major = style === 'tech' ? 'rgba(53,230,168,0.30)' : 'rgba(40,70,62,0.23)';
    var minor = style === 'tech' ? 'rgba(255,255,255,0.065)' : 'rgba(20,30,30,0.10)';
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
    tex.update();
    tex.wrapU = BABYLON.Texture.WRAP_ADDRESSMODE;
    tex.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
    tex.uScale = 4.5;
    tex.vScale = 2.2;

    var mat = pbr(name + '-mat', {
      color: '#ffffff',
      metallic: style === 'tech' ? 0.22 : 0.04,
      roughness: style === 'tech' ? 0.26 : 0.58
    });
    mat.albedoTexture = tex;
    return mat;
  }

  rebuildMaterials();

  function assignPick(mesh, id) {
    mesh.metadata = mesh.metadata || {};
    mesh.metadata.deviceId = id;
    mesh.isPickable = true;
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

  function cylinder(name, options, position, material, parent, cast, receive) {
    var mesh = BABYLON.MeshBuilder.CreateCylinder(name, options, scene);
    mesh.position.copyFrom(position);
    mesh.material = material;
    if (parent) mesh.parent = parent;
    return addShadow(mesh, cast, receive);
  }

  function createFactory() {
    var outdoor = BABYLON.MeshBuilder.CreateGround('outdoor-ground', { width: 1080, height: 660, subdivisions: 2 }, scene);
    outdoor.position.y = -2;
    outdoor.material = mats.outdoor;
    outdoor.receiveShadows = true;

    var floor = BABYLON.MeshBuilder.CreateGround('factory-floor', { width: 650, height: 270, subdivisions: 2 }, scene);
    floor.position.y = 0;
    floor.material = mats.grid;
    floor.receiveShadows = true;

    box('main-path', new BABYLON.Vector3(620, 1.2, 28), new BABYLON.Vector3(0, 1.2, 18), mats.path, null, false, true);
    box('left-zone', new BABYLON.Vector3(280, 1.4, 94), new BABYLON.Vector3(-165, 1.6, -72), mats.zone, null, false, true);
    box('right-zone', new BABYLON.Vector3(280, 1.4, 94), new BABYLON.Vector3(165, 1.6, -72), mats.zone, null, false, true);

    var wallH = 92;
    box('back-wall', new BABYLON.Vector3(650, wallH, 5), new BABYLON.Vector3(0, wallH / 2, 137), mats.wall, null, true, true);
    box('left-wall', new BABYLON.Vector3(5, wallH, 270), new BABYLON.Vector3(-327.5, wallH / 2, 0), mats.wall, null, true, true);
    box('right-wall', new BABYLON.Vector3(5, wallH, 270), new BABYLON.Vector3(327.5, wallH / 2, 0), mats.wall, null, true, true);
    box('front-door-left', new BABYLON.Vector3(232, wallH, 5), new BABYLON.Vector3(-209, wallH / 2, -137), mats.wall, null, true, true);
    box('front-door-right', new BABYLON.Vector3(232, wallH, 5), new BABYLON.Vector3(209, wallH / 2, -137), mats.wall, null, true, true);
    box('front-glass', new BABYLON.Vector3(152, 62, 4), new BABYLON.Vector3(0, 37, -138), mats.glass, null, false, true);

    createRoof(690, 302, wallH, 146);
    createFrame(650, 270, wallH, 146);
    createMachines();
    createFlowGuides();
  }

  function createRoof(width, depth, wallH, ridgeH) {
    var hw = width / 2;
    var hd = depth / 2;
    var positions = [
      -hw, wallH, -hd, 0, ridgeH, -hd, 0, ridgeH, hd, -hw, wallH, hd,
      hw, wallH, -hd, 0, ridgeH, -hd, 0, ridgeH, hd, hw, wallH, hd
    ];
    var indices = [0, 1, 2, 0, 2, 3, 4, 7, 6, 4, 6, 5];
    var normals = [];
    BABYLON.VertexData.ComputeNormals(positions, indices, normals);

    var mesh = new BABYLON.Mesh('gable-roof', scene);
    var data = new BABYLON.VertexData();
    data.positions = positions;
    data.indices = indices;
    data.normals = normals;
    data.uvs = [
      0, 0, 1, 0, 1, 1, 0, 1,
      0, 0, 1, 0, 1, 1, 0, 1
    ];
    data.applyToMesh(mesh);
    mesh.material = pbr('roof-material', {
      color: activeStyle === 'tech' ? '#1b252e' : '#aeb6b6',
      metallic: activeStyle === 'tech' ? 0.46 : 0.18,
      roughness: activeStyle === 'tech' ? 0.25 : 0.48,
      alpha: activeStyle === 'tech' ? 0.12 : 0.48
    });
    mesh.isPickable = false;
    mesh.checkCollisions = true;
    addShadow(mesh, true, true);

    box('roof-ridge', new BABYLON.Vector3(18, 8, depth + 14), new BABYLON.Vector3(0, ridgeH + 2, 0), mats.steel, null, true, true);
  }

  function createFrame(width, depth, wallH, ridgeH) {
    var xs = [-width / 2 + 36, -width / 6, width / 6, width / 2 - 36];
    xs.forEach(function (x) {
      box('steel-column-l-' + x, new BABYLON.Vector3(8, wallH, 8), new BABYLON.Vector3(x, wallH / 2, -depth / 2 + 18), mats.steel, null, true, true);
      box('steel-column-r-' + x, new BABYLON.Vector3(8, wallH, 8), new BABYLON.Vector3(x, wallH / 2, depth / 2 - 18), mats.steel, null, true, true);
    });

    [-depth / 2 + 18, 0, depth / 2 - 18].forEach(function (z) {
      box('cross-beam-' + z, new BABYLON.Vector3(width - 62, 6, 8), new BABYLON.Vector3(0, wallH + 3, z), mats.steel, null, true, true);
      box('ridge-truss-' + z, new BABYLON.Vector3(10, 5, 8), new BABYLON.Vector3(0, ridgeH - 8, z), mats.steel, null, true, true);
    });
  }

  function createMachines() {
    var machineMat = pbr('machine-body', { color: activeStyle === 'tech' ? '#273039' : '#7b8789', metallic: 0.36, roughness: 0.42 });
    var accentMat = pbr('machine-accent', { color: activeStyle === 'tech' ? '#1f3b36' : '#8da59d', metallic: 0.12, roughness: 0.48 });

    [-250, -170, -90, 80, 165, 250].forEach(function (x, idx) {
      var z = idx < 3 ? -112 : -108;
      var root = new BABYLON.TransformNode('machine-root-' + idx, scene);
      box('machine-base-' + idx, new BABYLON.Vector3(52, 20, 30), new BABYLON.Vector3(x, 11, z), machineMat, root, true, true);
      box('machine-screen-' + idx, new BABYLON.Vector3(22, 14, 2), new BABYLON.Vector3(x, 24, z - 15.8), accentMat, root, false, true);
    });

    [-268, -192, -116, 100, 178, 256].forEach(function (x, idx) {
      box('rack-' + idx, new BABYLON.Vector3(46, 48, 18), new BABYLON.Vector3(x, 24, 105), machineMat, null, true, true);
    });
  }

  function createFlowGuides() {
    for (var i = 0; i < 12; i++) {
      var mat = standard('flow-mat-' + i, {
        color: '#35e6a8',
        emissive: '#35e6a8',
        alpha: 0.18 + (i % 3) * 0.05
      });
      var strip = box(
        'flow-strip-' + i,
        new BABYLON.Vector3(28, 0.8, 3.4),
        new BABYLON.Vector3(-300 + i * 55, 2.8, 18),
        mat,
        null,
        false,
        false
      );
      strip.checkCollisions = false;
      flowStrips.push(strip);
    }
  }

  function createDevice(device) {
    var root = new BABYLON.TransformNode('device-' + device.id, scene);
    root.position = new BABYLON.Vector3(device.x, 0, device.z);
    root.metadata = { deviceId: device.id };

    var meshes = [];
    var fanRotor = null;
    var lampMat = standard('device-light-' + device.id, {
      color: device.color,
      emissive: device.on ? device.color : '#101214',
      alpha: device.on ? 0.96 : 0.48
    });
    var haloMat = standard('device-halo-' + device.id, {
      color: device.color,
      emissive: device.color,
      alpha: device.on ? 0.28 : 0.0
    });

    if (device.type === 'lamp') {
      meshes.push(cylinder('lamp-wire-' + device.id, { height: 34, diameter: 2.6, tessellation: 12 }, new BABYLON.Vector3(0, 82, 0), mats.steel, root, true, false));
      meshes.push(cylinder('lamp-shade-' + device.id, { height: 10, diameterTop: 22, diameterBottom: 34, tessellation: 32 }, new BABYLON.Vector3(0, 62, 0), mats.dark, root, true, true));
      var bulb = BABYLON.MeshBuilder.CreateSphere('lamp-bulb-' + device.id, { diameter: 18, segments: 24 }, scene);
      bulb.position = new BABYLON.Vector3(0, 54, 0);
      bulb.material = lampMat;
      bulb.parent = root;
      meshes.push(addShadow(bulb, false, false));

      var halo = BABYLON.MeshBuilder.CreateSphere('lamp-halo-' + device.id, { diameter: 54, segments: 24 }, scene);
      halo.position = new BABYLON.Vector3(0, 53, 0);
      halo.material = haloMat;
      halo.parent = root;
      halo.isPickable = false;
      meshes.push(halo);
    } else if (device.type === 'fan') {
      meshes.push(cylinder('fan-rod-' + device.id, { height: 40, diameter: 3, tessellation: 12 }, new BABYLON.Vector3(0, 86, 0), mats.steel, root, true, false));
      fanRotor = new BABYLON.TransformNode('fan-rotor-' + device.id, scene);
      fanRotor.position = new BABYLON.Vector3(0, 60, 0);
      fanRotor.parent = root;
      var hub = cylinder('fan-hub-' + device.id, { height: 9, diameter: 16, tessellation: 24 }, new BABYLON.Vector3(0, 0, 0), mats.dark, fanRotor, true, false);
      hub.rotation.x = Math.PI / 2;
      meshes.push(hub);
      for (var i = 0; i < 4; i++) {
        var blade = box('fan-blade-' + device.id + '-' + i, new BABYLON.Vector3(46, 3.6, 10), new BABYLON.Vector3(26, 0, 0), mats.steel, fanRotor, true, false);
        blade.rotation.y = i * Math.PI / 2;
        meshes.push(blade);
      }
      var fanRing = BABYLON.MeshBuilder.CreateTorus('fan-ring-' + device.id, { diameter: 102, thickness: 1.8, tessellation: 80 }, scene);
      fanRing.position = new BABYLON.Vector3(0, 60, 0);
      fanRing.rotation.x = Math.PI / 2;
      fanRing.material = haloMat;
      fanRing.parent = root;
      fanRing.isPickable = false;
      meshes.push(fanRing);
      animatedFans.push({ rotor: fanRotor, device: device });
    } else {
      meshes.push(box('panel-body-' + device.id, new BABYLON.Vector3(36, 62, 14), new BABYLON.Vector3(0, 31, 0), mats.dark, root, true, true));
      meshes.push(box('panel-door-' + device.id, new BABYLON.Vector3(31, 46, 2), new BABYLON.Vector3(0, 34, -7.2), mats.steel, root, true, true));
      var signal = BABYLON.MeshBuilder.CreateSphere('panel-signal-' + device.id, { diameter: 10, segments: 18 }, scene);
      signal.position = new BABYLON.Vector3(0, 52, -9);
      signal.material = lampMat;
      signal.parent = root;
      meshes.push(addShadow(signal, false, false));
    }

    meshes.forEach(function (mesh) {
      assignPick(mesh, device.id);
    });

    var label = createLabel(device);
    label.parent = root;
    label.position = new BABYLON.Vector3(0, device.type === 'panel' ? 78 : 102, 0);

    var light = new BABYLON.PointLight('device-point-' + device.id, new BABYLON.Vector3(0, device.type === 'panel' ? 52 : 53, 0), scene);
    light.parent = root;
    light.diffuse = color3(device.color);
    light.specular = color3(device.color);
    light.range = device.type === 'lamp' ? 118 : 82;
    light.intensity = device.on ? (device.type === 'lamp' ? 1.8 : 0.9) : 0;

    deviceMap[device.id] = {
      device: device,
      root: root,
      meshes: meshes,
      label: label,
      light: light,
      lampMat: lampMat,
      haloMat: haloMat,
      fanRotor: fanRotor
    };

    updateDeviceVisual(device.id);
  }

  function createLabel(device) {
    var tex = new BABYLON.DynamicTexture('label-tex-' + device.id, { width: 420, height: 142 }, scene, false);
    tex.hasAlpha = true;
    var mat = new BABYLON.StandardMaterial('label-mat-' + device.id, scene);
    mat.diffuseTexture = tex;
    mat.emissiveTexture = tex;
    mat.opacityTexture = tex;
    mat.backFaceCulling = false;
    mat.disableLighting = true;

    var plane = BABYLON.MeshBuilder.CreatePlane('label-' + device.id, { width: 74, height: 25 }, scene);
    plane.material = mat;
    plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
    plane.isPickable = false;
    plane.metadata = { labelTexture: tex };
    return plane;
  }

  function drawLabel(entry) {
    var tex = entry.label.metadata.labelTexture;
    var ctx = tex.getContext();
    var d = entry.device;
    ctx.clearRect(0, 0, 420, 142);
    ctx.fillStyle = d.on ? 'rgba(12,22,20,0.82)' : 'rgba(16,18,20,0.72)';
    roundRect(ctx, 12, 12, 396, 118, 18);
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = d.on ? d.color : 'rgba(255,255,255,0.18)';
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = '700 34px Microsoft YaHei, sans-serif';
    ctx.fillText(d.name, 28, 60);
    ctx.fillStyle = d.on ? d.color : '#9aa2aa';
    ctx.font = '700 23px Microsoft YaHei, sans-serif';
    ctx.fillText(d.group + ' / ' + (d.on ? 'ON' : 'OFF'), 28, 101);
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

  function updateDeviceVisual(id) {
    var entry = deviceMap[id];
    if (!entry) return;
    var d = entry.device;
    entry.lampMat.emissiveColor = color3(d.on ? d.color : '#0f1114');
    entry.lampMat.diffuseColor = color3(d.on ? d.color : '#3b4248');
    entry.lampMat.alpha = d.on ? 0.98 : 0.54;
    entry.haloMat.emissiveColor = color3(d.color);
    entry.haloMat.diffuseColor = color3(d.color);
    entry.haloMat.alpha = d.on ? 0.30 : 0.0;
    entry.light.intensity = d.on ? (d.type === 'lamp' ? 1.8 : 0.9) : 0;
    drawLabel(entry);
  }

  function toggleDevice(id) {
    var entry = deviceMap[id];
    if (!entry) return;
    entry.device.on = !entry.device.on;
    updateDeviceVisual(id);
    selectDevice(id);
    renderDeviceList();
    updateMetrics();
  }

  function selectDevice(id) {
    selectedId = id;
    selectedMeshes.forEach(function (mesh) {
      highlight.removeMesh(mesh);
    });
    selectedMeshes = [];

    var entry = deviceMap[id];
    if (entry) {
      entry.meshes.forEach(function (mesh) {
        highlight.addMesh(mesh, color3('#35e6a8'));
        selectedMeshes.push(mesh);
      });
      document.getElementById('selected-device').textContent =
        entry.device.name + ' / ' + entry.device.group + ' / ' + (entry.device.on ? '已开启' : '已关闭');
      orbitCamera.setTarget(new BABYLON.Vector3(entry.device.x, 40, entry.device.z));
    } else {
      document.getElementById('selected-device').textContent = '选择一个灯具或设备查看状态';
    }

    renderDeviceList();
  }

  function renderDeviceList() {
    var list = document.getElementById('device-list');
    list.innerHTML = '';
    devices.forEach(function (device) {
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'device-row' + (device.on ? '' : ' is-off') + (device.id === selectedId ? ' is-selected' : '');
      row.innerHTML =
        '<div class="device-row-main">' +
          '<div class="device-name">' + escapeHtml(device.name) + '</div>' +
          '<div class="device-state">' + (device.on ? 'ON' : 'OFF') + '</div>' +
        '</div>' +
        '<div class="device-meta">' + escapeHtml(device.group) + ' · ' + escapeHtml(device.id) + ' · 点击切换</div>';
      row.addEventListener('click', function () {
        toggleDevice(device.id);
      });
      list.appendChild(row);
    });
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function updateMetrics() {
    var on = devices.filter(function (d) { return d.on; }).length;
    document.getElementById('metric-on').textContent = on;
    document.getElementById('metric-off').textContent = devices.length - on;
  }

  function setPbrSurface(mat, color, alpha) {
    if (!mat) return;
    mat.albedoColor = color3(color);
    if (alpha != null) mat.alpha = alpha;
  }

  function applyStyleMaterials(style) {
    var p = palette[style];
    setPbrSurface(mats.outdoor, p.ground);
    setPbrSurface(mats.wall, p.wall, style === 'tech' ? 0.28 : 0.72);
    setPbrSurface(mats.glass, '#a9d7d7', style === 'tech' ? 0.18 : 0.42);
    setPbrSurface(mats.steel, p.steel);
    setPbrSurface(mats.dark, style === 'tech' ? '#171b20' : '#5d676b');
    setPbrSurface(mats.path, style === 'tech' ? '#19332f' : '#9aa7a2');
    setPbrSurface(mats.zone, style === 'tech' ? '#183039' : '#b9c2c0', style === 'tech' ? 0.44 : 0.64);

    var floor = scene.getMeshByName('factory-floor');
    if (floor) {
      var oldGrid = mats.grid;
      mats.grid = makeGridMaterial('grid-' + style + '-' + Date.now(), style);
      floor.material = mats.grid;
      if (oldGrid && oldGrid.dispose) oldGrid.dispose();
    }

    var roofMat = scene.getMaterialByName('roof-material');
    if (roofMat) {
      setPbrSurface(roofMat, style === 'tech' ? '#1b252e' : '#aeb6b6', style === 'tech' ? 0.12 : 0.48);
    }
  }

  function setStyle(style) {
    if (style === activeStyle) return;
    activeStyle = style;

    scene.clearColor = palette[style].clear;
    scene.fogColor = palette[style].fog;
    scene.fogDensity = style === 'tech' ? 0.0012 : 0.0009;
    hemi.intensity = style === 'tech' ? 0.56 : 0.68;
    keyLight.intensity = style === 'tech' ? 2.55 : 1.65;
    glow.intensity = style === 'tech' ? 0.58 : 0.42;
    if (pipeline) {
      pipeline.bloomWeight = style === 'tech' ? 0.34 : 0.24;
      pipeline.bloomThreshold = style === 'tech' ? 0.62 : 0.76;
    }
    applyStyleMaterials(style);

    document.getElementById('style-tech').classList.toggle('is-active', style === 'tech');
    document.getElementById('style-soft').classList.toggle('is-active', style === 'soft');
  }

  function toggleCameraMode() {
    var btn = document.getElementById('camera-mode');
    if (scene.activeCamera === orbitCamera) {
      orbitCamera.detachControl(canvas);
      scene.activeCamera = walkCamera;
      walkCamera.attachControl(canvas, true);
      btn.textContent = '切换环绕';
      btn.classList.add('is-active');
      canvas.focus();
    } else {
      walkCamera.detachControl(canvas);
      scene.activeCamera = orbitCamera;
      orbitCamera.attachControl(canvas, true);
      btn.textContent = '切换漫游';
      btn.classList.remove('is-active');
    }
  }

  function findPickedDevice(mesh) {
    var node = mesh;
    while (node) {
      if (node.metadata && node.metadata.deviceId) return node.metadata.deviceId;
      node = node.parent;
    }
    return null;
  }

  createFactory();
  devices.forEach(createDevice);
  renderDeviceList();
  updateMetrics();

  scene.onPointerObservable.add(function (pointerInfo) {
    if (pointerInfo.type !== BABYLON.PointerEventTypes.POINTERPICK) return;
    var pick = pointerInfo.pickInfo;
    if (!pick || !pick.hit || !pick.pickedMesh) return;
    var id = findPickedDevice(pick.pickedMesh);
    if (id) toggleDevice(id);
  });

  document.getElementById('style-tech').addEventListener('click', function () {
    setStyle('tech');
  });
  document.getElementById('style-soft').addEventListener('click', function () {
    setStyle('soft');
  });
  document.getElementById('camera-mode').addEventListener('click', toggleCameraMode);

  engine.runRenderLoop(function () {
    var dt = engine.getDeltaTime() / 1000;
    animatedFans.forEach(function (item) {
      if (item.device.on) item.rotor.rotation.y += dt * 5.8;
    });
    flowStrips.forEach(function (strip, idx) {
      strip.position.x += dt * (22 + idx * 0.18);
      if (strip.position.x > 330) strip.position.x = -330;
      var alpha = 0.11 + 0.16 * (0.5 + Math.sin(performance.now() * 0.002 + idx) * 0.5);
      if (strip.material) strip.material.alpha = activeStyle === 'tech' ? alpha : alpha * 0.45;
    });
    scene.render();
  });

  var fpsEl = document.getElementById('metric-fps');
  setInterval(function () {
    fpsEl.textContent = Math.round(engine.getFps());
  }, 500);

  window.addEventListener('resize', function () {
    engine.resize();
  });
})();
