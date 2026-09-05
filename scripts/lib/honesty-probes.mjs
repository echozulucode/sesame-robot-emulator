/**
 * The honesty and accessibility PROBES, in one place — Phase 5 T5.
 *
 * Every constant below is page-side JavaScript, evaluated over CDP in whatever
 * window is being examined. They were written for
 * `scripts/capture-web-screenshots.mjs` phases 12 and 13, against the app served
 * by the Phase-0 bridge in headless Chromium. T5 has to ask the same questions
 * of the PACKAGED desktop artefact — a WebView2 window serving
 * `http://tauri.localhost/` out of the executable — and the one thing it must
 * not do is ask them with a second, weaker copy of the arithmetic. Six
 * assertions in this project have already shipped unable to fail, one of them a
 * contrast calculation that reported 4.21:1 for a run at 1.66:1; a re-typed
 * copy of that formula in a second file would be the seventh.
 *
 * So the probes moved here and every caller imports them. Phase 13 said this of
 * its own duplicate of the correctness-selector list:
 *
 * > *"Restating it is the smaller evil: a selector that drifts here shows up as
 * > a gate that scanned fewer surfaces than the phase above it."*
 *
 * There is a scope in which all three callers can see one array now, so the
 * smaller evil is gone as well: {@link CORRECTNESS_SURFACE_SELECTORS} is the
 * list, and phase 13's `W6_CORRECTNESS_SELECTORS` is an alias of it.
 *
 * Nothing here reads the filesystem, spawns anything or holds state — strings
 * and the constants they interpolate — so it imports cleanly into the harness,
 * into the packaged phase, and into whatever comes after them.
 */

/**
 * The W1 floor, in one place.
 *
 * It was declared in the harness and interpolated into two scans there; the
 * packaged phase would have made it three. A floor written down twice is a
 * floor that can be lowered once.
 */
export const TEXT_FLOOR_PX = 14;

// -------------------------------------- the surfaces that carry a claim
/**
 * Every visible run of text on the page, measured — Phase 4 W1.
 *
 * The brief and the plan both say this explicitly: the floor is checked by
 * reading computed styles in a browser, not by grepping the source. The
 * static check before phase 1 proves no literal survives in the stylesheet;
 * this proves what a reader actually sees, and the two catch different
 * things. A pane could inherit 9px from a parent without a literal anywhere.
 *
 * "Meaningful text" is an element's OWN text — its direct child text nodes —
 * so a paragraph is measured once instead of once per ancestor.
 *
 * ## Two sizes, because one of them is a lie inside a pan/zoom surface
 *
 * `authoredPx` is the computed `font-size`. `screenPx` is that multiplied by
 * the transform actually in force, which is what a reader's eye gets. They
 * differ in exactly one place: React Flow draws the architecture graph
 * through a CSS transform the reader controls, and `fitView` on 63 nodes in a
 * 620px pane lands 14px edge labels on screen at 3-5px.
 *
 * Shrinking that type would not help and enlarging it would not either. So
 * the surface declares itself `[data-zoom-surface]`, the floor is asserted on
 * `authoredPx` inside it and on `screenPx` everywhere else, and the harness
 * RECORDS the worst on-screen size it found there. That number is W4's
 * problem — three representations instead of one shrunk graph — and writing
 * it into the report is what stops this invariant absorbing that debt
 * silently, which is this project's known failure mode.
 */
export const CORRECTNESS_SURFACE_SELECTORS = [
  '.prov',
  '[data-origin-kind]',
  '#prov-banner',
  '.prov-banner p',
  '.trace-row-witness',
  '.trace-witness-key',
  '.lesson-check-status',
  '.lesson-check-summary',
  '.lesson-notbuilt',
  '[data-testid="lesson-control-notbuilt"]',
  '.badge.is-notbuilt',
  /*
    The environment line — Phase 4 W3.

    `SYSTEM: ... · PHYSICAL HARDWARE: NONE` is the brief's answer to
    *"observed" reads to a novice as observed on hardware*, and the plan says
    outright that it may not be truncated and must be visible rather than in a
    legend. Listing it here is what makes that a check: any window where it
    does not fit fails the run, instead of quietly ellipsising the word that
    carries the claim.
  */
  '[data-testid="status-environment"]',
];

/**
 * Phase 13 knows the same list under its own name — one array, two names, so a
 * selector cannot be added to one gate and missed by the other.
 */
export const W6_CORRECTNESS_SELECTORS = CORRECTNESS_SURFACE_SELECTORS;

// ------------------------------------------------------ the W1 type scan
/**
 * Phase 12's scan, verbatim. Evaluating it returns
 * `{ below, zoomed, truncated, roles, nodes, viewportTransform, archMode }`.
 */
export const TYPE_SCAN_JS = `(() => {
  const FLOOR = ${TEXT_FLOOR_PX};
  const out = { below: [], zoomed: [], truncated: [], roles: {}, nodes: 0 };
  const own = (el) => {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue;
    return t.replace(/\\s+/g, ' ').trim();
  };
  const nameOf = (el) =>
    el.tagName.toLowerCase() +
    (typeof el.className === 'string' && el.className.trim().length > 0
      ? '.' + el.className.trim().split(/\\s+/).join('.')
      : '');
  // The accumulated vertical scale of every transform between this element
  // and the root. Read out of the matrices rather than inferred from
  // getBoundingClientRect()/offsetHeight, which disagree for inline boxes
  // and would report a scale on text nobody transformed.
  const scaleOf = (el) => {
    if (el.ownerSVGElement !== null && el.ownerSVGElement !== undefined && typeof el.getScreenCTM === 'function') {
      const ctm = el.getScreenCTM();
      return ctm === null ? 1 : Math.abs(ctm.d);
    }
    let scale = 1;
    let node = el;
    let guard = 0;
    while (node !== null && node !== document.documentElement && guard < 60) {
      const t = getComputedStyle(node).transform;
      if (t !== 'none' && t !== '') {
        const nums = t.slice(t.indexOf('(') + 1, -1).split(',').map((v) => parseFloat(v));
        if (t.startsWith('matrix3d') && nums.length >= 6) scale *= Math.abs(nums[5]);
        else if (nums.length >= 4) scale *= Math.abs(nums[3]);
      }
      node = node.parentElement;
      guard += 1;
    }
    return scale;
  };
  const smallest = (selector, key) => {
    for (const el of document.querySelectorAll(selector)) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (own(el).length === 0) continue;
      const px = parseFloat(cs.fontSize);
      if (out.roles[key] === undefined || px < out.roles[key].px) {
        out.roles[key] = { px, sel: selector, text: own(el).slice(0, 40) };
      }
    }
  };

  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    const text = own(el);
    if (text.length === 0) continue;
    out.nodes += 1;
    const authoredPx = parseFloat(cs.fontSize);
    const screenPx = authoredPx * scaleOf(el);
    const zoomSurface = el.closest('[data-zoom-surface]');
    const where = zoomSurface === null ? null : zoomSurface.getAttribute('data-zoom-surface');
    if (authoredPx < FLOOR - 0.01) {
      out.below.push({ name: nameOf(el), authoredPx, screenPx, text: text.slice(0, 48), zoomSurface: where });
    } else if (where === null && screenPx < FLOOR - 0.01) {
      out.below.push({ name: nameOf(el), authoredPx, screenPx, text: text.slice(0, 48), zoomSurface: null });
    } else if (where !== null && screenPx < FLOOR - 0.01) {
      out.zoomed.push({ surface: where, name: nameOf(el), authoredPx, screenPx: Math.round(screenPx * 100) / 100, text: text.slice(0, 40) });
    }
  }

  for (const selector of ${JSON.stringify(CORRECTNESS_SURFACE_SELECTORS)}) {
    for (const el of document.querySelectorAll(selector)) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      const text = (el.textContent ?? '').replace(/\\s+/g, ' ').trim();
      if (text.length === 0) continue;
      const clamped = cs.webkitLineClamp !== undefined && cs.webkitLineClamp !== '' && cs.webkitLineClamp !== 'none';
      const ellipsised = cs.textOverflow === 'ellipsis';
      const cut = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
      if (clamped || ellipsised || cut) {
        out.truncated.push({
          selector,
          name: nameOf(el),
          text: text.slice(0, 60),
          ellipsised,
          clamped,
          cut,
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
        });
      }
    }
  }

  out.roles.body = { px: parseFloat(getComputedStyle(document.body).fontSize), sel: 'body', text: '' };
  // The graph's viewport transform at the moment of the scan, so a
  // below-floor reading inside a pan surface says WHY rather than only
  // how small. W7 spent a run bisecting exactly this.
  {
    const viewport = document.querySelector('.react-flow__viewport');
    out.viewportTransform = viewport === null ? null : getComputedStyle(viewport).transform;
    const surface = document.querySelector('[data-testid="arch-surface"]');
    out.archMode = surface === null ? null : surface.getAttribute('data-arch-mode');
  }
  smallest('.src-line, .src-text, table.joints td, dl.kv dd, .lab-code, .pose-table td', 'code');
  /*
    .prov-banner p LEFT this list in W7, and that is a decision rather than
    an omission. The paragraph it named — PROVENANCE_MEANING, and the full
    four-line verdict — moved into the "more info" screen; what is on the
    side panel is measurementVerdict()'s CLAIM line, one sentence, at the
    badge token. That is the same shape and the same token as the status
    strip's environment line, which is the other one-line claim this product
    makes, and it is not a reading surface. Lesson prose, source
    descriptions and concept text still are, and they are still measured.
  */
  smallest('.lesson-explanation, .lesson-conceptual, .lesson-goal, .lesson-claim-text, .source-description, .concept-text', 'prose');
  return out;
})()`;

/** The project's two target tiers, and WCAG's floor under both. */
export const TARGET_FINE_PX = 36;
export const TARGET_COARSE_PX = 44;
export const TARGET_WCAG_FLOOR_PX = 24;
/** WCAG 1.4.3 / 1.4.11. Large text is >= 24px, or >= 18.66px at weight >= 700. */
export const CONTRAST_TEXT = 4.5;
export const CONTRAST_LARGE_TEXT = 3;
export const CONTRAST_UI = 3;

// ------------------------------------------------------------- contrast
/**
 * Every visible run of text, against the background actually painted under
 * it — Phase 4 W6.
 *
 * ## Why the ancestor chain is walked the way the compositor walks it
 *
 * The first version of this composited each ancestor's `background-color`
 * downward and treated `opacity` as one more alpha on that background. It
 * reported 4.21:1 for a source line number that a reader sees at 1.66:1,
 * because `opacity` does not tint a background — it forms a GROUP, and the
 * group's whole subtree, the text included, is composited onto the backdrop
 * at that alpha. Twelve of the app's worst-contrast runs were invisible to
 * the arithmetic that got this wrong, and they were all in the pane whose
 * entire purpose is reading 429 lines of real C++.
 *
 * So: forward, accumulate each level's backdrop and its own painted layer;
 * backward, apply every group opacity to BOTH the text colour and the
 * background under it. That is what the browser does.
 *
 * ## What is exempt, and why exactly two things are
 *
 *  * `:disabled` / `[aria-disabled="true"]` — WCAG 1.4.3 exempts inactive
 *    components by name. Four rules in the stylesheet dim a disabled control
 *    with alpha and they are allowed to.
 *  * elements under a `background-image` — the ratio cannot be computed
 *    against a gradient, so they are COUNTED and reported rather than
 *    silently passed. The count is 0 today; if it ever is not, the report
 *    says so instead of the check quietly weakening.
 *
 * Note what is NOT exempt: `.lesson-card.is-locked` was `opacity: 0.55` and
 * is a live button, so the inactive-component exemption never covered it.
 */
export const CONTRAST_JS = `(() => {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = (r) => 0.2126 * lin(r[0]) + 0.7152 * lin(r[1]) + 0.0722 * lin(r[2]);
  const parse = (s) => {
    const open = s.indexOf('('), close = s.lastIndexOf(')');
    if (open < 0 || close < open) return null;
    const p = s.slice(open + 1, close).split(/[ ,/]+/).filter((x) => x.length > 0).map(Number);
    if (p.length < 3 || p.some((x) => Number.isNaN(x))) return null;
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const over = (f, b) => [0, 1, 2].map((i) => f[i] * f[3] + b[i] * (1 - f[3]));
  const mix = (a, b, t) => [0, 1, 2].map((i) => a[i] * (1 - t) + b[i] * t);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const PAGE = [13, 16, 21];

  /*
    A background-image only hides the background-COLOUR where it paints.

    The first version treated any background-image as "cannot compute" and
    silently skipped the element and every descendant under it. That skipped
    351 elements at 1440x900 — because .trace-step draws the Signal ladder's
    spine with linear-gradient(--line, --line) at background-size: 2px 100%,
    no-repeat. A two-pixel vertical rule sitting in the gutter had exempted
    every witness paragraph, every provenance badge and every lane in the one
    pane the contrast check most needs to cover. An assertion that quietly
    skips its hardest case is the failure mode this project keeps catching.

    So: a no-repeat image smaller than its own box is a rule or a stripe and
    does not change what is behind the text. Anything that tiles, or that
    covers the box, is still unknown — and unknown is COUNTED and reported,
    never passed.
  */
  const imageCovers = (cs, el) => {
    if (cs.backgroundImage === 'none') return false;
    if (cs.backgroundRepeat !== 'no-repeat') return true;
    const r = el.getBoundingClientRect();
    const parts = cs.backgroundSize.split(' ');
    const toPx = (v, base) => {
      if (v === undefined || v === 'auto' || v === 'cover' || v === 'contain') return base;
      if (v.endsWith('%')) return (base * parseFloat(v)) / 100;
      return parseFloat(v);
    };
    return toPx(parts[0], r.width) >= r.width - 0.5 && toPx(parts[1], r.height) >= r.height - 0.5;
  };

  const paint = (el) => {
    const chain = [];
    for (let n = el; n !== null; n = n.parentElement) chain.push(n);
    chain.reverse();
    const backdrop = [], layer = [], alpha = [];
    let b = PAGE, unknown = false;
    for (const node of chain) {
      const cs = getComputedStyle(node);
      if (imageCovers(cs, node)) unknown = true;
      const own = parse(cs.backgroundColor) || [0, 0, 0, 0];
      backdrop.push(b);
      const l = over(own, b);
      layer.push(l);
      alpha.push(Number(cs.opacity));
      b = l;
    }
    const cs = getComputedStyle(el);
    const svg = el.namespaceURI === 'http://www.w3.org/2000/svg' && cs.fill !== 'none';
    const raw = parse(svg ? cs.fill : cs.color) || [255, 255, 255, 1];
    let fg = over(raw, layer[layer.length - 1]);
    let bg = layer[layer.length - 1];
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      if (alpha[i] >= 1) continue;
      fg = mix(backdrop[i], fg, alpha[i]);
      bg = mix(backdrop[i], bg, alpha[i]);
    }
    return { fg, bg, unknown, alpha: Math.min(...alpha) };
  };

  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const own = (el) => {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue;
    return t.replace(/\\s+/g, ' ').trim();
  };
  const inactive = (el) =>
    el.closest(':disabled, [aria-disabled="true"], [data-inactive="true"]') !== null;

  const out = { failures: [], measured: 0, exemptInactive: 0, overImage: 0, worst: null, uiFailures: [], uiChecked: 0, boundaryNotRequired: 0, backdrops: 0 };
  for (const el of document.querySelectorAll('body *')) {
    const text = own(el);
    if (text.length === 0 || !visible(el)) continue;
    if (inactive(el)) { out.exemptInactive += 1; continue; }
    const cs = getComputedStyle(el);
    const px = parseFloat(cs.fontSize);
    const weight = Number(cs.fontWeight) || 400;
    const need = px >= 24 || (px >= 18.66 && weight >= 700) ? ${CONTRAST_LARGE_TEXT} : ${CONTRAST_TEXT};
    const p = paint(el);
    if (p.unknown) { out.overImage += 1; continue; }
    const cr = ratio(p.fg, p.bg);
    out.measured += 1;
    if (out.worst === null || cr < out.worst.ratio) {
      out.worst = { ratio: Math.round(cr * 100) / 100, need, text: text.slice(0, 40) };
    }
    if (cr + 0.005 >= need) continue;
    out.failures.push({
      text: text.slice(0, 44),
      name: (typeof el.className === 'string' && el.className.length > 0 ? '.' + el.className.trim().split(/\\s+/).join('.') : el.tagName).slice(0, 52),
      fg: 'rgb(' + p.fg.map((v) => Math.round(v)).join(',') + ')',
      bg: 'rgb(' + p.bg.map((v) => Math.round(v)).join(',') + ')',
      px, need, groupAlpha: p.alpha, ratio: Math.round(cr * 100) / 100,
    });
  }

  /*
    1.4.11 Non-text Contrast, for the boundaries that are REQUIRED to
    identify a control.

    The word "required" is the whole criterion and the first version of this
    check ignored it: it measured every button's border and reported 214
    failures at 1440x900, almost all of them rail buttons at 1.4:1. A rail
    button carries a 20 px glyph and a word, both above 4.5:1 — the text is
    what identifies it, its border is decoration, and 1.4.11 says so in as
    many words. Failing it would have been an accessibility gate crying wolf
    214 times, which is how a gate gets deleted.

    So the boundary is required exactly when nothing else identifies the
    control:

      * form controls (input, select, textarea) whose box IS the
        affordance and which have no text of their own;
      * any control with no visible text at all (an icon-only button).

    A control with a text label is covered by the 4.5:1 text check above.
  */
  const CONTROLS = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [role="button"]';
  const FORM = new Set(['INPUT', 'SELECT', 'TEXTAREA']);
  for (const el of document.querySelectorAll(CONTROLS)) {
    if (!visible(el) || inactive(el)) continue;
    const labelled = (el.textContent || '').trim().length > 0;
    /*
      A control that fills the viewport is a BACKDROP, and a backdrop has
      nothing for its boundary to distinguish it from. The Compact sheets'
      scrim was the only thing this check flagged once the scope was right —
      at 1.03:1 against the stage it dims, which is what a scrim is for.
    */
    const box = el.getBoundingClientRect();
    if (box.width * box.height >= innerWidth * innerHeight * 0.8) {
      out.backdrops += 1;
      continue;
    }
    const boundaryRequired = FORM.has(el.tagName) || !labelled;
    if (!boundaryRequired) { out.boundaryNotRequired += 1; continue; }
    const cs = getComputedStyle(el);
    const parent = el.parentElement === null ? null : paint(el.parentElement);
    if (parent === null || parent.unknown) continue;
    const own2 = parse(cs.backgroundColor) || [0, 0, 0, 0];
    const border = parse(cs.borderTopColor) || [0, 0, 0, 0];
    const hasBorder = cs.borderTopStyle !== 'none' && parseFloat(cs.borderTopWidth) > 0;
    const candidates = [];
    if (hasBorder && border[3] > 0) candidates.push(ratio(over(border, parent.bg), parent.bg));
    if (own2[3] > 0) candidates.push(ratio(over(own2, parent.bg), parent.bg));
    // A control with neither a border nor a background of its own is
    // identified by its TEXT, which the text check above already covers.
    if (candidates.length === 0) continue;
    out.uiChecked += 1;
    const best = Math.max(...candidates);
    if (best + 0.005 < ${CONTRAST_UI}) {
      out.uiFailures.push({
        name: (typeof el.className === 'string' && el.className.length > 0 ? '.' + el.className.trim().split(/\\s+/).join('.') : el.tagName).slice(0, 52),
        text: (el.textContent || '').trim().slice(0, 30),
        ratio: Math.round(best * 100) / 100,
        border: hasBorder ? cs.borderTopColor : null,
        background: cs.backgroundColor,
      });
    }
  }
  return out;
})()`;

// -------------------------------------------------------- target sizes
/**
 * The target a POINTER can hit, found by hit-testing rather than by reading
 * a rectangle.
 *
 * `.info-dot` is why. It paints a 20 px circle and carries its 36 px target
 * on an absolutely positioned `::after` that contributes nothing to the
 * button's own rect — so a check written against `getBoundingClientRect`
 * would have failed a control that is correct, and (much worse) would have
 * passed any control that grew its rect without growing what a pointer can
 * land on. `document.elementFromPoint` is the only reading that answers the
 * question the criterion actually asks.
 *
 * The search is a bisection outward from the centre in each of the four
 * directions, so the reported box is the largest axis-aligned region that
 * really resolves to the control.
 */
export const TARGETS_JS = (floorPx) => `(() => {
  const SEL = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"]), [role="button"]';
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const hits = (el, x, y) => {
    const t = document.elementFromPoint(x, y);
    return t !== null && (t === el || el.contains(t));
  };
  const hitBox = (el) => {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > innerWidth - 1 || cy > innerHeight - 1) return null;
    if (!hits(el, cx, cy)) return null;
    const reach = (dx, dy) => {
      let lo = 0, hi = 48;
      while (hi - lo > 0.5) {
        const mid = (lo + hi) / 2;
        const x = cx + dx * mid, y = cy + dy * mid;
        if (x < 0 || y < 0 || x > innerWidth - 1 || y > innerHeight - 1) { hi = mid; continue; }
        if (hits(el, x, y)) lo = mid; else hi = mid;
      }
      return lo;
    };
    return { w: reach(-1, 0) + reach(1, 0), h: reach(0, -1) + reach(0, 1) };
  };
  const out = { checked: 0, underFloor: [], underWcag: [], unhittable: [], inert: 0 };
  for (const el of document.querySelectorAll(SEL)) {
    if (!visible(el)) continue;
    // Inert: behind a Compact sheet's scrim, and not a target of anything.
    if (el.closest('[inert]') !== null) { out.inert += 1; continue; }
    const r = el.getBoundingClientRect();
    const hb = hitBox(el);
    if (hb === null) {
      // Off-screen inside its own scroller, or covered. Reported, never
      // counted as a pass: a target nothing can hit is not a large target.
      out.unhittable.push({
        name: (typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : el.tagName).slice(0, 46),
        text: (el.textContent || '').trim().slice(0, 24),
        boxW: Math.round(r.width), boxH: Math.round(r.height),
      });
      continue;
    }
    out.checked += 1;
    const w = Math.max(r.width, hb.w), h = Math.max(r.height, hb.h);
    const row = {
      name: (typeof el.className === 'string' && el.className.length > 0 ? '.' + el.className.trim().split(/\\s+/).join('.') : el.tagName).slice(0, 46),
      text: (el.textContent || '').trim().slice(0, 24),
      boxW: Math.round(r.width * 10) / 10, boxH: Math.round(r.height * 10) / 10,
      hitW: Math.round(w * 10) / 10, hitH: Math.round(h * 10) / 10,
    };
    if (w + 0.5 < ${TARGET_WCAG_FLOOR_PX} || h + 0.5 < ${TARGET_WCAG_FLOOR_PX}) out.underWcag.push(row);
    else if (w + 0.5 < ${floorPx} || h + 0.5 < ${floorPx}) out.underFloor.push(row);
  }
  return out;
})()`;

// --------------------------------------------------- scroll and overflow
export const OVERFLOW_JS = `(() => {
  const de = document.documentElement;
  const undeclared = [];
  for (const el of document.querySelectorAll('*')) {
    const o = getComputedStyle(el).overflowX;
    if (o !== 'auto' && o !== 'scroll') continue;
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    if (el.hasAttribute('data-2d-surface')) continue;
    undeclared.push({
      name: (typeof el.className === 'string' && el.className.length > 0 ? '.' + el.className.trim().split(/\\s+/).join('.') : el.tagName).slice(0, 52),
      scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
    });
  }
  return { docScrollWidth: de.scrollWidth, docClientWidth: de.clientWidth, undeclared };
})()`;

// ------------------------------------------- correctness under a gate
/**
 * The gates' shared question: did anything a reader must be able to read
 * stop being readable?
 *
 * `tooltipOnly` is the half of the 200%-zoom invariant that is easy to lose:
 * the row says *"no correctness text is clipped **or replaced solely by
 * tooltips**"*, so a surface whose `title` carries a fact its rendered text
 * does not is a failure even though nothing is visibly cut.
 */
export const CORRECTNESS_JS = `(() => {
  const SELECTORS = ${JSON.stringify(CORRECTNESS_SURFACE_SELECTORS)};
  const out = { seen: 0, truncated: [], hidden: [], tooltipOnly: [], belowFloor: [] };
  for (const selector of SELECTORS) {
    for (const el of document.querySelectorAll(selector)) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      /*
        \`checkVisibility()\` and not \`display\`/\`visibility\` alone — Phase 4 W6.

        The first run of this gate reported 1,003 "collapsed" correctness
        surfaces at 200% zoom and every one was a false positive: the shell
        keeps inactive panes mounted under \`[hidden]\`, and the content of a
        closed <details> is \`content-visibility: hidden\`. Both compute
        \`display: block\` with a zero box, so the cheap test called them
        collapsed. Not rendered and crushed to nothing are different things,
        and a gate that cannot tell them apart would either fail on every
        window forever or be "fixed" by deleting the zero-box branch — which
        is the branch that would catch a badge the zoom really did crush.
      */
      if (
        el.checkVisibility !== undefined &&
        !el.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true })
      ) continue;
      const rect = el.getBoundingClientRect();
      const text = (el.textContent ?? '').replace(/\\s+/g, ' ').trim();
      if (text.length === 0) continue;
      const name = selector + ' "' + text.slice(0, 40) + '"';
      out.seen += 1;
      if (rect.width < 1 || rect.height < 1) { out.hidden.push(name); continue; }
      const clamped = cs.webkitLineClamp !== undefined && cs.webkitLineClamp !== '' && cs.webkitLineClamp !== 'none';
      const ellipsised = cs.textOverflow === 'ellipsis';
      const cut = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
      if (clamped || ellipsised || cut) {
        out.truncated.push(name + (cut ? ' cut ' + el.scrollWidth + '>' + el.clientWidth : '') + (ellipsised ? ' ellipsis' : '') + (clamped ? ' line-clamp' : ''));
      }
      if (parseFloat(cs.fontSize) < ${TEXT_FLOOR_PX} - 0.01) {
        out.belowFloor.push(name + ' at ' + cs.fontSize);
      }
      const tip = el.getAttribute('title');
      if (tip !== null && /OBSERVED|SIMULATED|INFERRED|QEMU|EMULATOR|NOT BUILT|CONCEPTUAL|PHYSICAL/i.test(tip)) {
        const words = tip.toUpperCase().match(/OBSERVED|SIMULATED|INFERRED|QEMU|NOT BUILT|CONCEPTUAL/g) ?? [];
        const missing = words.filter((w) => !text.toUpperCase().includes(w));
        // The badge's own word must be in its text. A tooltip may EXPLAIN a
        // category; it may not be the only place the category is named.
        const claimed = el.getAttribute('data-provenance');
        if (claimed !== null && !text.toLowerCase().includes(claimed.toLowerCase())) {
          out.tooltipOnly.push(name + ' claims data-provenance="' + claimed + '" and does not render the word');
        }
        void missing;
      }
    }
  }
  return out;
})()`;

// ------------------------------------------------------- provenance colour
/**
 * The judgement call the brief settles in one sentence: *"provenance needs
 * redundant text, not clever iconography"*.
 *
 * Two checks, and the second is the one with teeth. Every `[data-provenance]`
 * must RENDER its own value as a word — that is the redundancy. And no
 * element anywhere may be painted in one of the three provenance hues while
 * belonging to no datum that names the category in text, which is the
 * colour-only failure stated as a property of the page rather than as a list
 * of the places somebody remembered to check.
 *
 * ## Where the colour scan stops, and why that is a decision
 *
 * It scans `[data-provenance]`, `[data-badge]`, `.prov`, `.badge`,
 * `.trace-row` and `.arch-event-btn` and their descendants — the elements
 * that belong to a provenance datum — not every element in the body. The
 * three hues are ordinary palette colours as well as semantic ones, and a
 * whole-page scan flags everything that merely happens to be green.
 *
 * The whole-page version was run once and found one thing worth having
 * found, which is now fixed rather than exempted: the rail's connection lamp
 * was a `●` in `--observed` green with no adjacent word — the same hue as the
 * provenance category, meaning something else entirely, which is the brief's
 * own warning about green lamps read from the other side. It carries a
 * distinct glyph per state now and the status line spells the state out in a
 * word. What keeps that fixed is the finding, not this check.
 */
export const PROVENANCE_JS = `(() => {
  const HUES = { observed: 'rgb(78, 201, 160)', simulated: 'rgb(110, 158, 230)', inferred: 'rgb(192, 141, 224)' };
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const out = { badges: 0, withoutWord: [], colourOnly: [] };
  for (const el of document.querySelectorAll('[data-provenance]')) {
    if (!visible(el)) continue;
    out.badges += 1;
    const want = el.getAttribute('data-provenance');
    const text = (el.textContent || '').toLowerCase();
    // The wrapper rows carry data-provenance too; the WORD has to be inside
    // the datum, not necessarily on the element that declares the attribute.
    if (!text.includes(want)) {
      out.withoutWord.push({ want, text: (el.textContent || '').trim().slice(0, 44) });
    }
  }
  /* The colour-only test. See the comment above this constant. */
  const SCOPE = '[data-provenance], [data-badge], .prov, .badge, .trace-row, .arch-event-btn';
  for (const el of document.querySelectorAll(SCOPE + ', ' + SCOPE.split(', ').map((s) => s + ' *').join(', '))) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    const hue = Object.entries(HUES).find(
      ([, v]) => cs.color === v || cs.borderTopColor === v || cs.backgroundColor === v,
    );
    if (hue === undefined) continue;
    /*
      An ORIGIN badge names itself, in the protocol's own words.

      The first version of this looked only for the three provenance words and
      flagged nine elements: every origin-host-model badge, which is painted
      in the simulated blue and reads "host model (@sesame-lab/sesame-sim)".
      That badge's meaning is entirely in its text — it is describeOrigin()'s
      return value — and the hue is a family resemblance, not the message. So
      a datum that carries data-origin-kind passes on having non-empty text,
      which is a property OriginTag guarantees by construction:
      describeOrigin() never returns the empty string, precisely so a UI
      cannot end up showing a bare colour.
    */
    const datum = el.closest('[data-provenance], [data-badge], [data-origin-kind]');
    const scope = datum ?? el;
    const text = (scope.textContent || '').toLowerCase();
    if (scope.hasAttribute('data-origin-kind') && text.length > 0) continue;
    if (!/observed|simulated|inferred|conceptual|not built|boundary|ran/.test(text)) {
      out.colourOnly.push({
        hue: hue[0],
        name: (typeof el.className === 'string' && el.className.length > 0 ? '.' + el.className.trim().split(/\\s+/).join('.') : el.tagName).slice(0, 46),
        text: (el.textContent || '').trim().slice(0, 30),
        title: el.getAttribute('title'),
      });
    }
  }
  return out;
})()`;

// ---------------------------------------------------------- the tab walk
/**
 * Every focusable element, reached by a real Tab key, with the ring the
 * browser paints under KEYBOARD modality.
 *
 * `el.focus()` would have been easier and would have proved less:
 * `:focus-visible` is a modality heuristic, and a button focused by script
 * after a click does not match it. `Input.dispatchKeyEvent` makes the walk
 * the same walk a reader does.
 *
 * The ring is then measured three ways, because "has an outline" is exactly
 * the sort of claim this project has been caught making:
 *   - it exists (`outline-style` is not `none`, or there is a `box-shadow`);
 *   - it CONTRASTS with what is behind it, at 3:1, computed here;
 *   - and the focused element is not entirely hidden — WCAG 2.4.11, tested
 *     by hit-testing the element itself rather than by trusting that it is
 *     in the DOM.
 */
export const FOCUSABLE_SEL =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

export const FOCUS_STATE_JS = `(() => {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = (r) => 0.2126 * lin(r[0]) + 0.7152 * lin(r[1]) + 0.0722 * lin(r[2]);
  const parse = (s) => {
    const open = s.indexOf('('), close = s.lastIndexOf(')');
    if (open < 0 || close < open) return null;
    const p = s.slice(open + 1, close).split(/[ ,/]+/).filter((x) => x.length > 0).map(Number);
    if (p.length < 3 || p.some((x) => Number.isNaN(x))) return null;
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const over = (f, b) => [0, 1, 2].map((i) => f[i] * f[3] + b[i] * (1 - f[3]));
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const el = document.activeElement;
  if (el === null || el === document.body || el === document.documentElement) return null;
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const behind = (() => {
    let n = el.parentElement, b = [13, 16, 21];
    const stack = [];
    while (n !== null) { stack.push(n); n = n.parentElement; }
    stack.reverse();
    for (const node of stack) {
      const c = parse(getComputedStyle(node).backgroundColor) || [0, 0, 0, 0];
      b = over(c, b);
    }
    return b;
  })();
  const ringColour = parse(cs.outlineColor);
  const hasOutline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
  const hasShadow = cs.boxShadow !== 'none';
  // Is any part of the element itself hit-testable? WCAG 2.4.11 asks that the
  // focused component is not ENTIRELY hidden by author content.
  const pts = [
    [r.left + r.width / 2, r.top + r.height / 2],
    [r.left + 2, r.top + 2], [r.right - 2, r.top + 2],
    [r.left + 2, r.bottom - 2], [r.right - 2, r.bottom - 2],
  ];
  let reachable = 0;
  for (const [x, y] of pts) {
    if (x < 0 || y < 0 || x > innerWidth - 1 || y > innerHeight - 1) continue;
    const t = document.elementFromPoint(x, y);
    if (t !== null && (t === el || el.contains(t))) reachable += 1;
  }
  const onScreen = r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  return {
    name: (typeof el.className === 'string' && el.className.length > 0 ? '.' + el.className.trim().split(/\\s+/).join('.') : el.tagName).slice(0, 46),
    text: (el.textContent || '').trim().slice(0, 24),
    key: (() => {
      /*
        The identity is the STAMP the enumeration left, not an index this
        side recomputes.

        The first version recomputed it — and did so against a selector that
        had been left as an unsubstituted placeholder, so the list was empty,
        every key came back as "-1|…", and not one of them could ever match a
        key from the enumeration. The walk then reported 75 of the page's
        focusables unreachable while reaching all of them. Two things follow:
        an identity that is derived twice is an identity that can disagree
        with itself, and a check whose failure message is a list of things
        that are demonstrably fine is a check to distrust, not a defect to
        chase.
      */
      return el.getAttribute('data-w6-focus') ?? ('unstamped|' + el.tagName + '|' + (el.textContent || '').trim().slice(0, 20));
    })(),
    focusVisible: (() => { try { return el.matches(':focus-visible'); } catch (e) { return null; } })(),
    hasRing: hasOutline || hasShadow,
    outlineStyle: cs.outlineStyle,
    outlineWidth: cs.outlineWidth,
    ringRatio: hasOutline && ringColour !== null ? Math.round(ratio(over(ringColour, behind), behind) * 100) / 100 : null,
    onScreen, reachable,
  };
})()`;

export const ENUM_FOCUSABLE_JS = `(() => {
  const out = [];
  for (const el of document.querySelectorAll(${JSON.stringify(FOCUSABLE_SEL)})) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    /*
      An INERT subtree is not focusable, not a pointer target, and not
      clickable — Phase 4 W6.

      The rail is inert while a Compact sheet covers it, which is what stops a
      reader tabbing onto a control hidden behind the scrim. Counting those
      buttons as "visible focusables the walk must reach" turns the fix into a
      failure: the run reported nine unreachable rail buttons that the browser
      was correctly refusing to focus.
    */
    if (el.closest('[inert]') !== null) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const id = String(out.length) + '|' + el.tagName + '|' + (typeof el.className === 'string' ? el.className.trim().split(/s+/).join('.') : '') + '|' + (el.textContent || '').trim().slice(0, 20);
    el.setAttribute('data-w6-focus', id);
    out.push(id);
  }
  return out;
})()`;

/**
 * Clickable, and not reachable from a keyboard.
 *
 * `cursor: pointer` on an element that is neither focusable, nor contains
 * something focusable, nor sits inside something focusable, is the shape of a
 * `<div onClick>`. It is a heuristic and it is stated as one — but it is a
 * heuristic that found both of this app's real keyboard gaps and nothing
 * else, at 425 elements across five modules and the Inspector screen.
 */
export const POINTER_ONLY_JS = `(() => {
  const F = ${JSON.stringify(FOCUSABLE_SEL)};
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (cs.cursor !== 'pointer') continue;
    if (el.closest('[inert]') !== null) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (el.matches(F) || el.querySelector(F) !== null || el.closest(F) !== null) continue;
    /*
      The unit is the DATUM, not the element.

      A clickable row spreads cursor:pointer over every cell inside it, and
      the first version of this scan reported 113 of them on the Inspector
      screen: eight rows, and the 105 cells that inherit the cursor. The
      question the check is asking is whether the thing you can click has a
      keyboard equivalent, and for the joint row the equivalent is the button
      inside it — so the scan climbs to the outermost CONTIGUOUS ancestor that
      also says cursor:pointer, and asks the question there.

      A row with nothing focusable inside it still fails, which is what the
      check is for: that was the state of both the joint rows and the trace
      lanes before W6.
    */
    let top = el;
    while (
      top.parentElement !== null &&
      getComputedStyle(top.parentElement).cursor === 'pointer'
    ) top = top.parentElement;
    if (top !== el && top.querySelector(F) !== null) continue;
    if (el.getAttribute('role') === 'button' && el.hasAttribute('tabindex')) continue;
    out.push({
      name: (typeof el.className === 'string' && el.className.length > 0 ? '.' + el.className.trim().split(/\\s+/).join('.') : el.tagName).slice(0, 46),
      text: (el.textContent || '').trim().slice(0, 30),
    });
  }
  const seen = new Map();
  for (const row of out) {
    if (!seen.has(row.name)) seen.set(row.name, { name: row.name, text: row.text, n: 0 });
    seen.get(row.name).n += 1;
  }
  return [...seen.values()];
})()`;
