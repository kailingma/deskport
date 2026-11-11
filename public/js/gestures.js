// Turns finger movement into discrete scroll steps, with momentum after the finger lifts.

export function createScroller({ stepPx, onStep, maxVelocity = 3 }) {
  const step = () => (typeof stepPx === 'function' ? stepPx() : stepPx);
  let acc = 0;
  let velocity = 0; // px per ms
  let lastT = 0;
  let raf = 0;

  function feed(dy) {
    acc += dy;
    const size = step();
    const steps = Math.trunc(acc / size);
    if (steps) {
      acc -= steps * size;
      onStep(steps);
    }
  }

  return {
    start(t) {
      cancelAnimationFrame(raf);
      acc = 0;
      velocity = 0;
      lastT = t;
    },
    move(dy, t) {
      const dt = Math.max(1, t - lastT);
      lastT = t;
      const v = Math.max(-maxVelocity, Math.min(maxVelocity, dy / dt));
      velocity = 0.7 * v + 0.3 * velocity;
      feed(dy);
    },
    release(t) {
      if (t - lastT > 80 || Math.abs(velocity) < 0.25) return;
      let prev = performance.now();
      const tick = (now) => {
        const dt = now - prev;
        prev = now;
        velocity *= 0.95 ** (dt / 16);
        if (Math.abs(velocity) < 0.04) return;
        feed(velocity * dt);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    },
    stop() {
      cancelAnimationFrame(raf);
      velocity = 0;
    },
  };
}

export const touchMid = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
export const touchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
