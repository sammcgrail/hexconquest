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
  function friendlyN(q,r) { var c=0; for(var d=0;d<6;d++){var h=get(q+dirs[d][0],r+dirs[d][1]);if(h&&h.owner===me)c++;} return c; }
  function enemyN(q,r) { var c=0; for(var d=0;d<6;d++){var h=get(q+dirs[d][0],r+dirs[d][1]);if(h&&h.owner!==null&&h.owner!==me)c++;} return c; }
  function edgeDist(q,r) { return 10 - dist(q,r,0,0); }

  // Resource tracking
  var unclaimedRes = [], enemyRes = [];
  for (var i = 0; i < state.hexes.length; i++) {
    var h = state.hexes[i];
    if (h.type === 'resource' && h.owner === null) unclaimedRes.push(h);
    if (h.type === 'resource' && h.owner !== null && h.owner !== me) enemyRes.push(h);
  }
  var allTargetRes = unclaimedRes.concat(enemyRes);

  function distToNearestRes(q, r) {
    var min = 999;
    for (var i = 0; i < allTargetRes.length; i++) {
      var d = dist(q, r, allTargetRes[i].q, allTargetRes[i].r);
      if (d < min) min = d;
    }
    return min;
  }

  var enemyKings = [];
  for (var i = 0; i < state.hexes.length; i++) {
    var h = state.hexes[i];
    if (h.hasKing && h.owner !== null && h.owner !== me && state.players[h.owner].alive)
      enemyKings.push({idx: h.owner, q: h.q, r: h.r, units: h.units, terr: state.players[h.owner].territory});
  }
  var weakest = null, weakTerr = Infinity;
  for (var i = 0; i < enemyKings.length; i++) {
    if (enemyKings[i].terr < weakTerr) { weakTerr = enemyKings[i].terr; weakest = enemyKings[i]; }
  }

  var KQ = state.myKing.q, KR = state.myKing.r;
  var earlyGame = state.tick < 30;
  var midGame = state.tick >= 30 && state.tick < 80;
  var lateGame = state.tick >= 80;

  // 2-hop king threat detection
  var kingThreat = 0, kingThreat2 = 0;
  for (var d = 0; d < 6; d++) {
    var nh = get(KQ+dirs[d][0], KR+dirs[d][1]);
    if (nh && nh.owner !== null && nh.owner !== me && nh.units > 0) kingThreat += nh.units;
    if (nh) {
      for (var d2 = 0; d2 < 6; d2++) {
        var nh2 = get(nh.q+dirs[d2][0], nh.r+dirs[d2][1]);
        if (nh2 && nh2.owner !== null && nh2.owner !== me && nh2.units > 3) kingThreat2 += nh2.units;
      }
    }
  }
  var kingInDanger = kingThreat > 0 || kingThreat2 > 8;

  var guardRingKeys = {};
  guardRingKeys[key(KQ, KR)] = true;
  for (var d = 0; d < 6; d++) {
    var nh = get(KQ+dirs[d][0], KR+dirs[d][1]);
    if (nh && nh.owner === me) guardRingKeys[key(nh.q, nh.r)] = true;
  }

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
          for (var di = 0; di < 6; di++) {
            var nh3 = get(a.q+dirs[di][0], a.r+dirs[di][1]);
            if (nh3 && nh3.owner !== null && nh3.owner !== me) sc -= nh3.units * 5;
            if (nh3 && nh3.owner === me) sc += nh3.units;
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

    if (guardRingKeys[key(m.from.q, m.from.r)] && kingInDanger && from.units <= 4) continue;

    for (var ai = 0; ai < m.adjacent.length; ai++) {
      var a = m.adjacent[ai];
      var t = get(a.q, a.r);
      if (!t) continue;
      var sc = 0;
      var fn = friendlyN(a.q, a.r);
      var en = enemyN(a.q, a.r);

      if (t.owner === null) {
        // MATCH BMO — resources at 100 early
        if (t.type === 'resource') {
          sc = earlyGame ? 100 : 50;
        } else {
          sc = earlyGame ? 12 : 8;
          // Path-to-resource bonus (like BMO)
          var resDist = distToNearestRes(a.q, a.r);
          if (earlyGame && resDist <= 3) sc += (4 - resDist) * 10;
        }
        // Clustering near enemies
        if (en > 0) sc += fn * 6;
        else if (!earlyGame) sc += fn * 4;
        if (midGame) sc += Math.max(0, 8 - dist(a.q, a.r, 0, 0));

      } else if (t.owner !== me) {
        var needed = Math.ceil(t.units * 1.5) + 1;
        if (t.hasKing && movable > needed) {
          sc = 5000;
        } else if (movable > needed) {
          sc = 18;
          if (t.type === 'resource') sc += 50;
          if (weakest && t.owner === weakest.idx) sc += 15;
          sc += fn * 3;
          if (earlyGame) sc = -10; // Don't waste units attacking early
        } else {
          sc = -50;
        }

      } else {
        // Own hex routing — resource pathfinding + frontline reinforce
        if (t.type === 'resource' && en > 0) {
          sc = 12; // defend our resources
        } else if (en > 0) {
          sc = 5;
        } else {
          var fromResDist = distToNearestRes(m.from.q, m.from.r);
          var toResDist = distToNearestRes(a.q, a.r);
          if (toResDist < fromResDist && allTargetRes.length > 0) {
            sc = earlyGame ? 8 : 4; // route toward resources
          } else {
            var nearUnclaimed = false;
            for (var di = 0; di < 6; di++) {
              var nh4 = get(a.q+dirs[di][0], a.r+dirs[di][1]);
              if (nh4 && nh4.owner === null && nh4.type !== 'mountain') { nearUnclaimed = true; break; }
            }
            sc = nearUnclaimed ? 3 : -5;
          }
        }
        // King defense routing
        if (kingInDanger) {
          var dFrom = dist(m.from.q, m.from.r, KQ, KR);
          var dTo = dist(a.q, a.r, KQ, KR);
          if (dTo < dFrom && dTo <= 3) sc = Math.max(sc, 40 + kingThreat + kingThreat2);
        }
      }

      // King hunting — match BMO's aggression
      if ((midGame || lateGame) && enemyKings.length > 0) {
        for (var ki = 0; ki < enemyKings.length; ki++) {
          var kd = dist(a.q, a.r, enemyKings[ki].q, enemyKings[ki].r);
          var mult = lateGame ? 5 : midGame ? 3 : 0;
          if (weakest && enemyKings[ki].idx === weakest.idx) mult *= 1.3;
          sc += Math.max(0, 15 - kd) * mult;
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

  // Spawning
  var gold = myP.gold;
  while (gold >= 10) {
    var bestSpawn = null, bestSS = -1;
    for (var mi2 = 0; mi2 < state.legalMoves.length; mi2++) {
      var m2 = state.legalMoves[mi2];
      var fh = get(m2.from.q, m2.from.r);
      if (!fh) continue;
      var ss = 0;
      for (var ai2 = 0; ai2 < m2.adjacent.length; ai2++) {
        var adj = get(m2.adjacent[ai2].q, m2.adjacent[ai2].r);
        if (adj && adj.owner !== null && adj.owner !== me) ss += 5;
        if (adj && adj.owner === null) ss += 3;
        if (adj && adj.hasKing && adj.owner !== me) ss += 120;
        if (adj && adj.type === 'resource' && adj.owner !== me) ss += 15;
      }
      var kd2 = dist(m2.from.q, m2.from.r, KQ, KR);
      if (kingInDanger && kd2 <= 2) ss += 70;
      else if (kd2 <= 2) ss += 6;
      for (var ki2 = 0; ki2 < enemyKings.length; ki2++) {
        var ekd = dist(m2.from.q, m2.from.r, enemyKings[ki2].q, enemyKings[ki2].r);
        if (ekd <= 5) ss += (6 - ekd) * 15;
      }
      if (ss > bestSS) { bestSS = ss; bestSpawn = m2.from; }
    }
    if (bestSpawn && bestSS > 0) { orders.push({ spawn: bestSpawn }); gold -= 10; }
    else break;
  }

  return orders;
}
