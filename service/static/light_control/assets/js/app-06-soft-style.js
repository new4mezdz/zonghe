/* =============================================================================
 * app-06-soft-style.js  —  "Q弹 / 软乎乎" 风格档位 (Soft / jelly style overlay)
 * -----------------------------------------------------------------------------
 * 独立、可一键开关的后处理模块。不改任何核心/模型代码:
 *   - 把结构件的盒子几何换成「圆角盒」(自带解析法线 -> 无接缝、平滑圆角)
 *   - 把不透明结构材质改成哑光黏土质感 (metalness->0, roughness 抬高)
 *   - 加一盏柔和半球补光,填暗部 -> 体积更"鼓"、阴影更软
 *
 * 安全性 (依据场景侦察):
 *   - 只动 MeshStandardMaterial、不透明、NormalBlending、可见的结构网格
 *   - 绝不碰: 发光/Additive、Sprite、地面贴花(MeshBasic透明)、描边线、隐藏拾取盒
 *   - 换几何保留 position/rotation/userData,缓存原始几何 -> 可无损还原
 *   - 共享材质只软化一次 (in-place),每网格几何独立缓存
 *   - 幂等: 重复 apply 只处理新出现的网格/材质
 *
 * 控制台 API:  SoftStyle.toggle() / .on() / .off() / .refresh()
 *              SoftStyle.setStrength(0~1)   // 圆角强度
 *              SoftStyle.setRoughness(0~1)  // 哑光程度
 * ========================================================================== */
(function () {
  'use strict';

  if (typeof THREE === 'undefined' || typeof scene === 'undefined') {
    console.warn('[SoftStyle] THREE / scene 未就绪,模块未启动');
    return;
  }

  // ---- 可调参数 -------------------------------------------------------------
  const cfg = {
    enabled: true,        // 默认开 (用户想直接看到效果),想默认关改成 false
    roundFactor: 0.22,    // 圆角半径 = roundFactor * 最短边 * strengthScale
    strengthScale: 1.0,   // 全局圆角倍率 (setStrength 调)
    segments: 4,          // 圆角细分,越大越圆滑也越重 (3~6 合适)
    minRoundDim: 0.2,     // 最短边小于此值不圆角 (薄板/细杆没必要)
    maxRoundDim: 60,      // 最长边大于此值不圆角 (跳过巨大地面/平台)
    minRoughness: 0.8,    // 哑光下限
    maxMetalness: 0.0,    // 金属度上限 (强制非金属)
    fillIntensity: 0.3,   // 半球补光强度
    // 地面 (亮白带蓝 + 微反光,模拟"智慧城市"风格地坪)
    floor: true,
    floorIndoor: 0xeaf0fb,   // 室内地坪 (亮冷白)
    floorOutdoor: 0xd3ddee,  // 室外平台/路面 (略深的冷调)
    floorRoughness: 0.26,    // 低糙度 -> 柔和反光
    floorMetalness: 0.18,
    floorClean: true,        // 去掉原环氧纹理 -> 更干净
    floorReflect: 0.5,       // 环境反光强度 (0 = 关闭反光)
  };

  // ---- 圆角盒几何 (clamp-and-push + 解析法线,平滑无缝) ----------------------
  function roundedBoxGeometry(w, h, d, radius, seg) {
    radius = Math.min(radius, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4);
    if (!(radius > 0)) return new THREE.BoxGeometry(w, h, d);
    const geo = new THREE.BoxGeometry(w, h, d, seg, seg, seg);
    const pos = geo.attributes.position;
    const nor = geo.attributes.normal;
    const ix = w / 2 - radius, iy = h / 2 - radius, iz = d / 2 - radius;
    const v = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
      c.set(
        Math.max(-ix, Math.min(ix, v.x)),
        Math.max(-iy, Math.min(iy, v.y)),
        Math.max(-iz, Math.min(iz, v.z))
      );
      n.subVectors(v, c);
      const len = n.length();
      if (len > 1e-6) {
        n.multiplyScalar(1 / len);             // 单位法线 (从内壳棱/角径向外 -> 平滑)
        v.copy(c).addScaledVector(n, radius);  // 顶点贴到圆角壳上
        pos.setXYZ(i, v.x, v.y, v.z);
        nor.setXYZ(i, n.x, n.y, n.z);
      }
    }
    pos.needsUpdate = true;
    nor.needsUpdate = true;
    geo.computeBoundingSphere();
    return geo;
  }

  // ---- 分类: 该不该软化这个网格 --------------------------------------------
  function structuralMats(mesh) {
    if (!mesh.isMesh || mesh.isLine || mesh.isLineSegments || mesh.isSprite) return null;
    if (mesh.userData && mesh.userData.softSkip) return null;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const ok = list.filter(function (m) {
      return m && m.isMeshStandardMaterial &&
        m.visible !== false &&
        m.transparent !== true &&
        (m.blending === undefined || m.blending === THREE.NormalBlending) &&
        !(m.userData && m.userData.renderOrder !== undefined); // 地面贴花有 renderOrder
    });
    return ok.length ? ok : null;
  }

  // ---- 材质软化 (共享材质只存一次原值) --------------------------------------
  function softenMat(m) {
    if (m.userData.__softSaved === undefined) {
      m.userData.__softSaved = { metalness: m.metalness, roughness: m.roughness };
    }
    const s = m.userData.__softSaved;
    m.metalness = Math.min(s.metalness, cfg.maxMetalness);
    m.roughness = Math.max(s.roughness, cfg.minRoughness);
    m.needsUpdate = true;
  }
  function restoreMat(m) {
    const s = m.userData && m.userData.__softSaved;
    if (s) { m.metalness = s.metalness; m.roughness = s.roughness; m.needsUpdate = true; }
  }

  // ---- 几何圆角 (缓存原始几何,可还原;再开瞬切回缓存的圆角几何) ------------
  function roundMesh(mesh) {
    const g = mesh.geometry;
    if (!g || g.type !== 'BoxGeometry' || !g.parameters) return;
    if (mesh.userData.__roundGeom) { mesh.geometry = mesh.userData.__roundGeom; return; }
    const w = g.parameters.width, h = g.parameters.height, d = g.parameters.depth;
    const mn = Math.min(w, h, d), mx = Math.max(w, h, d);
    if (mn < cfg.minRoundDim || mx > cfg.maxRoundDim) return;
    const r = Math.min(cfg.roundFactor * mn * cfg.strengthScale, 0.5 * mn - 1e-3);
    if (!(r > 1e-3)) return;
    mesh.userData.__origGeom = g;
    mesh.userData.__roundGeom = roundedBoxGeometry(w, h, d, r, cfg.segments);
    mesh.geometry = mesh.userData.__roundGeom;
  }
  function restoreGeom(mesh) {
    if (mesh.userData && mesh.userData.__origGeom) mesh.geometry = mesh.userData.__origGeom;
  }

  // ---- 地面: 亮白带蓝 + 柔和环境反光 ----------------------------------------
  let _floorEnv = null;
  function floorEnv() {
    if (_floorEnv) return _floorEnv;
    const cv = document.createElement('canvas');
    cv.width = 8; cv.height = 128;
    const ctx = cv.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 128);   // 竖向渐变: 顶白 -> 底蓝
    g.addColorStop(0.0, '#ffffff');
    g.addColorStop(0.5, '#e2ebfb');
    g.addColorStop(1.0, '#aebfe0');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 8, 128);
    _floorEnv = new THREE.CanvasTexture(cv);
    _floorEnv.mapping = THREE.EquirectangularReflectionMapping;
    return _floorEnv;
  }
  function isFloorPlane(mesh) {
    if (!mesh.isMesh || Array.isArray(mesh.material)) return false;
    const g = mesh.geometry, m = mesh.material;
    if (!g || g.type !== 'PlaneGeometry') return false;
    return m && m.isMeshStandardMaterial && m.visible !== false && m.transparent !== true &&
      (m.blending === undefined || m.blending === THREE.NormalBlending) &&
      !(m.userData && m.userData.renderOrder !== undefined); // 排除地面贴花(那是透明MeshBasic)
  }
  function applyFloor(mesh) {
    const m = mesh.material;
    if (m.userData.__floorSaved === undefined) {
      m.userData.__floorSaved = {
        color: m.color.getHex(), roughness: m.roughness, metalness: m.metalness,
        map: m.map || null, envMap: m.envMap || null, envMapIntensity: m.envMapIntensity,
      };
    }
    const oc = new THREE.Color(m.userData.__floorSaved.color);
    const lum = 0.299 * oc.r + 0.587 * oc.g + 0.114 * oc.b;   // 亮=室内地坪, 暗=室外平台
    m.color.setHex(lum > 0.5 ? cfg.floorIndoor : cfg.floorOutdoor);
    m.roughness = cfg.floorRoughness;
    m.metalness = cfg.floorMetalness;
    if (cfg.floorClean) m.map = null;
    if (cfg.floorReflect > 0) { m.envMap = floorEnv(); m.envMapIntensity = cfg.floorReflect; }
    else { m.envMap = null; }
    m.needsUpdate = true;
  }
  function restoreFloor(m) {
    const s = m.userData && m.userData.__floorSaved;
    if (!s) return;
    m.color.setHex(s.color); m.roughness = s.roughness; m.metalness = s.metalness;
    m.map = s.map; m.envMap = s.envMap; m.envMapIntensity = s.envMapIntensity;
    m.needsUpdate = true;
  }

  // ---- 柔和补光 (开时加,关时移除 -> 可无损还原) -----------------------------
  let fillLight = null;
  function addFill() {
    if (fillLight) return;
    fillLight = new THREE.HemisphereLight(0xfff3e6, 0x6b7280, cfg.fillIntensity);
    fillLight.position.set(0, 1, 0);
    fillLight.userData.softSkip = true;
    scene.add(fillLight);
  }
  function removeFill() {
    if (fillLight) { scene.remove(fillLight); fillLight = null; }
  }

  // ---- 遍历应用 / 还原 ------------------------------------------------------
  function applySoft() {
    let meshes = 0, mats = 0;
    const seen = new Set();
    scene.traverse(function (obj) {
      if (cfg.floor && isFloorPlane(obj)) { applyFloor(obj); return; } // 地面单独处理,不做哑光
      const ms = structuralMats(obj);
      if (!ms) return;
      meshes++;
      for (let i = 0; i < ms.length; i++) {
        if (!seen.has(ms[i])) { seen.add(ms[i]); softenMat(ms[i]); mats++; }
      }
      // 仅单材质的盒子做圆角 (多材质盒子的面材质顺序敏感,只软化不圆角)
      if (!Array.isArray(obj.material)) roundMesh(obj);
    });
    addFill();
    return { meshes: meshes, mats: mats };
  }

  function removeSoft() {
    const seen = new Set();
    scene.traverse(function (obj) {
      if (!obj.isMesh) return;
      const list = Array.isArray(obj.material) ? obj.material : [obj.material];
      list.forEach(function (m) { if (m && !seen.has(m)) { seen.add(m); restoreMat(m); restoreFloor(m); } });
      restoreGeom(obj);
    });
    removeFill();
  }

  // ---- 重建钩子 (重建场景/布局后自动重新上风格) -----------------------------
  let pending = null;
  function schedule() {
    if (!cfg.enabled) return;
    if (pending) clearTimeout(pending);
    pending = setTimeout(function () { pending = null; applySoft(); }, 80);
  }
  function wrap(name) {
    const orig = window[name];
    if (typeof orig === 'function' && !orig.__softWrapped) {
      const wrapped = function () {
        const r = orig.apply(this, arguments);
        schedule();
        return r;
      };
      wrapped.__softWrapped = true;
      window[name] = wrapped;
    }
  }
  ['rebuildLamps', 'rebuildFactoryScene', 'rebuildLayoutScene', 'refreshExtLayoutAfterEdit']
    .forEach(wrap);

  // ---- 公开 API -------------------------------------------------------------
  const SoftStyle = {
    on: function () { cfg.enabled = true; const r = applySoft(); console.log('[SoftStyle] ON', r); return r; },
    off: function () { cfg.enabled = false; removeSoft(); console.log('[SoftStyle] OFF'); },
    toggle: function () { return cfg.enabled ? this.off() : this.on(); },
    refresh: function () { if (cfg.enabled) return applySoft(); },
    isOn: function () { return cfg.enabled; },
    setStrength: function (v) { cfg.strengthScale = Math.max(0, +v) || 0; this._rebuild(); },
    setRoughness: function (v) { cfg.minRoughness = Math.max(0, Math.min(1, +v)); this.refresh(); },
    setFloorColor: function (indoorHex, outdoorHex) {
      if (indoorHex != null) cfg.floorIndoor = (typeof indoorHex === 'string') ? parseInt(indoorHex.replace('#', ''), 16) : indoorHex;
      if (outdoorHex != null) cfg.floorOutdoor = (typeof outdoorHex === 'string') ? parseInt(outdoorHex.replace('#', ''), 16) : outdoorHex;
      this.refresh();
    },
    setFloorReflect: function (v) { cfg.floorReflect = Math.max(0, +v) || 0; this.refresh(); },
    floorOff: function () { cfg.floor = false; scene.traverse(function (o) { if (o.material && o.material.userData && o.material.userData.__floorSaved) restoreFloor(o.material); }); },
    setSegments: function (v) { cfg.segments = Math.max(1, v | 0); this._rebuild(); },
    config: cfg,
    // 改了圆角相关参数后需丢弃缓存的圆角几何重建
    _rebuild: function () {
      scene.traverse(function (o) {
        if (o.userData && o.userData.__roundGeom) {
          if (o.geometry === o.userData.__roundGeom && o.userData.__origGeom) o.geometry = o.userData.__origGeom;
          o.userData.__roundGeom.dispose();
          delete o.userData.__roundGeom;
        }
      });
      if (cfg.enabled) applySoft();
    },
  };
  window.SoftStyle = SoftStyle;

  // ---- 初始应用 (loadConfig 异步建场景,无完成事件 -> 多次重试,幂等) --------
  if (cfg.enabled) {
    [200, 600, 1200, 2500].forEach(function (t) {
      setTimeout(function () { if (cfg.enabled) applySoft(); }, t);
    });
  }
  console.log('[SoftStyle] 已就绪 — SoftStyle.toggle() 开关,SoftStyle.setStrength(1.5) 调圆角');
})();
