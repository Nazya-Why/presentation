/* Хореографія світіння: фон по черзі програє сцени, між ними плавно перетікає.
   У кожній сцені 4 плями. Плями складаються як рідина, тож коли зближуються —
   зливаються в одну, а коли розходяться — розриваються.

   Координати: x 0..1 зліва направо, y 0..1 знизу вгору (можна виходити за межі,
   щоб пляма "виїжджала" з-за краю). r — радіус у частках висоти екрана,
   w — наскільки пляма витягнута по горизонталі, i — яскравість.

   Щоб додати сцену — допиши функцію в SCENES: вона отримує прогрес p (0..1)
   і повертає 4 плями. Подивитися конкретну сцену: index.html?scene=3                                                         */
(() => {
  const SCENE_LEN = 14;   // секунд на сцену
  const BLEND = 3.5;      // секунд на перетікання між сценами

  const clamp01 = x => Math.min(1, Math.max(0, x));
  // плавний крок від a до b
  const S = (a, b, p) => { const t = clamp01((p - a) / (b - a)); return t * t * (3 - 2 * t); };
  const L = (a, b, t) => a + (b - a) * t;
  // рух по точках: [[p, x, y], ...] з м'якими зупинками
  const path = (pts, p) => {
    if (p <= pts[0][0]) return [pts[0][1], pts[0][2]];
    for (let k = 1; k < pts.length; k++) {
      const [p1, x1, y1] = pts[k];
      const [p0, x0, y0] = pts[k - 1];
      if (p <= p1) {
        const e = S(p0, p1, p);
        return [L(x0, x1, e), L(y0, y1, e)];
      }
    }
    const last = pts[pts.length - 1];
    return [last[1], last[2]];
  };
  const B = (x, y, r, i, w = 1) => ({ x, y, r, i, w });
  const NONE = B(0.5, -0.8, 0.2, 0);

  const SCENES = [
    // 1. Естафета з кутів: одна пляма відходить у нижній лівий кут,
    //    з верхнього правого виходить друга, і вони зливаються в центрі.
    function handoff(p) {
      const [ax, ay] = path([[0, 0.45, 0.22], [0.42, 0.06, 0.04], [0.62, 0.1, 0.08], [1, 0.52, 0.24]], p);
      const [bx, by] = path([[0.15, 1.3, 1.25], [0.5, 0.88, 0.82], [1, 0.56, 0.3]], p);
      return [
        B(ax, ay, 0.5, 1, 1.25),
        B(bx, by, 0.42, 0.95 * S(0.12, 0.4, p), 1.15),
        B(0.82, 0.1, 0.2, 0.22),
        NONE,
      ];
    },

    // 2. Спіраль: дві плями кружляють одна навколо одної, сходяться й зливаються.
    function orbit(p) {
      const a = p * Math.PI * 3.2;
      const rad = L(0.34, 0.03, S(0, 0.75, p)) + 0.12 * S(0.85, 1, p);
      const cx = 0.5, cy = 0.34;
      return [
        B(cx + Math.cos(a) * rad * 1.3, cy + Math.sin(a) * rad, 0.38, 0.95),
        B(cx - Math.cos(a) * rad * 1.3, cy - Math.sin(a) * rad, 0.34, 0.85),
        B(0.12, 0.85, 0.18, 0.18 * S(0.3, 0.6, p)),
        NONE,
      ];
    },

    // 3. Схід: широке світло піднімається знизу, розгорається і знову сідає,
    //    угору летять дрібні іскри.
    function sunrise(p) {
      const rise = S(0, 0.5, p) - S(0.65, 1, p);
      const spark = (k, ph) => {
        const q = (p * 1.6 + ph) % 1;
        return B(0.2 + 0.6 * ((k * 0.37 + ph) % 1), L(-0.1, 0.9, q), 0.12, 0.35 * Math.sin(q * Math.PI));
      };
      return [
        B(0.5, L(-0.45, 0.06, rise), L(0.45, 0.62, rise), L(0.6, 1.1, rise), 2.3),
        spark(1, 0.0),
        spark(2, 0.35),
        spark(3, 0.7),
      ];
    },

    // 4. Поділ: одна пляма розривається на дві, вони розлітаються в боки
    //    і знову з'єднуються.
    function split(p) {
      const d = S(0.05, 0.45, p) - S(0.6, 0.95, p);
      const wave = Math.sin(p * Math.PI * 2) * 0.08;
      return [
        B(L(0.5, 0.13, d), 0.28 + wave, 0.42, 0.95, 1.1),
        B(L(0.5, 0.87, d), 0.28 - wave, 0.42, 0.95, 1.1),
        B(0.5, L(0.1, -0.3, d), 0.3, 0.4 * (1 - d)),
        NONE,
      ];
    },

    // 5. Перехрестя: одна пляма летить по діагоналі знизу-зліва вгору-вправо,
    //    друга — знизу-справа вгору-вліво; в центрі вони на мить зливаються.
    function crossing(p) {
      const [ax, ay] = path([[0, -0.3, -0.25], [1, 1.3, 1.15]], p);
      const [bx, by] = path([[0.12, 1.3, -0.25], [1, -0.25, 1.05]], p);
      return [
        B(ax, ay, 0.46, 1, 1.2),
        B(bx, by, 0.42, 0.9, 1.2),
        B(0.5, -0.12, 0.4, 0.35, 2),
        NONE,
      ];
    },

    // 6. Збір: три жарини з трьох країв сходяться в центр і спалахують одним ядром,
    //    потім ядро повільно осідає вниз.
    function gather(p) {
      const c = S(0.05, 0.6, p);
      const sink = S(0.65, 1, p);
      const cy = L(0.4, 0.12, sink);
      return [
        B(L(-0.25, 0.5, c), L(0.55, cy, c), L(0.3, 0.38, c), 0.85),
        B(L(1.25, 0.5, c), L(0.6, cy, c), L(0.3, 0.38, c), 0.85),
        B(L(0.5, 0.5, c), L(-0.35, cy, c), L(0.3, 0.38, c), 0.85),
        B(0.5, cy, 0.6, 0.35 * S(0.45, 0.7, p) * (1 - 0.5 * sink), 1.4),
      ];
    },

    // 7. Мандрівник: одна пляма подорожує по всьому екрану, за нею тягнеться слід.
    function wander(p, t) {
      const pos = tt => [
        0.5 + 0.46 * (0.75 * Math.sin(tt * 0.32) + 0.25 * Math.sin(tt * 0.81 + 1.3)),
        0.32 + 0.4 * (0.7 * Math.sin(tt * 0.25 + 0.8) + 0.3 * Math.sin(tt * 0.63 + 2.6)),
      ];
      const [x0, y0] = pos(t);
      const [x1, y1] = pos(t - 1.6);
      const [x2, y2] = pos(t - 3.2);
      return [B(x0, y0, 0.46, 1, 1.15), B(x1, y1, 0.36, 0.5), B(x2, y2, 0.28, 0.28), NONE];
    },

    // 8. Погоня: дві плями біжать уздовж низу туди-назад, одна наздоганяє іншу
    //    і на поворотах вони зливаються.
    function chase(p) {
      const a = p * Math.PI * 2.4;
      return [
        B(0.5 + 0.5 * Math.sin(a), 0.1 + 0.1 * Math.sin(a * 2), 0.42, 1, 1.3),
        B(0.5 + 0.5 * Math.sin(a - 0.8), 0.12 + 0.12 * Math.sin(a * 2 - 1), 0.36, 0.85, 1.2),
        B(0.5 + 0.5 * Math.sin(a - 1.6), 0.14, 0.26, 0.45),
        NONE,
      ];
    },
  ];

  // живе тремтіння, щоб навіть "нерухомі" плями дихали
  function wobble(b, j, t) {
    return {
      x: b.x + 0.022 * Math.sin(t * 0.7 + j * 2.1),
      y: b.y + 0.018 * Math.sin(t * 0.9 + j * 1.3),
      r: b.r * (1 + 0.06 * Math.sin(t * 0.5 + j)),
      i: b.i,
      w: b.w,
    };
  }

  const mix = (a, b, k) => ({
    x: L(a.x, b.x, k), y: L(a.y, b.y, k), r: L(a.r, b.r, k), i: L(a.i, b.i, k), w: L(a.w, b.w, k),
  });

  // t — час у секундах; повертає 4 плями поточного моменту
  function sample(t) {
    const n = SCENES.length;
    const idx = Math.floor(t / SCENE_LEN);
    const local = t - idx * SCENE_LEN;
    const p = local / SCENE_LEN;
    const curScene = SCENES[idx % n];
    let blobs = curScene(p, t);
    if (local < BLEND && idx > 0) {
      const prev = SCENES[(idx - 1) % n](1, t);
      const k = S(0, 1, local / BLEND);
      blobs = blobs.map((b, j) => mix(prev[j], b, k));
    }
    return blobs.map((b, j) => wobble(b, j, t));
  }

  window.GlowScenes = { sample, SCENE_LEN, names: SCENES.map(f => f.name) };
})();
