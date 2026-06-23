/*
 * Voltron Engine - animated centerpiece (Phase 2)
 * --------------------------------------------------------------------------
 * Two progressive-enhancement layers on top of the static, zero-JS baselines:
 *   1. HERO ASSEMBLY  (#hero-centerpiece) - GSAP timeline. ~51 tier-colored
 *      nodes scatter in, assemble into the 1 -> N -> 51 tier structure with
 *      edges lighting cyan -> amber, then resolve onto the static logo mark.
 *   2. DISPATCH GRAPH (#dispatch-graph-canvas) - vasturiano force-graph, lazily
 *      loaded as section 4 approaches; the same topology as a live, draggable
 *      graph with directional link particles. The hero's formed state
 *      cross-fades into it for visual continuity.
 *
 * HARD RULES honored here:
 *   - prefers-reduced-motion: no assembly, static states shown, Replay hidden.
 *   - low-power / mobile: reduced node count for the hero; force-graph skipped
 *     (the static tier SVG stays).
 *   - CDN failure: every catch path leaves the existing static SVG / <img>
 *     baselines visible. Never blank.
 *   - Animate transform / opacity only (compositor-friendly). The idle pulse is
 *     a CSS animation so the GSAP timeline can be torn down after the handoff.
 *
 * RENDERER SEAM: selectHeroRenderer() is the single switch point. The locked
 * hero is Option A (GSAP). A future Option B (Three.js GPGPU particle morph)
 * could swap in here behind a capability check (WebGL2 + high power) WITHOUT
 * touching the bootstrap below. Do not build Three.js here.
 */
(function () {
  'use strict';

  var mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  var REDUCED_MOTION = !!(mq && mq.matches);
  var LOW_POWER =
    (typeof navigator !== 'undefined' && navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) ||
    (window.matchMedia && window.matchMedia('(max-width: 640px)').matches);

  var SVGNS = 'http://www.w3.org/2000/svg';
  var css = getComputedStyle(document.documentElement);
  function token(name, fallback) {
    var v = css.getPropertyValue(name);
    return (v && v.trim()) || fallback;
  }
  var TIER = {
    1: token('--tier-1', '#f59e0b'),
    2: token('--tier-2', '#d946ef'),
    3: token('--tier-3', '#22d3ee')
  };
  var CORE = token('--engine-core', '#22d3ee');
  var FORGE = token('--engine-forge', '#f59e0b');

  // ------------------------------------------------------------------
  // Shared topology model: 1 coordinator -> N sub-managers -> micro-agents.
  // `target` caps the total node count so low-power devices get a lighter tree.
  // ------------------------------------------------------------------
  function buildTopology(target) {
    var total = Math.max(8, target || 51);
    var subCount = total >= 40 ? 6 : total >= 20 ? 4 : 3;
    var microCount = total - 1 - subCount;

    var nodes = [];
    var links = [];

    // Tier 1 - the lone coordinator at the apex (matches logo core at 128,48).
    nodes.push({ id: 'c0', tier: 1, role: 'coordinator', x: 128, y: 48 });

    // Tier 2 - sub-managers spread across a row.
    var subs = [];
    for (var s = 0; s < subCount; s++) {
      var sx = 36 + (subCount === 1 ? 92 : (s * (184 / (subCount - 1))));
      var id = 'sm' + s;
      nodes.push({ id: id, tier: 2, role: 'sub-manager', x: sx, y: 122 });
      links.push({ source: 'c0', target: id });
      subs.push({ id: id, x: sx });
    }

    // Tier 3 - micro-agents fanned out under their parent sub-manager.
    for (var m = 0; m < microCount; m++) {
      var parent = subs[m % subCount];
      var siblingIdx = Math.floor(m / subCount);
      var spread = ((m % subCount) - (subCount - 1) / 2); // unused jitter seed kept simple
      var col = (m % 3) - 1; // -1, 0, 1 columns under each parent
      var row = siblingIdx % 3;
      var mx = parent.x + col * 18 + (((m * 53) % 7) - 3); // deterministic jitter
      var my = 182 + row * 22;
      mx = Math.max(14, Math.min(242, mx));
      var mid = 'ma' + m;
      nodes.push({ id: mid, tier: 3, role: 'micro-agent', x: mx, y: my });
      links.push({ source: parent.id, target: mid });
    }

    return { nodes: nodes, links: links };
  }

  // Map a node id -> node (for resolving link endpoints in the SVG layer).
  function indexById(nodes) {
    var idx = {};
    for (var i = 0; i < nodes.length; i++) idx[nodes[i].id] = nodes[i];
    return idx;
  }

  // ------------------------------------------------------------------
  // RENDERER SEAM
  // ------------------------------------------------------------------
  function selectHeroRenderer() {
    // Option B (Three.js) capability check would go here, e.g.:
    //   if (hasWebGL2() && !LOW_POWER && !REDUCED_MOTION) return 'three';
    // For now Option A (GSAP) is the locked hero.
    return (window.gsap && !REDUCED_MOTION) ? 'gsap' : 'static';
  }

  // ------------------------------------------------------------------
  // HERO ASSEMBLY (Option A - GSAP)
  // ------------------------------------------------------------------
  function initHeroAssembly(container) {
    var gsap = window.gsap;
    if (!gsap) return null;

    // Register the free plugins if they loaded; everything degrades if absent.
    var hasMotionPath = !!window.MotionPathPlugin;
    try {
      var toReg = [];
      if (hasMotionPath) toReg.push(window.MotionPathPlugin);
      if (toReg.length) gsap.registerPlugin.apply(gsap, toReg);
    } catch (e) { /* registration is best-effort */ }

    var logo = container.querySelector('img');
    var topo = buildTopology(LOW_POWER ? 20 : 51);
    var idx = indexById(topo.nodes);

    // Build the assembly stage (an inline SVG layered over the static logo).
    var stage = document.createElement('div');
    stage.className = 'hero__stage';
    stage.setAttribute('aria-hidden', 'true');

    var svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 256 256');
    svg.setAttribute('class', 'hero__stage-svg');

    // Defs: a cyan -> amber gradient so edges read as "lighting" when revealed.
    var defs = document.createElementNS(SVGNS, 'defs');
    var grad = document.createElementNS(SVGNS, 'linearGradient');
    grad.setAttribute('id', 'cpEdgeGrad');
    grad.setAttribute('gradientUnits', 'userSpaceOnUse');
    grad.setAttribute('x1', '40'); grad.setAttribute('y1', '40');
    grad.setAttribute('x2', '216'); grad.setAttribute('y2', '224');
    var st1 = document.createElementNS(SVGNS, 'stop');
    st1.setAttribute('offset', '0'); st1.setAttribute('stop-color', CORE);
    var st2 = document.createElementNS(SVGNS, 'stop');
    st2.setAttribute('offset', '1'); st2.setAttribute('stop-color', FORGE);
    grad.appendChild(st1); grad.appendChild(st2);
    defs.appendChild(grad);
    svg.appendChild(defs);

    // Edge layer (paths, so MotionPath can ride one during the finale).
    var edgeLayer = document.createElementNS(SVGNS, 'g');
    edgeLayer.setAttribute('fill', 'none');
    edgeLayer.setAttribute('stroke', 'url(#cpEdgeGrad)');
    edgeLayer.setAttribute('stroke-width', '2');
    edgeLayer.setAttribute('stroke-linecap', 'round');
    var edgeEls = [];
    var firstTrunkPath = null;
    for (var e = 0; e < topo.links.length; e++) {
      var a = idx[topo.links[e].source], b = idx[topo.links[e].target];
      if (!a || !b) continue;
      var p = document.createElementNS(SVGNS, 'path');
      p.setAttribute('d', 'M' + a.x + ' ' + a.y + ' L' + b.x + ' ' + b.y);
      p.setAttribute('opacity', '0');
      edgeLayer.appendChild(p);
      edgeEls.push(p);
      if (!firstTrunkPath && a.tier === 1) firstTrunkPath = p;
    }
    svg.appendChild(edgeLayer);

    // Node layer (circles; transform-origin defaults to each circle's center).
    var nodeLayer = document.createElementNS(SVGNS, 'g');
    var nodeEls = [];
    var radius = { 1: 11, 2: 7, 3: 4 };
    for (var n = 0; n < topo.nodes.length; n++) {
      var nd = topo.nodes[n];
      var c = document.createElementNS(SVGNS, 'circle');
      c.setAttribute('cx', nd.x);
      c.setAttribute('cy', nd.y);
      c.setAttribute('r', radius[nd.tier]);
      c.setAttribute('fill', TIER[nd.tier]);
      c.setAttribute('opacity', '0');
      nodeLayer.appendChild(c);
      nodeEls.push({ el: c, tier: nd.tier });
    }
    svg.appendChild(nodeLayer);

    // MotionPath pulse rider (a single bright dot that travels a trunk edge).
    var pulse = document.createElementNS(SVGNS, 'circle');
    pulse.setAttribute('r', '3.5');
    pulse.setAttribute('fill', FORGE);
    pulse.setAttribute('opacity', '0');
    svg.appendChild(pulse);

    stage.appendChild(svg);
    container.appendChild(stage);

    // Build the timeline. We scatter each node from a random offset (transform
    // only) and assemble to its resting place (x/y back to 0 == its cx/cy).
    var tl = gsap.timeline({ paused: true, onComplete: function () {
      container.classList.remove('is-animating');
      container.classList.add('is-formed');
    }});

    // 1) Scatter in - tier by tier.
    var byTier = function (t) { return nodeEls.filter(function (o) { return o.tier === t; }).map(function (o) { return o.el; }); };
    function scatterFrom() {
      var arr = [];
      for (var i = 0; i < nodeEls.length; i++) {
        var ang = (i * 137.5) * Math.PI / 180; // golden-angle scatter, deterministic
        var dist = 70 + ((i * 29) % 60);
        arr.push({ el: nodeEls[i].el, dx: Math.cos(ang) * dist, dy: Math.sin(ang) * dist });
      }
      return arr;
    }
    var scatter = scatterFrom();
    // Prime scattered, invisible start state.
    for (var k = 0; k < scatter.length; k++) {
      gsap.set(scatter[k].el, { x: scatter[k].dx, y: scatter[k].dy, scale: 0.2, opacity: 0, transformOrigin: '50% 50%' });
    }

    tl.to(byTier(1), { opacity: 1, scale: 1, x: 0, y: 0, duration: 0.5, ease: 'back.out(1.6)' }, 0.0);
    tl.to(scatter.filter(function (o) { return nodeEls.find(function (x) { return x.el === o.el; }).tier === 2; }).map(function (o) { return o.el; }),
      { opacity: 1, scale: 1, x: 0, y: 0, duration: 0.6, stagger: 0.05, ease: 'power3.out' }, 0.25);
    tl.to(byTier(3),
      { opacity: 1, scale: 1, x: 0, y: 0, duration: 0.7, stagger: { each: 0.015, from: 'random' }, ease: 'power3.out' }, 0.5);

    // 2) Edges light cyan -> amber (revealed via opacity over the gradient).
    tl.to(edgeEls, { opacity: 0.85, duration: 0.5, stagger: 0.01, ease: 'power1.out' }, 0.85);

    // 3) MotionPath dispatch pulse riding a trunk edge (guarded).
    if (hasMotionPath && firstTrunkPath) {
      tl.set(pulse, { opacity: 1 }, 1.0);
      tl.to(pulse, {
        duration: 0.7,
        ease: 'power1.inOut',
        motionPath: { path: firstTrunkPath, align: firstTrunkPath, alignOrigin: [0.5, 0.5] }
      }, 1.0);
      tl.to(pulse, { opacity: 0, duration: 0.2 }, 1.6);
    }

    // 4) Resolve onto the static logo mark: fade the formed graph down to a
    //    faint echo and bring the real logo up.
    tl.to(stage, { opacity: 0.18, duration: 0.6, ease: 'power2.inOut' }, 1.55);
    if (logo) tl.to(logo, { opacity: 1, scale: 1, duration: 0.6, ease: 'power2.out' }, 1.6);

    function play() {
      container.classList.remove('is-formed');
      container.classList.add('is-animating');
      if (logo) gsap.set(logo, { opacity: 0, scale: 0.94, transformOrigin: '50% 50%' });
      gsap.set(stage, { opacity: 1 });
      tl.restart();
    }

    function destroy() {
      // Kill the timeline but keep the resolved state (CSS .is-formed) intact.
      try { tl.kill(); } catch (e) {}
      container.classList.remove('is-animating');
      container.classList.add('is-formed');
      if (logo) gsap.set(logo, { opacity: 1, scale: 1, clearProps: 'transform' });
      gsap.set(stage, { opacity: 0.18 });
    }

    return { play: play, destroy: destroy, timeline: tl };
  }

  // ------------------------------------------------------------------
  // DISPATCH FORCE-GRAPH (Option C) - lazily loaded near section 4.
  // ------------------------------------------------------------------
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('failed to load ' + src)); };
      document.head.appendChild(s);
    });
  }

  function initDispatchGraph(figure) {
    if (REDUCED_MOTION || LOW_POWER) return; // keep the static tier SVG baseline
    if (figure.dataset.graphReady) return;
    figure.dataset.graphReady = '1';

    var src = figure.getAttribute('data-forcegraph-src');
    if (!src) return;

    loadScript(src).then(function () {
      var FG = window.ForceGraph;
      if (typeof FG !== 'function') return; // unexpected build -> keep static SVG

      var mount = document.createElement('div');
      mount.className = 'dispatch-graph__live';
      var baselineSvg = figure.querySelector('svg');
      figure.insertBefore(mount, figure.querySelector('figcaption'));

      var width = Math.max(280, mount.clientWidth || figure.clientWidth || 720);
      var height = Math.round(Math.min(width * 0.52, 360));

      var topo = buildTopology(51);
      var nodes = topo.nodes.map(function (n) {
        return { id: n.id, tier: n.tier, role: n.role };
      });
      var links = topo.links.map(function (l) { return { source: l.source, target: l.target }; });

      var sizeByTier = { 1: 9, 2: 5, 3: 2.5 };

      var Graph;
      try {
        Graph = FG()(mount); // long-standing factory API
      } catch (e1) {
        try { Graph = new FG(mount); } catch (e2) { return; } // keep static on failure
      }

      Graph
        .graphData({ nodes: nodes, links: links })
        .backgroundColor('rgba(0,0,0,0)')
        .width(width)
        .height(height)
        .nodeRelSize(4)
        .nodeVal(function (n) { return sizeByTier[n.tier] || 2; })
        .nodeColor(function (n) { return TIER[n.tier]; })
        .nodeLabel(function (n) { return n.role + ' · tier ' + n.tier; })
        .linkColor(function () { return 'rgba(139,151,168,0.35)'; })
        .linkWidth(1)
        .linkDirectionalParticles(2)
        .linkDirectionalParticleWidth(2)
        .linkDirectionalParticleColor(function () { return CORE; })
        .enableNodeDrag(true)
        .cooldownTicks(120);

      if (Graph.d3VelocityDecay) Graph.d3VelocityDecay(0.3);

      // Cross-fade: the static topology hands off to the live graph.
      figure.classList.add('is-live');
      if (baselineSvg) baselineSvg.setAttribute('aria-hidden', 'true');

      // Keep size responsive without thrashing.
      var resizeRAF = 0;
      window.addEventListener('resize', function () {
        if (resizeRAF) return;
        resizeRAF = window.requestAnimationFrame(function () {
          resizeRAF = 0;
          var w = Math.max(280, mount.clientWidth || width);
          Graph.width(w).height(Math.round(Math.min(w * 0.52, 360)));
        });
      });
    }).catch(function () {
      // CDN failure: the static tier SVG remains visible. Never blank.
      figure.dataset.graphReady = '';
    });
  }

  // ------------------------------------------------------------------
  // Replay control
  // ------------------------------------------------------------------
  function buildReplay(container, onReplay) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hero__replay';
    btn.textContent = 'Replay';
    btn.setAttribute('aria-label', 'Replay the hero assembly animation');
    btn.addEventListener('click', onReplay);
    container.parentNode.insertBefore(btn, container.nextSibling);
    return btn;
  }

  // ------------------------------------------------------------------
  // Bootstrap
  // ------------------------------------------------------------------
  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  ready(function () {
    var centerpiece = document.getElementById('hero-centerpiece');
    var graphFigure = document.getElementById('dispatch-graph-canvas');
    var heroApi = null;

    // ---- HERO ----
    if (centerpiece) {
      if (selectHeroRenderer() === 'gsap') {
        heroApi = initHeroAssembly(centerpiece);
        if (heroApi) {
          var played = false;
          buildReplay(centerpiece, function () { heroApi.play(); });
          // Viewport-gated: play once when the hero scrolls into view.
          if ('IntersectionObserver' in window) {
            var io = new IntersectionObserver(function (entries) {
              for (var i = 0; i < entries.length; i++) {
                if (entries[i].isIntersecting && !played) {
                  played = true;
                  heroApi.play();
                  io.disconnect();
                }
              }
            }, { threshold: 0.25 });
            io.observe(centerpiece);
          } else {
            heroApi.play();
          }
        }
      }
      // Reduced-motion / no-GSAP: the static <img> baseline simply stays, and
      // no Replay control is added (hidden / no-op by absence).
    }

    // ---- DISPATCH GRAPH handoff ----
    if (graphFigure) {
      if (REDUCED_MOTION || LOW_POWER) {
        // Static tier SVG is the experience; nothing to load.
      } else if ('IntersectionObserver' in window) {
        var gio = new IntersectionObserver(function (entries) {
          for (var i = 0; i < entries.length; i++) {
            if (entries[i].isIntersecting) {
              initDispatchGraph(graphFigure);
              // Tear down the hero timeline once the handoff has happened.
              if (heroApi) { heroApi.destroy(); heroApi = null; }
              gio.disconnect();
            }
          }
        }, { rootMargin: '200px 0px' });
        gio.observe(graphFigure);
      } else {
        initDispatchGraph(graphFigure);
      }
    }
  });
})();
