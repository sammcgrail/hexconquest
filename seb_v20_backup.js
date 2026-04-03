function decideActions(state) {
  var me = state.myIndex;
  var myP = state.players[me];
  if (!myP.alive) return [];
  var orders = [];
  var hexMap = {};
  for (var i = 0; i < state.hexes.length; i++) {
    var h = state.hexes[i];
    hexMap[h.q + ',' + h.r] = h;
  }
  var dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,-1],[-1,1]];
  function dist(q1,r1,q2,r2) { return (Math.abs(q1-q2)+Math.abs(q1+r1-q2-r2)+Math.abs(r1-r2))/2; }
  function get(q,r) { return hexMap[q+','+r] || null; }
  function key(q,r) { return q+','+r; }

  var enemyKings = [];
  for (var i = 0; i < state.hexes.length; i++) {
    var h = state.hexes[i];
    if (h.hasKing && h.owner !== null && h.owner !== me && state.players[h.owner].alive)
      enemyKings.push({idx: h.owner, q: h.q, r: h.r, units: h.units});
  }

  var weakest = -1, weakTerr = Infinity, strongest = -1, strongTerr = 0;
  for (var i = 0; i < state.players.length; i++) {
    if (i === me || !state.players[i].alive) continue;
    if (state.players[i].territory < weakTerr) { weakTerr = state.players[i].territory; weakest = i; }
    if (state.players[i].territory > strongTerr) { strongTerr = state.players[i].territory; strongest = i; }
  }
  var primaryTarget = weakest;
  if (strongest !== -1 && strongTerr > myP.territory * 1.5) primaryTarget = strongest;

  var threatMap = {};
  for (var i = 0; i < state.hexes.length; i++) {
    var h = state.hexes[i];
    if (h.owner !== me) continue;
    for (var di = 0; di < dirs.length; di++) {
      var nh = get(h.q+dirs[di][0], h.r+dirs[di][1]);
      if (nh && nh.owner !== null && nh.owner !== me && nh.units > 0) {
        var k = key(h.q, h.r);
        threatMap[k] = (threatMap[k] || 0) + nh.units;
      }
    }
  }

  var KQ = state.myKing.q, KR = state.myKing.r;
  var kingThreat = threatMap[key(KQ, KR)] || 0;
  var earlyGame = state.tick < 55;
  var midGame = state.tick >= 55 && state.tick < 130;
  var lateGame = state.tick >= 130;

  var allMoves = [];
  var usedSrc = {};

  for (var mi = 0; mi < state.legalMoves.length; mi++) {
    var m = state.legalMoves[mi];
    var from = get(m.from.q, m.from.r);
    if (!from || from.units < 2) continue;
    var isKing = from.hasKing;
    var movable = isKing ? from.units : from.units - 1;

    if (isKing) {
      if (kingThreat > 0) {
        var safest = null, safeScore = -999;
        for (var ai = 0; ai < m.adjacent.length; ai++) {
          var a = m.adjacent[ai];
          var t = get(a.q, a.r);
          if (!t) continue;
          var sc = 0;
          if (t.owner === me) sc = 30 + t.units * 3;
          else if (t.owner === null) sc = 2;
          else continue;
          sc -= (threatMap[key(a.q, a.r)] || 0) * 5;
          for (var di = 0; di < dirs.length; di++) {
            var nh = get(a.q+dirs[di][0], a.r+dirs[di][1]);
            if (nh && nh.owner === me) sc += 4;
          }
          if (sc > safeScore) { safeScore = sc; safest = a; }
        }
        if (safest) {
          orders.push({ from: m.from, to: safest });
          usedSrc[key(m.from.q, m.from.r)] = true;
        }
      }
      continue;
    }

    for (var ai = 0; ai < m.adjacent.length; ai++) {
      var a = m.adjacent[ai];
      var t = get(a.q, a.r);
      if (!t) continue;
      var sc = 0;

      if (t.owner === null) {
        sc = earlyGame ? 30 : 18;
        if (t.type === 'resource') sc += 50;
        if (earlyGame) sc += (12 - dist(a.q, a.r, 0, 0)) * 2;
      } else if (t.owner !== me) {
        var needed = Math.ceil(t.units * 1.5) + 1;
        if (t.hasKing && movable > needed) {
          sc = 5000;
        } else if (movable > needed) {
          // TWEAK: higher base attack score to be more aggressive
          sc = earlyGame ? -10 : 70 + t.units * 3;
          if (t.type === 'resource') sc += 50;
          if (t.owner === primaryTarget) sc += 30;
        } else if (movable > t.units * 1.2 && t.units <= 3) {
          sc = 15;
        } else {
          sc = -50;
        }
      } else {
        var nearUnclaimed = false, nearEnemy = false;
        for (var di = 0; di < dirs.length; di++) {
          var nh = get(a.q+dirs[di][0], a.r+dirs[di][1]);
          if (nh && nh.owner === null) nearUnclaimed = true;
          if (nh && nh.owner !== null && nh.owner !== me) nearEnemy = true;
        }
        if (nearEnemy) sc = 8;
        else if (nearUnclaimed) sc = 7;
        else if (from.units >= 5) sc = 3;
        else sc = -3;

        if (kingThreat > 0) {
          var dFrom = dist(m.from.q, m.from.r, KQ, KR);
          var dTo = dist(a.q, a.r, KQ, KR);
          if (dTo < dFrom && dTo <= 3) sc = Math.max(sc, 18);
        }

        if (lateGame && enemyKings.length > 0) {
          for (var ki = 0; ki < enemyKings.length; ki++) {
            var fromD = dist(m.from.q, m.from.r, enemyKings[ki].q, enemyKings[ki].r);
            var toD = dist(a.q, a.r, enemyKings[ki].q, enemyKings[ki].r);
            if (toD < fromD && from.units >= 5) {
              var bonus = 8;
              if (enemyKings[ki].idx === primaryTarget) bonus = 12;
              sc = Math.max(sc, bonus);
            }
          }
        }
      }

      if ((midGame || lateGame) && enemyKings.length > 0) {
        for (var ki = 0; ki < enemyKings.length; ki++) {
          var kd = dist(a.q, a.r, enemyKings[ki].q, enemyKings[ki].r);
          var mult = lateGame ? 2.5 : 1.0;
          if (enemyKings[ki].idx === primaryTarget) mult *= 1.3;
          sc += Math.max(0, 20 - kd) * mult;
        }
      }

      allMoves.push({ from: m.from, to: a, sc: sc, sk: key(m.from.q, m.from.r) });
    }
  }

  allMoves.sort(function(a, b) { return b.sc - a.sc; });
  for (var i = 0; i < allMoves.length; i++) {
    var mv = allMoves[i];
    if (usedSrc[mv.sk]) continue;
    if (mv.sc <= 0) continue;
    usedSrc[mv.sk] = true;
    orders.push({ from: mv.from, to: mv.to });
  }

  // IMPROVED SPAWNING: spend ALL gold, prefer frontlines with most enemy neighbors
  var gold = myP.gold;
  while (gold >= 10) {
    var bestSpawn = null, bestSS = -999;
    for (var mi = 0; mi < state.legalMoves.length; mi++) {
      var m = state.legalMoves[mi];
      var ss = 0;
      if (kingThreat > 0 && dist(m.from.q, m.from.r, KQ, KR) <= 1) ss += 50;
      for (var ai = 0; ai < m.adjacent.length; ai++) {
        var adj = get(m.adjacent[ai].q, m.adjacent[ai].r);
        if (adj && adj.owner === null) ss += 8;
        if (adj && adj.owner !== null && adj.owner !== me) ss += 15;
        if (adj && adj.hasKing && adj.owner !== me) ss += 100;
        if (adj && adj.type === 'resource' && adj.owner !== me) ss += 25;
      }
      for (var ki = 0; ki < enemyKings.length; ki++) {
        var d = dist(m.from.q, m.from.r, enemyKings[ki].q, enemyKings[ki].r);
        if (d <= 5) ss += (6 - d) * 18;
      }
      if (ss > bestSS) { bestSS = ss; bestSpawn = m.from; }
    }
    if (bestSpawn) { orders.push({ spawn: bestSpawn }); gold -= 10; }
    else break;
  }

  return orders;
}
