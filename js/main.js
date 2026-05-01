/**
 * LastSignal — your EchoLife onchain
 * Main JavaScript
 *
 * Author:  Maxiq (@cryptomaxiq)
 * Project: LastSignal
 * Built on: Ritual Chain
 *
 * Sections:
 *  1. Canvas Particle Background
 *  2. Scroll Reveal (Intersection Observer)
 *  3. Waitlist Form Handlers
 */

// ── CANVAS PARTICLE BACKGROUND ──
  const canvas = document.getElementById('bg-canvas');
  const ctx = canvas.getContext('2d');
  let W, H, particles = [], lines = [];

  function resize() {
    W = canvas.width = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }

  class Particle {
    constructor() { this.reset(); }
    reset() {
      this.x = Math.random() * W;
      this.y = Math.random() * H;
      this.size = Math.random() * 1.5 + 0.3;
      this.speedX = (Math.random() - 0.5) * 0.3;
      this.speedY = (Math.random() - 0.5) * 0.3;
      this.opacity = Math.random() * 0.5 + 0.1;
      this.color = Math.random() > 0.6 ? '124,92,191' : Math.random() > 0.5 ? '77,217,172' : '160,126,232';
    }
    update() {
      this.x += this.speedX;
      this.y += this.speedY;
      if (this.x < 0 || this.x > W || this.y < 0 || this.y > H) this.reset();
    }
    draw() {
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${this.color},${this.opacity})`;
      ctx.fill();
    }
  }

  // Glowing orbs
  const orbs = [
    { x: 0.15, y: 0.2, r: 350, color: '80,40,160', op: 0.12 },
    { x: 0.85, y: 0.1, r: 280, color: '40,130,100', op: 0.08 },
    { x: 0.5, y: 0.8, r: 320, color: '100,60,180', op: 0.07 },
  ];

  function drawOrbs() {
    orbs.forEach(o => {
      const grd = ctx.createRadialGradient(o.x*W, o.y*H, 0, o.x*W, o.y*H, o.r);
      grd.addColorStop(0, `rgba(${o.color},${o.op})`);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, W, H);
    });
  }

  function init() {
    resize();
    particles = Array.from({ length: 80 }, () => new Particle());
  }

  function animate() {
    ctx.clearRect(0, 0, W, H);
    drawOrbs();
    particles.forEach(p => { p.update(); p.draw(); });

    // Draw connections
    particles.forEach((a, i) => {
      particles.slice(i+1).forEach(b => {
        const dist = Math.hypot(a.x-b.x, a.y-b.y);
        if (dist < 100) {
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.strokeStyle = `rgba(124,92,191,${0.08*(1-dist/100)})`;
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      });
    });

    requestAnimationFrame(animate);
  }

  window.addEventListener('resize', () => { resize(); });
  init();
  animate();

  // ── SCROLL REVEAL ──
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('visible'); });
  }, { threshold: 0.15 });

  document.querySelectorAll('.insight-card, .step').forEach(el => observer.observe(el));

  // ── WAITLIST SUBMIT ──
  function handleSubmit() {
    const email = document.getElementById('email-input').value;
    if (!email || !email.includes('@')) {
      document.getElementById('email-input').style.borderBottom = '1px solid red';
      return;
    }
    document.getElementById('form-wrap').style.display = 'none';
    document.getElementById('success-msg').style.display = 'block';
  }

  function handleSubmit2() {
    const email = document.getElementById('email-input-2').value;
    if (!email || !email.includes('@')) return;
    document.getElementById('form-wrap-2').style.display = 'none';
    document.getElementById('success-msg-2').style.display = 'block';
  }