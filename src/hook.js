      // ---------- automation hook (injected) ----------
      const AUTO = { over: false, startedAt: 0, overAt: 0 };
      window.__auto = AUTO;
      window.__trace = [];
      window.__crash = null;
      let __prevSt = state, __frameC = 0;
      window.__start = function () {
        if (state === 'menu' || state === 'over') {
          window.__trace = []; window.__crash = null; __prevSt = state; __frameC = 0;
          start(); AUTO.over = false; AUTO.startedAt = performance.now();
        }
      };
      window.__gstate = function () {
        return { state: state, lane: lane, score: Math.round(score), dist: Math.round(dist),
                 stops: stops, coinsGot: coinsGot, level: level, v: Math.round(v),
                 shield: Math.round(shield * 10) / 10, carrying: carrying,
                 role: roleKey, city: cityKey, best: getBest(roleKey) };
      };
      // End the run with a genuine collision: drop an obstacle into the car's lane at its position.
      // shield is zeroed first — otherwise an active shield absorbs the obstacle and the run continues.
      window.__forceCrash = function () {
        if (state !== 'play') return false;
        shield = 0;
        const l = lane, lw = road().lw;
        objs.push({ t: 'obs', k: 'danfo', lane: l, y: carY() - 30, w: lw * 0.62, h: lw * 1.5, label: 'crash' });
        return true;
      };
      const COLBAND = 140;
      function autoStep() {
        if (__prevSt === 'play' && state === 'over') {
          window.__crash = { ms: performance.now(), lane: lane, carX: Math.round(carX),
            obs: objs.map(o => ({ k: o.t === 'obs' ? o.k : o.t, l: o.lane, y: Math.round(o.y - carY()), gone: o.gone ? 1 : 0 })),
            score: Math.round(score) };
        }
        __prevSt = state;
        if (state !== 'play') return;
        const cy = carY();
        const CAP = 4000;
        function ttc(l) {
          let best = Infinity;
          for (const o of objs) if (o.t === 'obs' && !o.gone && o.lane === l) {
            const rel = o.y - cy;
            if (rel > -COLBAND && rel < COLBAND) return 0;
            if (rel <= -COLBAND) { const dy = -COLBAND - rel; if (dy < best) best = dy; }
          }
          return best;
        }
        const TT = [0, 1, 2].map(ttc);
        function attract(l) {
          let a = 0;
          for (const o of objs) {
            if (o.gone) continue;
            const r = o.y - cy;
            if (o.t === 'stop' && o.lane === l && r > -560 && r < 170 && TT[l] > 450) a += 400;
            else if (o.t === 'pow' && o.lane === l && r > -460 && r < 150 && TT[l] > 450) a += 150;
            else if (o.t === 'coin' && o.lane === l && r > -340 && r < 120 && TT[l] > 240) a += 6;
          }
          return a;
        }
        const at = [0, 1, 2].map(attract);
        const sc = [0, 1, 2].map(l => Math.min(CAP, TT[l]) * 0.5 + (l === lane ? 22 : 0) + (1 - Math.abs(l - 1)) * 2 + at[l]);
        let target = lane;
        for (const l of [0, 1, 2]) if (sc[l] > sc[target]) target = l;
        if (target !== lane) { lane = target; carX = laneX(target); }
        if ((++__frameC & 3) === 0) {
          window.__trace.push({ t: Math.round(performance.now() - AUTO.startedAt), lane: lane, target: target,
            TT: [0, 1, 2].map(l => (TT[l] === Infinity ? 9999 : Math.round(TT[l]))), carry: carrying, score: Math.round(score), lv: level });
          if (window.__trace.length > 600) window.__trace.shift();
        }
      }
      (function autoFrame() { autoStep(); requestAnimationFrame(autoFrame); })();
