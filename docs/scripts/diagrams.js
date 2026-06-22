/*
 * Phase-3 explanatory diagrams: scroll-reveal choreography.
 *
 * Progressive enhancement only. The inline SVGs are fully legible with no JS and
 * with prefers-reduced-motion enabled. This script merely fades/staggers the
 * `[data-reveal]` groups into view; it NEVER hides anything via CSS, so if it
 * does not run (reduced motion, no GSAP, JS off) every diagram stays visible.
 */
(function () {
  'use strict';

  var reduce = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Reduced motion or no GSAP: leave the static SVG exactly as authored.
  if (reduce || !window.gsap) return;

  var gsap = window.gsap;

  function reveal(fig) {
    var items = fig.querySelectorAll('[data-reveal]');
    if (!items.length) return;
    gsap.set(items, { opacity: 0, y: 14 });
    var played = false;
    function play() {
      if (played) return;
      played = true;
      gsap.to(items, {
        opacity: 1,
        y: 0,
        duration: 0.5,
        stagger: 0.08,
        ease: 'power2.out'
      });
    }
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            play();
            io.disconnect();
          }
        });
      }, { threshold: 0.2 });
      io.observe(fig);
    } else {
      play();
    }
  }

  function init() {
    var diagrams = document.querySelectorAll('.diagram');
    Array.prototype.forEach.call(diagrams, reveal);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
