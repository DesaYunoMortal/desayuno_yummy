// Name: Reemplazar color
// ID: colorswap
// Description: Cambia colores de los disfraces solo mientras corre el juego, sin modificar el proyecto. Vectoriales y mapas de bits, varios colores a la vez.
// License: MPL-2.0

(function (Scratch) {
  'use strict';

  if (!Scratch.extensions.unsandboxed) {
    throw new Error('La extensión "Reemplazar color" debe ejecutarse sin sandbox (unsandboxed).');
  }

  const vm = Scratch.vm;
  const runtime = vm.runtime;
  const Cast = Scratch.Cast;

  /* ------------------------------------------------------------------ *
   *  Colores                                                           *
   * ------------------------------------------------------------------ */

  const colorContext = document.createElement('canvas').getContext('2d');
  const colorCache = new Map();
  const NOT_A_COLOR = /^(?:none|inherit|initial|unset|revert|currentcolor|context-fill|context-stroke|url\(.*|var\(.*)$/;

  // Convierte cualquier color CSS (#f00, #ff0000, red, rgb(), hsl()...) en {r, g, b, a}.
  // Devuelve null si el texto no es un color.
  const parseColor = (input) => {
    const text = String(input).trim().toLowerCase();
    if (colorCache.has(text)) return colorCache.get(text);

    let result = null;
    if (text && !NOT_A_COLOR.test(text)) {
      // Con un color inválido el canvas ignora la asignación y conserva el valor anterior,
      // así que se prueba sobre dos valores distintos y se comparan los resultados.
      colorContext.fillStyle = '#000000';
      colorContext.fillStyle = text;
      const overBlack = colorContext.fillStyle;
      colorContext.fillStyle = '#ffffff';
      colorContext.fillStyle = text;
      if (overBlack === colorContext.fillStyle) {
        const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(overBlack);
        const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+))?\s*\)$/.exec(overBlack);
        if (hex) {
          result = {r: parseInt(hex[1], 16), g: parseInt(hex[2], 16), b: parseInt(hex[3], 16), a: 1};
        } else if (rgb) {
          result = {r: +rgb[1], g: +rgb[2], b: +rgb[3], a: rgb[4] === undefined ? 1 : +rgb[4]};
        }
      }
    }

    if (colorCache.size > 2000) colorCache.clear();
    colorCache.set(text, result);
    return result;
  };

  const fromDecimal = (value) => {
    const n = Math.floor(value);
    return {r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255};
  };

  // Color de un valor: texto CSS o número decimal estilo Scratch (0xRRGGBB). null si no es un color.
  const colorFromValue = (value) => {
    if (typeof value === 'number') return Number.isFinite(value) ? fromDecimal(value) : null;
    const text = String(value).trim();
    if (/^-?\d+(?:\.\d+)?$/.test(text)) return fromDecimal(Number(text));
    const parsed = parseColor(text);
    return parsed ? {r: parsed.r, g: parsed.g, b: parsed.b} : null;
  };

  // Texto CSS de un color; si el color original tenía transparencia, se conserva.
  const toCss = (color, alpha) => {
    if (alpha < 1) return `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
    return '#' + [color.r, color.g, color.b].map((v) => v.toString(16).padStart(2, '0')).join('');
  };

  const sameColor = (a, b) => a.r === b.r && a.g === b.g && a.b === b.b;

  /* ------------------------------------------------------------------ *
   *  Texto con varios colores: "#00ff00 #ffff00 > #ffffff, #ff0000 > #0000ff"
   *  Cada grupo es: uno o más colores de origen, una flecha y un color de destino.
   * ------------------------------------------------------------------ */

  // Parte el texto en colores y flechas (> -> => = →). Respeta los paréntesis: rgb(255, 0, 0).
  const tokenize = (text) => {
    const tokens = [];
    let current = '';
    let depth = 0;
    const flush = () => {
      if (current) tokens.push({arrow: false, text: current});
      current = '';
    };
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '(') depth++;
      if (depth === 0) {
        if ((ch === '-' || ch === '=') && text[i + 1] === '>') {
          flush();
          tokens.push({arrow: true});
          i++;
          continue;
        }
        if (ch === '>' || ch === '=' || ch === '→') {
          flush();
          tokens.push({arrow: true});
          continue;
        }
        if (/[\s,;]/.test(ch)) {
          flush();
          continue;
        }
      }
      current += ch;
      if (ch === ')' && depth > 0) depth--;
    }
    flush();
    return tokens;
  };

  // Devuelve {groups: [{froms: [color], to: color}], problems: [texto]}.
  const parseMap = (text) => {
    const tokens = tokenize(String(text));
    const groups = [];
    const problems = [];
    let sources = [];

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (!token.arrow) {
        const color = colorFromValue(token.text);
        if (color) sources.push(color);
        else problems.push(`"${token.text}" no es un color válido`);
        continue;
      }

      const next = tokens[i + 1];
      if (!next || next.arrow) {
        problems.push('falta el color de destino después de la flecha');
        continue;
      }
      i++;
      const to = colorFromValue(next.text);
      if (!to) {
        problems.push(`"${next.text}" no es un color válido`);
        sources = [];
      } else if (sources.length === 0) {
        problems.push(`falta el color de origen antes de la flecha (destino ${next.text})`);
      } else {
        groups.push({froms: sources, to});
        sources = [];
      }
    }
    if (sources.length > 0) problems.push('hay colores de origen sin flecha y destino');
    return {groups, problems};
  };

  /* ------------------------------------------------------------------ *
   *  Reglas                                                            *
   *  Una regla es {from, to, tolerance (0-255), costume (null = todos)}.*
   *  Todas se aplican a la vez sobre los colores ORIGINALES del disfraz *
   *  y no se encadenan: verde→amarillo y amarillo→rojo no vuelve rojo  *
   *  lo que era verde. Si dos reglas coinciden, gana la más reciente.  *
   * ------------------------------------------------------------------ */

  // Índice de la regla que le toca a un color, o -1.
  const matchRule = (rules, r, g, b) => {
    for (let i = rules.length - 1; i >= 0; i--) {
      const {from, tolerance} = rules[i];
      if (Math.abs(r - from.r) <= tolerance && Math.abs(g - from.g) <= tolerance && Math.abs(b - from.b) <= tolerance) {
        return i;
      }
    }
    return -1;
  };

  /* ------------------------------------------------------------------ *
   *  Disfraces vectoriales (SVG)                                       *
   * ------------------------------------------------------------------ */

  // Atributos de presentación que contienen un color.
  const COLOR_ATTRIBUTES = ['fill', 'stroke', 'stop-color', 'flood-color', 'lighting-color', 'color'];
  // Las mismas propiedades cuando están dentro de un atributo style o de un bloque <style>.
  const CSS_DECLARATION = /(^|[;{\s])(fill|stroke|stop-color|flood-color|lighting-color|color)(\s*:\s*)([^;}]*)/gi;

  // Devuelve {text, counts, changed} con el SVG recoloreado, o null si el SVG no se puede leer.
  const recolorSvg = (svgText, rules) => {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    if (doc.getElementsByTagName('parsererror').length > 0) return null;

    const counts = new Array(rules.length).fill(0);

    // Si `value` es un color al que le toca una regla devuelve el color nuevo; si no, null.
    const swap = (value) => {
      const color = parseColor(value);
      if (!color || color.a === 0) return null;
      const index = matchRule(rules, color.r, color.g, color.b);
      if (index < 0) return null;
      counts[index]++;
      return toCss(rules[index].to, color.a);
    };

    const swapInCss = (css) => css.replace(CSS_DECLARATION, (match, lead, prop, separator, value) => {
      const important = /\s*!important\s*$/i.exec(value);
      const replaced = swap(important ? value.slice(0, important.index) : value);
      return replaced === null ? match : lead + prop + separator + replaced + (important ? important[0] : '');
    });

    for (const element of doc.querySelectorAll('*')) {
      for (const name of COLOR_ATTRIBUTES) {
        const value = element.getAttribute(name);
        if (value === null) continue;
        const replaced = swap(value);
        if (replaced !== null) element.setAttribute(name, replaced);
      }

      const style = element.getAttribute('style');
      if (style) {
        const updated = swapInCss(style);
        if (updated !== style) element.setAttribute('style', updated);
      }

      if (element.localName === 'style') {
        for (const node of element.childNodes) {
          if (node.nodeType === 3 || node.nodeType === 4) { // texto o CDATA
            const updated = swapInCss(node.nodeValue);
            if (updated !== node.nodeValue) node.nodeValue = updated;
          }
        }
      }
    }

    const changed = counts.some((n) => n > 0);
    return {text: changed ? new XMLSerializer().serializeToString(doc) : svgText, counts, changed};
  };

  /* ------------------------------------------------------------------ *
   *  Disfraces de mapa de bits (PNG, JPG, GIF...)                      *
   * ------------------------------------------------------------------ */

  const decodeImage = async (bytes) => {
    const blob = new Blob([bytes]);
    if (typeof createImageBitmap === 'function') {
      try {
        return await createImageBitmap(blob);
      } catch (error) {
        // Si falla, se intenta con un <img>.
      }
    }
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      return image;
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  // Dibuja la imagen en un canvas del mismo tamaño. Devuelve null si la imagen está vacía.
  const imageToCanvas = async (bytes) => {
    const image = await decodeImage(bytes);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    let canvas = null;
    if (width && height) {
      canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d', {willReadFrequently: true}).drawImage(image, 0, 0);
    }
    if (typeof image.close === 'function') image.close();
    return canvas;
  };

  // Devuelve {canvas, counts, changed}; canvas es null si no hubo ningún cambio.
  const recolorBitmap = async (bytes, rules) => {
    const counts = new Array(rules.length).fill(0);
    const canvas = await imageToCanvas(bytes);
    if (!canvas) return {canvas: null, counts, changed: false};

    const context = canvas.getContext('2d', {willReadFrequently: true});
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = imageData.data;
    let lastKey = -1; // los píxeles vecinos suelen repetir color: se reutiliza la búsqueda anterior
    let lastIndex = -1;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] === 0) continue; // totalmente transparente: no se ve, se ignora
      const key = (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2];
      if (key !== lastKey) {
        lastKey = key;
        lastIndex = matchRule(rules, pixels[i], pixels[i + 1], pixels[i + 2]);
      }
      if (lastIndex >= 0) {
        const to = rules[lastIndex].to;
        pixels[i] = to.r;
        pixels[i + 1] = to.g;
        pixels[i + 2] = to.b; // el alfa de cada píxel no se toca
        counts[lastIndex]++;
      }
    }

    const changed = counts.some((n) => n > 0);
    if (!changed) return {canvas: null, counts, changed: false};
    context.putImageData(imageData, 0, 0);
    return {canvas, counts, changed: true};
  };

  /* ------------------------------------------------------------------ *
   *  Estado y dibujo                                                   *
   *  Nunca se tocan los disfraces del proyecto (asset, id, tamaño...): *
   *  solo se cambia lo que el renderer dibuja. Al detener el juego se  *
   *  vuelve a dibujar cada disfraz desde su asset original.            *
   * ------------------------------------------------------------------ */

  const MAX_RULES = 256; // reglas por sprite
  const MAX_UNDO = 20; // pasos para deshacer por sprite

  // Reglas activas de cada sprite. Solo existen mientras corre el juego.
  const states = new Map(); // Sprite -> {rules, undo}
  // Disfraces ya revisados con las reglas actuales, y si hoy se dibujan con otros colores.
  const applied = new Map(); // Costume -> {sprite, sig, changed, counts}

  // Assets que no se pudieron leer: se avisa una sola vez y no se insiste hasta que el disfraz cambie.
  const unreadable = new WeakSet();

  const stateOf = (sprite) => {
    let state = states.get(sprite);
    if (!state) {
      state = {rules: [], undo: []};
      states.set(sprite, state);
    }
    return state;
  };

  const ruleKey = (rule) =>
    `${rule.from.r},${rule.from.g},${rule.from.b}>${rule.to.r},${rule.to.g},${rule.to.b}~${rule.tolerance}`;
  const rulesFor = (costume, rules) =>
    rules.filter((rule) => rule.costume === null || rule.costume === costume);

  const isLiveSprite = (sprite) => runtime.targets.some((target) => target.sprite === sprite);
  const hasCostume = (sprite, costume) => isLiveSprite(sprite) && sprite.costumes.includes(costume);
  const canDraw = (costume) =>
    Boolean(runtime.renderer) && costume.skinId !== undefined && costume.skinId !== null;
  const isSvg = (costume) => String(costume.dataFormat).toLowerCase() === 'svg';

  const drawSvg = (costume, text) => {
    runtime.renderer.updateSVGSkin(costume.skinId, text, [costume.rotationCenterX, costume.rotationCenterY]);
  };

  const drawBitmap = (costume, canvas) => {
    const resolution = costume.bitmapResolution || 1;
    // El renderer espera el centro de rotación dividido por la resolución del mapa de bits.
    runtime.renderer.updateBitmapSkin(costume.skinId, canvas, resolution, [
      costume.rotationCenterX / resolution,
      costume.rotationCenterY / resolution
    ]);
  };

  // Dibuja el disfraz tal como está guardado en el proyecto.
  const drawOriginal = async (sprite, costume) => {
    if (isSvg(costume)) {
      drawSvg(costume, new TextDecoder().decode(costume.asset.data));
      return;
    }
    const canvas = await imageToCanvas(costume.asset.data);
    if (canvas && hasCostume(sprite, costume)) drawBitmap(costume, canvas);
  };

  const redraw = () => {
    if (typeof runtime.requestRedraw === 'function') runtime.requestRedraw();
  };

  // Deja los disfraces del sprite dibujados según sus reglas actuales. Es idempotente:
  // solo trabaja en los disfraces cuyo dibujo no coincide con lo que piden las reglas.
  const reconcileSprite = async (sprite) => {
    const live = isLiveSprite(sprite);
    for (const [costume, info] of applied) {
      if (info.sprite === sprite && !(live && sprite.costumes.includes(costume))) applied.delete(costume);
    }
    if (!live) return;

    const rules = states.has(sprite) ? states.get(sprite).rules : [];
    for (const costume of sprite.costumes.slice()) {
      if (!hasCostume(sprite, costume) || costume.broken || !costume.asset || !costume.asset.data) continue;
      if (!canDraw(costume) || unreadable.has(costume.asset)) continue;

      const list = rulesFor(costume, rules);
      // El id del asset va en la firma: si el disfraz se edita mientras corre el juego, se vuelve a dibujar.
      const wanted = list.length > 0 ? `${costume.assetId}|${list.map(ruleKey).join(';')}` : '';
      const info = applied.get(costume);
      if (wanted === (info ? info.sig : '')) continue;

      try {
        if (wanted === '') {
          if (info.changed) await drawOriginal(sprite, costume);
          applied.delete(costume);
          continue;
        }

        const result = isSvg(costume)
          ? recolorSvg(new TextDecoder().decode(costume.asset.data), list)
          : await recolorBitmap(costume.asset.data, list);
        if (!result) throw new Error('No se pudo leer el SVG del disfraz');
        if (!hasCostume(sprite, costume)) continue; // se eliminó mientras tanto

        if (result.changed) {
          if (isSvg(costume)) drawSvg(costume, result.text);
          else drawBitmap(costume, result.canvas);
        } else if (info && info.changed) {
          await drawOriginal(sprite, costume);
        }
        applied.set(costume, {
          sprite,
          sig: wanted,
          changed: result.changed,
          counts: new Map(list.map((rule, i) => [rule, result.counts[i]]))
        });
      } catch (error) {
        console.warn(`[Reemplazar color] No se pudo procesar el disfraz "${costume.name}":`, error);
        unreadable.add(costume.asset);
      }
    }
    redraw();
  };

  const reconcileAll = async () => {
    const sprites = new Set(states.keys());
    for (const info of applied.values()) sprites.add(info.sprite);
    for (const sprite of sprites) await reconcileSprite(sprite);
  };

  // Cuántos colores (vector) o píxeles (mapa de bits) cambiaron estas reglas en todos los disfraces.
  const countFor = (sprite, rules) => {
    let total = 0;
    for (const costume of sprite.costumes) {
      const info = applied.get(costume);
      if (info) for (const rule of rules) total += info.counts.get(rule) || 0;
    }
    return total;
  };

  const sameSource = (a, b) =>
    sameColor(a.from, b.from) && a.tolerance === b.tolerance && a.costume === b.costume;
  const sameRule = (a, b) => sameSource(a, b) && sameColor(a.to, b.to);

  /* ------------------------------------------------------------------ *
   *  Extensión                                                         *
   * ------------------------------------------------------------------ */

  class ColorSwap {
    constructor() {
      this._queue = Promise.resolve();
      this._lastCount = 0;
      this._states = states; // solo para las pruebas
      this._applied = applied;

      // Detener el proyecto (botón de parar, bandera verde o "detener todo") lo deja todo como estaba.
      runtime.on('PROJECT_STOP_ALL', () => {
        states.clear();
        this._enqueue(reconcileAll);
      });
      // Si se carga otro proyecto, los disfraces anteriores ya no existen.
      runtime.on('PROJECT_LOADED', () => {
        states.clear();
        applied.clear();
      });
    }

    getInfo() {
      const scope = {type: Scratch.ArgumentType.STRING, menu: 'scope', defaultValue: 'all'};
      return {
        id: 'colorswap',
        name: 'Reemplazar color',
        blocks: [
          {
            opcode: 'replaceColor',
            blockType: Scratch.BlockType.COMMAND,
            text: 'reemplazar color [FROM] por [TO] en [SCOPE]',
            arguments: {
              FROM: {type: Scratch.ArgumentType.COLOR, defaultValue: '#ff0000'},
              TO: {type: Scratch.ArgumentType.COLOR, defaultValue: '#0000ff'},
              SCOPE: scope
            }
          },
          {
            opcode: 'replaceColorTolerance',
            blockType: Scratch.BlockType.COMMAND,
            text: 'reemplazar color [FROM] por [TO] con tolerancia [TOLERANCE] de 100 en [SCOPE]',
            arguments: {
              FROM: {type: Scratch.ArgumentType.COLOR, defaultValue: '#ff0000'},
              TO: {type: Scratch.ArgumentType.COLOR, defaultValue: '#0000ff'},
              TOLERANCE: {type: Scratch.ArgumentType.NUMBER, defaultValue: 10},
              SCOPE: scope
            }
          },
          {
            opcode: 'replaceColorMap',
            blockType: Scratch.BlockType.COMMAND,
            text: 'reemplazar colores [MAP] con tolerancia [TOLERANCE] de 100 en [SCOPE]',
            arguments: {
              MAP: {type: Scratch.ArgumentType.STRING, defaultValue: '#00ff00 > #ffff00, #ff0000 > #0000ff'},
              TOLERANCE: {type: Scratch.ArgumentType.NUMBER, defaultValue: 0},
              SCOPE: scope
            }
          },
          '---',
          {
            opcode: 'undoReplace',
            blockType: Scratch.BlockType.COMMAND,
            text: 'deshacer último reemplazo de este sprite'
          },
          {
            opcode: 'restoreColors',
            blockType: Scratch.BlockType.COMMAND,
            text: 'restaurar colores originales de [TARGET]',
            arguments: {
              TARGET: {type: Scratch.ArgumentType.STRING, menu: 'target', defaultValue: 'this'}
            }
          },
          '---',
          {
            opcode: 'currentColorOf',
            blockType: Scratch.BlockType.REPORTER,
            text: 'color actual de [COLOR]',
            arguments: {
              COLOR: {type: Scratch.ArgumentType.COLOR, defaultValue: '#00ff00'}
            }
          },
          {
            opcode: 'lastAppliedColor',
            blockType: Scratch.BlockType.REPORTER,
            text: 'último color aplicado'
          },
          {
            opcode: 'replacedCount',
            blockType: Scratch.BlockType.REPORTER,
            text: 'cambios del último reemplazo'
          }
        ],
        menus: {
          scope: {
            acceptReporters: false,
            items: [
              {text: 'todos los disfraces', value: 'all'},
              {text: 'el disfraz actual', value: 'current'}
            ]
          },
          target: {
            acceptReporters: false,
            items: [
              {text: 'este sprite', value: 'this'},
              {text: 'todos los sprites', value: 'all'}
            ]
          }
        }
      };
    }

    /* ---- Comandos ---- */

    replaceColor(args, util) {
      const from = colorFromValue(args.FROM);
      const to = colorFromValue(args.TO);
      if (!from || !to) return this._invalid(args);
      return this._addRules(util.target, [{from, to}], 0, args.SCOPE);
    }

    replaceColorTolerance(args, util) {
      const from = colorFromValue(args.FROM);
      const to = colorFromValue(args.TO);
      if (!from || !to) return this._invalid(args);
      return this._addRules(util.target, [{from, to}], args.TOLERANCE, args.SCOPE);
    }

    replaceColorMap(args, util) {
      const {groups, problems} = parseMap(args.MAP);
      for (const problem of problems) console.warn(`[Reemplazar color] ${problem}`);
      const pairs = [];
      for (const group of groups) for (const from of group.froms) pairs.push({from, to: group.to});
      return this._addRules(util.target, pairs, args.TOLERANCE, args.SCOPE);
    }

    undoReplace(args, util) {
      const sprite = util.target && util.target.sprite;
      this._lastCount = 0;
      if (!sprite) return;
      const state = states.get(sprite);
      if (state && state.undo.length > 0) state.rules = state.undo.pop();
      return this._enqueue(() => reconcileSprite(sprite));
    }

    restoreColors(args, util) {
      const sprite = util.target && util.target.sprite;
      this._lastCount = 0;
      const everyone = args.TARGET === 'all';
      for (const [other, state] of states) {
        if ((everyone || other === sprite) && state.rules.length > 0) this._commit(state, []);
      }
      if (everyone) return this._enqueue(reconcileAll);
      if (sprite) return this._enqueue(() => reconcileSprite(sprite));
    }

    /* ---- Reporteros ---- */

    // El color en que se ve ahora un color original (el mismo color si ninguna regla le toca).
    currentColorOf(args, util) {
      const color = colorFromValue(args.COLOR);
      if (!color) return '';
      const target = util.target;
      const state = target && target.sprite && states.get(target.sprite);
      if (state) {
        const list = rulesFor(target.getCostumes()[target.currentCostume] || null, state.rules);
        const index = matchRule(list, color.r, color.g, color.b);
        if (index >= 0) return toCss(list[index].to, 1);
      }
      return toCss(color, 1);
    }

    // El destino de la regla más reciente que afecta al disfraz actual ('' si no hay ninguna).
    lastAppliedColor(args, util) {
      const target = util.target;
      const state = target && target.sprite && states.get(target.sprite);
      if (!state) return '';
      const list = rulesFor(target.getCostumes()[target.currentCostume] || null, state.rules);
      return list.length > 0 ? toCss(list[list.length - 1].to, 1) : '';
    }

    replacedCount() {
      return this._lastCount;
    }

    /* ---- Internos ---- */

    _invalid(args) {
      console.warn(`[Reemplazar color] Color no válido: "${args.FROM}" o "${args.TO}"`);
      this._lastCount = 0;
    }

    // Agrega reglas al sprite (una por cada pareja) y deja los disfraces dibujados con ellas.
    _addRules(target, pairs, tolerancePercent, scope) {
      const sprite = target && target.sprite;
      this._lastCount = 0;
      if (!sprite) return;

      const tolerance = Math.round(Math.min(100, Math.max(0, Cast.toNumber(tolerancePercent))) * 2.55);
      const costume = scope === 'current' ? target.getCostumes()[target.currentCostume] : null;
      if (scope === 'current' && !costume) return;

      const state = stateOf(sprite);
      let rules = state.rules;
      const mine = [];
      for (const pair of pairs) {
        if (tolerance === 0 && sameColor(pair.from, pair.to)) continue; // no cambiaría nada
        const rule = {from: pair.from, to: pair.to, tolerance, costume};
        const existing = rules.find((other) => sameRule(other, rule));
        if (existing) {
          mine.push(existing);
          continue;
        }
        // Una regla nueva para el mismo color reemplaza a la anterior y pasa a ser la más reciente.
        rules = rules.filter((other) => !sameSource(other, rule)).concat(rule);
        mine.push(rule);
      }
      if (rules.length > MAX_RULES) rules = rules.slice(rules.length - MAX_RULES);
      this._commit(state, rules);

      return this._enqueue(async () => {
        await reconcileSprite(sprite);
        this._lastCount = countFor(sprite, mine);
      });
    }

    // Guarda las reglas nuevas y recuerda las anteriores para poder deshacer.
    _commit(state, rules) {
      if (rules.length === state.rules.length && rules.every((rule, i) => rule === state.rules[i])) return;
      state.undo.push(state.rules);
      if (state.undo.length > MAX_UNDO) state.undo.shift();
      state.rules = rules;
    }

    // Las operaciones se hacen de a una: las de mapa de bits son asíncronas y, si se pisaran,
    // una podría dibujar un disfraz con reglas viejas después de que otra lo dejó al día.
    _enqueue(task) {
      const run = this._queue.then(task).catch((error) => {
        console.warn('[Reemplazar color]', error);
      });
      this._queue = run;
      return run;
    }

    // Solo para las pruebas: espera a que no quede nada en la cola.
    async _idle() {
      let queue;
      do {
        queue = this._queue;
        await queue;
      } while (queue !== this._queue);
    }
  }

  Scratch.extensions.register(new ColorSwap());
})(Scratch);
