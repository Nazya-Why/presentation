/* Фон презентації — один WebGL-canvas у повній роздільності екрана (Retina):
     1) світіння: кілька м'яких плям, що повільно літають екраном і зливаються;
     2) великі сірі слова з blend "luminosity" — з готових текстур;
     3) віньєтка, тонке плівкове зерно і дизеринг (щоб градієнти не йшли смугами).

   Головна пляма тримається біля точки слайда (data-glow), але плаває широкими
   петлями в різні боки; три менші жарини мандрують по всьому екрану самі.

   API:
     Bg.set({x, y, sx, sy, i})        — "дім" головної плями
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

  /* ---------------- шейдер ---------------- */
  const vert = `
    attribute vec2 p;
    void main() { gl_Position = vec4(p, 0.0, 1.0); }
  `;

  const frag = `
    precision highp float;
    uniform vec2 u_res;
    uniform float u_time;
    uniform float u_seed;
    uniform float u_dim;
    // 4 плями: xy — центр, zw — розмір; u_int — яскравість кожної
    uniform vec4 u_b0; uniform vec4 u_b1; uniform vec4 u_b2; uniform vec4 u_b3;
    uniform vec4 u_int;
    uniform sampler2D u_ta; uniform sampler2D u_ba; uniform vec3 u_a;
    uniform sampler2D u_tb; uniform sampler2D u_bb; uniform vec3 u_b;
    uniform vec2 u_texelA; uniform vec2 u_texelB;

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
    // лише низькі частоти — форма "пливе", але поверхня гладенька
    float fbm(vec2 p) { return 0.65 * snoise(p) + 0.35 * snoise(p * 1.9 + 7.3); }

    // більшість екрана — чорний, червоний і помаранчевий; жовтий лише в самому ядрі
    vec3 ramp(float t) {
      vec3 c = vec3(0.022, 0.016, 0.015);
      c = mix(c, vec3(0.26, 0.022, 0.010), smoothstep(0.10, 0.34, t));
      c = mix(c, vec3(0.72, 0.07, 0.02),   smoothstep(0.28, 0.54, t));
      c = mix(c, vec3(0.95, 0.24, 0.035),  smoothstep(0.48, 0.74, t));
      c = mix(c, vec3(1.00, 0.44, 0.07),   smoothstep(0.68, 0.92, t));
      c = mix(c, vec3(1.00, 0.70, 0.26),   smoothstep(0.90, 1.08, t));
      return c;
    }

    float blob(vec2 w, vec4 b, float asp) {
      vec2 d = (w - vec2(b.x * asp, b.y)) / vec2(b.z * asp, b.w);
      float r = dot(d, d);
      return exp(-r * 1.3) + 0.1 * exp(-r * 0.3); // ядро + широкий ореол
    }

    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
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
      float t = u_time;
      vec2 p = vec2(uv.x * asp, uv.y);

      // повільне "перетікання" простору — плями м'яко деформуються
      vec2 q = vec2(fbm(p * 0.85 + vec2(0.0, t * 0.03)), fbm(p * 0.85 + vec2(4.1, -t * 0.026)));
      vec2 w = p + q * 0.17;

      float v = blob(w, u_b0, asp) * u_int.x
              + blob(w, u_b1, asp) * u_int.y
              + blob(w, u_b2, asp) * u_int.z
              + blob(w, u_b3, asp) * u_int.w;
      v *= 0.93 + 0.1 * fbm(w * 1.1 + vec2(t * 0.02, -t * 0.045));
      // м'яка компресія: світіння велике й насичене, а біле — лише в самому ядрі
      v = 1.1 * (1.0 - exp(-v * 0.95));

      vec3 col = ramp(v);

      vec2 vv = (uv - 0.5) * vec2(asp, 1.0);
      col *= 1.0 - 0.36 * smoothstep(0.35, 1.3, length(vv));

      // великі слова: сірий #616161 у режимі luminosity —
      // на чорному сірі, на жару темно-коричневі
      float a = word(u_ta, u_ba, u_a, u_texelA, uv);
      float b = word(u_tb, u_bb, u_b, u_texelB, uv);
      float ta = 1.0 - (1.0 - a) * (1.0 - b);
      col = mix(col, setLum(col, 0.38), ta * u_dim);

      // тонке зерно на рівні фізичного пікселя + дизеринг проти смуг
      vec2 fc = gl_FragCoord.xy;
      float n1 = hash(fc + u_seed * 61.7);
      float n2 = hash(fc.yx + u_seed * 23.1 + 17.0);
      float grain = n1 + n2 - 1.0;
      col += grain * (0.012 + 0.03 * sqrt(lum(col)));

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
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, vert));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, frag));
  gl.bindAttribLocation(prog, 0, 'p');
  gl.linkProgram(prog);
  gl.useProgram(prog);
  const u = {};
  for (let i = 0, n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS); i < n; i++) {
    const name = gl.getActiveUniform(prog, i).name;
    u[name] = gl.getUniformLocation(prog, name);
  }

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

  /* ---------------- роздільність ---------------- */
  // Повна роздільність екрана. Лише якщо пристрій явно не встигає — крок униз.
  const DPR = Math.min(devicePixelRatio || 1, 2);
  const LEVELS = [DPR, Math.min(DPR, 1.5), 1];
  let level = 0;

  function resize() {
    const d = LEVELS[level];
    canvas.width = Math.max(2, Math.round(innerWidth * d));
    canvas.height = Math.max(2, Math.round(innerHeight * d));
  }

  /* ---------------- текстури слів ---------------- */
  const TEXT_DPR = DPR;
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

  // плавна траєкторія з кількох синусоїд — ніколи не повторюється точно
  const drift = (t, a, f, ph) => a * (0.7 * Math.sin(t * f + ph) + 0.3 * Math.sin(t * f * 2.31 + ph * 1.7));

  function frame(ms) {
    requestAnimationFrame(frame);
    // не частіше 60 к/с: на 120 Гц екранах (MacBook Pro) це вдвічі менше роботи
    if (ms - lastDraw < 15.5) return;
    lastDraw = ms;

    const dt = Math.min(0.1, (ms - last) / 1000);
    last = ms;
    time += dt * (reduced ? 0.25 : 1);

    // автоякість: якщо кадри стабільно довші за ~28 мс — знижуємо роздільність
    if (!document.hidden && level < LEVELS.length - 1) {
      sampled++;
      if (dt > 0.028) slowFrames++;
      if (sampled >= 120) {
        if (slowFrames > 70) { level++; resize(); }
        sampled = 0;
        slowFrames = 0;
      }
    }

    const k = 1 - Math.exp(-dt * 1.6);
    for (const key in target) state[key] += (target[key] - state[key]) * k;
    const km = 1 - Math.exp(-dt * 2.5);
    mouse.x += (mouse.tx - mouse.x) * km;
    mouse.y += (mouse.ty - mouse.y) * km;

    const t = time;
    const I = state.i;
    const breath = 1 + 0.12 * Math.sin(t * 0.29);

    // головна пляма: широкі петлі навколо "дому" слайда
    gl.uniform4f(u.u_b0,
      state.x + drift(t, 0.3, 0.11, 0.0) + mouse.x * 0.06,
      state.y + drift(t, 0.16, 0.083, 1.3) + mouse.y * 0.04,
      state.sx * breath, state.sy * breath);
    // жарини літають по всьому екрану, іноді підіймаючись нагору
    gl.uniform4f(u.u_b1, 0.5 + drift(t, 0.62, 0.071, 1.0), 0.12 + drift(t, 0.42, 0.093, 0.4), 0.42, 0.38);
    gl.uniform4f(u.u_b2, 0.5 + drift(t, 0.6, 0.058, 3.6), 0.1 + drift(t, 0.46, 0.077, 2.2), 0.36, 0.34);
    gl.uniform4f(u.u_b3, 0.5 + drift(t, 0.55, 0.049, 5.1), 0.2 + drift(t, 0.5, 0.066, 4.4), 0.3, 0.3);
    gl.uniform4f(u.u_int, I, 0.55 * I, 0.46 * I, 0.34 * I);

    stepTween(cur, now());
    stepTween(old, now());

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(u.u_res, canvas.width, canvas.height);
    gl.uniform1f(u.u_time, t);
    gl.uniform1f(u.u_seed, reduced ? 0 : Math.floor(t * 12) % 97);
    gl.uniform1f(u.u_dim, state.dim);
    bindWord(cur, 0, 1, u.u_a, u.u_ta, u.u_ba, u.u_texelA);
    bindWord(old, 2, 3, u.u_b, u.u_tb, u.u_bb, u.u_texelB);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  requestAnimationFrame(frame);
})();
