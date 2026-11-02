/* Фон презентації — усе в одному WebGL-canvas, щоб браузеру не доводилось
   змішувати кілька повноекранних шарів щокадру:
     1) світіння (жар) — рахується в низькій роздільності, воно й так розмите;
     2) великі сірі слова з blend "luminosity" — з готових текстур;
     3) віньєтка і плівкове зерно.

   Світіння: головна пляма стоїть там, куди її поставив слайд (data-glow), але
   постійно "дихає" й блукає, а дві менші жарини мандрують екраном самі по собі.

   API:
     Bg.set({x, y, sx, sy, i})        — куди тягнеться головна пляма
     Bg.setWords(top, bottom, strong) — великі слова (strong=false робить їх тихішими)
     Bg.prewarm([[top, bottom], ...]) — заздалегідь підготувати текстури слів        */
(() => {
  const canvas = document.getElementById('bg');
  const gl = canvas.getContext('webgl', {
    antialias: false, alpha: false, depth: false, stencil: false,
    premultipliedAlpha: false, powerPreference: 'high-performance',
  });

  const target = { x: 0.5, y: -0.2, sx: 1.2, sy: 0.5, i: 1.05, dim: 1 };
  const state = { ...target };
  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };

  const api = { set() {}, setWords() {}, prewarm() {} };
  window.Bg = api;

  if (!gl) {
    document.documentElement.classList.add('no-webgl');
    return;
  }

  /* ---------------- шейдери ---------------- */
  const vert = `
    attribute vec2 p;
    void main() { gl_Position = vec4(p, 0.0, 1.0); }
  `;

  const glowFrag = `
    precision highp float;
    uniform vec2 u_res;
    uniform float u_time;
    uniform vec2 u_g0; uniform vec2 u_s0; uniform float u_i0;
    uniform vec2 u_g1; uniform vec2 u_s1; uniform float u_i1;
    uniform vec2 u_g2; uniform vec2 u_s2; uniform float u_i2;

    vec3 permute(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
    float snoise(vec2 v) {
      const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
      vec2 i = floor(v + dot(v, C.yy));
      vec2 x0 = v - i + dot(i, C.xx);
      vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
      vec4 x12 = x0.xyxy + C.xxzz;
      x12.xy -= i1;
      i = mod(i, 289.0);
      vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
      vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
      m = m * m; m = m * m;
      vec3 x = 2.0 * fract(p * C.www) - 1.0;
      vec3 h = abs(x) - 0.5;
      vec3 ox = floor(x + 0.5);
      vec3 a0 = x - ox;
      m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
      vec3 g;
      g.x = a0.x * x0.x + h.x * x0.y;
      g.yz = a0.yz * x12.xz + h.yz * x12.yw;
      return 130.0 * dot(m, g);
    }
    float fbm(vec2 p) {
      float v = 0.0, a = 0.5;
      for (int i = 0; i < 3; i++) { v += a * snoise(p); p *= 2.03; a *= 0.5; }
      return v;
    }

    // чорний -> темно-червоний -> помаранчевий -> жовтий -> майже білий
    vec3 ramp(float t) {
      vec3 c = vec3(0.027, 0.020, 0.018);
      c = mix(c, vec3(0.32, 0.035, 0.012), smoothstep(0.00, 0.26, t));
      c = mix(c, vec3(0.86, 0.17, 0.03),  smoothstep(0.20, 0.46, t));
      c = mix(c, vec3(1.00, 0.52, 0.10),  smoothstep(0.40, 0.66, t));
      c = mix(c, vec3(1.00, 0.84, 0.42),  smoothstep(0.60, 0.86, t));
      c = mix(c, vec3(1.00, 0.97, 0.86),  smoothstep(0.84, 1.10, t));
      return c;
    }

    float blob(vec2 w, vec2 g, vec2 s, float asp) {
      vec2 d = (w - vec2(g.x * asp, g.y)) / vec2(s.x * asp, s.y);
      return dot(d, d);
    }

    void main() {
      vec2 uv = gl_FragCoord.xy / u_res;
      float asp = u_res.x / u_res.y;
      float t = u_time;
      vec2 p = vec2(uv.x * asp, uv.y);

      vec2 q = vec2(fbm(p * 1.2 + vec2(0.0, t * 0.04)), fbm(p * 1.2 + vec2(3.7, -t * 0.035)));
      vec2 w = p + q * 0.13;
      float flick = 0.88 + 0.22 * fbm(vec2(w.x * 1.5, w.y * 1.2 - t * 0.08));

      float r0 = blob(w, u_g0, u_s0, asp);
      float v = (exp(-r0 * 1.4) * flick + 0.1 * exp(-r0 * 0.4)) * u_i0;
      v += exp(-blob(w, u_g1, u_s1, asp) * 1.4) * flick * u_i1;
      v += exp(-blob(w, u_g2, u_s2, asp) * 1.4) * flick * u_i2;

      gl_FragColor = vec4(ramp(v), 1.0);
    }
  `;

  const compFrag = `
    precision highp float;
    uniform vec2 u_res;
    uniform float u_dpr;
    uniform float u_seed;
    uniform float u_dim;
    uniform sampler2D u_glow;
    uniform sampler2D u_ta; uniform sampler2D u_ba; uniform vec3 u_a;
    uniform sampler2D u_tb; uniform sampler2D u_bb; uniform vec3 u_b;
    uniform vec2 u_texelA; uniform vec2 u_texelB;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
    vec3 clipColor(vec3 c) {
      float l = lum(c);
      float n = min(min(c.r, c.g), c.b);
      float x = max(max(c.r, c.g), c.b);
      if (n < 0.0) c = l + (c - l) * l / (l - n);
      if (x > 1.0) c = l + (c - l) * (1.0 - l) / (x - l);
      return c;
    }
    vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }

    // s = (непрозорість, розмиття 0..1, зсув назовні у частках висоти)
    float word(sampler2D t, sampler2D b, vec3 s, vec2 texel, vec2 uv) {
      if (s.x < 0.002) return 0.0;
      float side = uv.y > 0.5 ? 1.0 : -1.0;
      vec2 p = uv - vec2(0.0, s.z * side);
      float a = texture2D(t, p).a;
      if (s.y > 0.002) {
        float bl = 0.25 * (
          texture2D(b, p + vec2( texel.x,  texel.y)).a +
          texture2D(b, p + vec2(-texel.x,  texel.y)).a +
          texture2D(b, p + vec2( texel.x, -texel.y)).a +
          texture2D(b, p - texel).a);
        a = mix(a, bl, s.y);
      }
      return a * s.x;
    }

    void main() {
      vec2 uv = gl_FragCoord.xy / u_res;
      float asp = u_res.x / u_res.y;
      vec3 col = texture2D(u_glow, uv).rgb;

      vec2 vv = (uv - 0.5) * vec2(asp, 1.0);
      col *= 1.0 - 0.38 * smoothstep(0.35, 1.25, length(vv));

      // великі слова: сірий #616161 у режимі luminosity —
      // на чорному сірі, на жару темно-коричневі
      float a = word(u_ta, u_ba, u_a, u_texelA, uv);
      float b = word(u_tb, u_bb, u_b, u_texelB, uv);
      float ta = 1.0 - (1.0 - a) * (1.0 - b);
      col = mix(col, setLum(col, 0.38), ta * u_dim);

      // плівкове зерно (overlay), зерно ~1 CSS-піксель
      float g = hash(floor(gl_FragCoord.xy / u_dpr) + u_seed * 17.31);
      vec3 ov = mix(2.0 * col * g, 1.0 - 2.0 * (1.0 - col) * (1.0 - g), step(0.5, col));
      col = mix(col, ov, 0.075);

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function program(fragSrc) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vert));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragSrc));
    gl.bindAttribLocation(p, 0, 'p');
    gl.linkProgram(p);
    const uniforms = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(p, i).name;
      uniforms[name] = gl.getUniformLocation(p, name);
    }
    return { p, u: uniforms };
  }

  const glowProg = program(glowFrag);
  const compProg = program(compFrag);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  function makeTex() {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

  // порожня текстура для слотів без слів
  const empty = makeTex();
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.ALPHA, 1, 1, 0, gl.ALPHA, gl.UNSIGNED_BYTE, new Uint8Array([0]));
  const EMPTY = { t: empty, b: empty, texel: [0, 0] };

  /* ---------------- роздільність і якість ---------------- */
  // Якщо пристрій не встигає, автоматично знижуємо роздільність (непомітно для ока).
  const LEVELS = [
    { dpr: Math.min(devicePixelRatio || 1, 2), glow: 0.4 },
    { dpr: Math.min(devicePixelRatio || 1, 1.5), glow: 0.33 },
    { dpr: 1, glow: 0.26 },
  ];
  let level = 0;
  const glowTex = makeTex();
  const fbo = gl.createFramebuffer();
  let gw = 2, gh = 2;

  function resize() {
    const q = LEVELS[level];
    canvas.width = Math.max(2, Math.round(innerWidth * q.dpr));
    canvas.height = Math.max(2, Math.round(innerHeight * q.dpr));
    gw = Math.max(2, Math.round(innerWidth * q.glow));
    gh = Math.max(2, Math.round(innerHeight * q.glow));
    gl.bindTexture(gl.TEXTURE_2D, glowTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gw, gh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, glowTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /* ---------------- текстури слів ---------------- */
  const TEXT_DPR = Math.min(devicePixelRatio || 1, 1.5);
  const cache = new Map();
  let fontFamily = '';

  function frameH() {
    return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--frame-h')) || 64;
  }

  function drawLine(ctx, text, maxSize, baselineOf) {
    if (!text) return;
    const spacing = -0.055;
    const native = 'letterSpacing' in ctx;
    const setFont = size => {
      ctx.font = `700 ${size}px ${fontFamily}`;
      if (native) ctx.letterSpacing = `${spacing * size}px`;
    };
    const chars = [...text];
    const widthAt = size => {
      setFont(size);
      if (native) return ctx.measureText(text).width;
      return chars.reduce((s, c) => s + ctx.measureText(c).width, 0) + spacing * size * (chars.length - 1);
    };

    const size = Math.min((100 * innerWidth * 1.04) / (widthAt(100) || 1), maxSize);
    const w = widthAt(size);
    const y = baselineOf(size);
    if (native) {
      ctx.textAlign = 'center';
      ctx.fillText(text, innerWidth / 2 - (spacing * size) / 2, y);
    } else {
      ctx.textAlign = 'left';
      let x = innerWidth / 2 - w / 2;
      for (const c of chars) {
        ctx.fillText(c, x, y);
        x += ctx.measureText(c).width + spacing * size;
      }
    }
  }

  function buildWords(top, bottom) {
    const key = `${top}|${bottom}`;
    if (cache.has(key)) return cache.get(key);
    if (!top && !bottom) return EMPTY;

    const W = Math.round(innerWidth * TEXT_DPR);
    const H = Math.round(innerHeight * TEXT_DPR);
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');
    ctx.setTransform(TEXT_DPR, 0, 0, TEXT_DPR, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'alphabetic';
    const fh = frameH();
    drawLine(ctx, top, innerHeight * 0.3, s => fh + innerHeight * 0.01 + s * 0.77);
    drawLine(ctx, bottom, innerHeight * 0.26, s => innerHeight - (fh - innerHeight * 0.01) - s * 0.03);

    // розмита копія: послідовне зменшення вдвічі ≈ гаусове розмиття
    let src = c;
    let w = W, h = H;
    while (w > innerWidth / 8) {
      w = Math.max(1, Math.round(w / 2));
      h = Math.max(1, Math.round(h / 2));
      const d = document.createElement('canvas');
      d.width = w;
      d.height = h;
      const dc = d.getContext('2d');
      dc.imageSmoothingQuality = 'high';
      dc.drawImage(src, 0, 0, w, h);
      src = d;
    }

    const t = makeTex();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.ALPHA, gl.ALPHA, gl.UNSIGNED_BYTE, c);
    const b = makeTex();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.ALPHA, gl.ALPHA, gl.UNSIGNED_BYTE, src);
    const entry = { t, b, texel: [1 / w, 1 / h] };
    cache.set(key, entry);
    return entry;
  }

  function clearCache() {
    cache.forEach(e => { gl.deleteTexture(e.t); gl.deleteTexture(e.b); });
    cache.clear();
  }

  /* ---------------- анімація слів ---------------- */
  const ease = t => 1 - Math.pow(1 - t, 4.5);
  const now = () => performance.now() / 1000;

  function slot() {
    return { entry: EMPTY, key: '', op: 0, blur: 1, off: 0, tw: null };
  }
  let cur = slot(), old = slot();

  function tween(s, to, dur, delay) {
    s.tw = { from: { op: s.op, blur: s.blur, off: s.off }, to, dur, start: now() + delay };
  }
  function stepTween(s, t) {
    const tw = s.tw;
    if (!tw) return;
    const k = Math.min(1, Math.max(0, (t - tw.start) / tw.dur));
    const e = ease(k);
    for (const p in tw.to) s[p] = tw.from[p] + (tw.to[p] - tw.from[p]) * e;
    if (k >= 1) s.tw = null;
  }

  let wanted = { top: '', bottom: '' };
  api.setWords = (top = '', bottom = '', strong = true) => {
    target.dim = strong ? 1 : 0.45;
    wanted = { top, bottom };
    const key = `${top}|${bottom}`;
    if (key === cur.key) return;
    // поточні слова йдуть, нові приходять
    [cur, old] = [old, cur];
    tween(old, { op: 0, blur: 1, off: -0.03 }, 0.6, 0);
    Object.assign(cur, { entry: buildWords(top, bottom), key, op: 0, blur: 1, off: 0.045 });
    tween(cur, { op: 1, blur: 0, off: 0 }, 1.25, 0.12);
  };

  // готуємо текстури заздалегідь, по одній, щоб перемикання слайдів було миттєвим
  let warmList = [];
  let allWords = [];
  api.prewarm = list => {
    allWords = list.slice();
    warmList = list.slice();
    const next = () => {
      const item = warmList.shift();
      if (!item) return;
      buildWords(item[0] || '', item[1] || '');
      setTimeout(next, 60);
    };
    setTimeout(next, 400);
  };

  api.set = p => Object.assign(target, p);

  /* ---------------- події ---------------- */
  let resizeT;
  addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => {
      resize();
      clearCache();
      cur.entry = buildWords(wanted.top, wanted.bottom);
      old.op = 0;
      old.entry = EMPTY;
      if (allWords.length) api.prewarm(allWords);
    }, 120);
  });

  addEventListener('pointermove', e => {
    mouse.tx = e.clientX / innerWidth - 0.5;
    mouse.ty = 0.5 - e.clientY / innerHeight;
  }, { passive: true });

  fontFamily = getComputedStyle(document.body).fontFamily;
  resize();

  /* ---------------- кадр ---------------- */
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let last = performance.now();
  let lastDraw = 0;
  let time = 0;
  let slowFrames = 0, sampled = 0;

  function bindWord(s, texUnit, blurUnit, uVec, uTex, uBlur, uTexel) {
    gl.activeTexture(gl.TEXTURE0 + texUnit);
    gl.bindTexture(gl.TEXTURE_2D, s.entry.t);
    gl.activeTexture(gl.TEXTURE0 + blurUnit);
    gl.bindTexture(gl.TEXTURE_2D, s.entry.b);
    gl.uniform1i(uTex, texUnit);
    gl.uniform1i(uBlur, blurUnit);
    gl.uniform3f(uVec, s.op, s.blur, s.off);
    gl.uniform2f(uTexel, s.entry.texel[0], s.entry.texel[1]);
  }

  function frame(ms) {
    requestAnimationFrame(frame);
    // не частіше 60 к/с: на 120 Гц екранах (MacBook Pro, iPhone Pro) це вдвічі менше роботи
    if (ms - lastDraw < 15.5) return;
    lastDraw = ms;

    const dt = Math.min(0.1, (ms - last) / 1000);
    last = ms;
    time += dt * (reduced ? 0.25 : 1);

    // автоякість: якщо кадри стабільно довші за ~24 мс — знижуємо роздільність
    if (!document.hidden && level < LEVELS.length - 1) {
      sampled++;
      if (dt > 0.024) slowFrames++;
      if (sampled >= 90) {
        if (slowFrames > 45) { level++; resize(); }
        sampled = 0;
        slowFrames = 0;
      }
    }

    const k = 1 - Math.exp(-dt * 2.4);
    for (const key in target) state[key] += (target[key] - state[key]) * k;
    const km = 1 - Math.exp(-dt * 3);
    mouse.x += (mouse.tx - mouse.x) * km;
    mouse.y += (mouse.ty - mouse.y) * km;

    const t = time;
    // головна пляма блукає навколо точки слайда і "дихає"
    const g0x = state.x + 0.14 * Math.sin(t * 0.21) + 0.06 * Math.sin(t * 0.47 + 1.7) + mouse.x * 0.05;
    const g0y = state.y + 0.07 * Math.sin(t * 0.26 + 0.6) + 0.03 * Math.sin(t * 0.53 + 2.1) + mouse.y * 0.03;
    const breath = 1 + 0.1 * Math.sin(t * 0.33);
    // дві жарини мандрують екраном
    const g1x = 0.5 + 0.62 * Math.sin(t * 0.083 + 1.0);
    const g1y = -0.02 + 0.26 * Math.sin(t * 0.131 + 0.4);
    const g2x = 0.5 + 0.58 * Math.sin(t * 0.067 + 3.6);
    const g2y = 0.02 + 0.3 * Math.sin(t * 0.097 + 2.2);

    // 1) світіння у маленький буфер
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, gw, gh);
    gl.useProgram(glowProg.p);
    const gu = glowProg.u;
    gl.uniform2f(gu.u_res, gw, gh);
    gl.uniform1f(gu.u_time, t);
    gl.uniform2f(gu.u_g0, g0x, g0y);
    gl.uniform2f(gu.u_s0, state.sx * breath, state.sy * breath);
    gl.uniform1f(gu.u_i0, state.i);
    gl.uniform2f(gu.u_g1, g1x, g1y);
    gl.uniform2f(gu.u_s1, 0.32, 0.3);
    gl.uniform1f(gu.u_i1, 0.55 * state.i);
    gl.uniform2f(gu.u_g2, g2x, g2y);
    gl.uniform2f(gu.u_s2, 0.26, 0.26);
    gl.uniform1f(gu.u_i2, 0.45 * state.i);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 2) збірка на екран: світіння + слова + віньєтка + зерно
    const tNow = now();
    stepTween(cur, tNow);
    stepTween(old, tNow);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(compProg.p);
    const cu = compProg.u;
    gl.uniform2f(cu.u_res, canvas.width, canvas.height);
    gl.uniform1f(cu.u_dpr, LEVELS[level].dpr);
    gl.uniform1f(cu.u_seed, reduced ? 0 : Math.floor(t * 7.5) % 64);
    gl.uniform1f(cu.u_dim, state.dim);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, glowTex);
    gl.uniform1i(cu.u_glow, 0);
    bindWord(cur, 1, 2, cu.u_a, cu.u_ta, cu.u_ba, cu.u_texelA);
    bindWord(old, 3, 4, cu.u_b, cu.u_tb, cu.u_bb, cu.u_texelB);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  requestAnimationFrame(frame);
})();
