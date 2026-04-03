function decideActions(state) {
  var me=state.myIndex, myP=state.players[me];
  if(!myP.alive) return [];
  var orders=[], hexMap={};
  for(var i=0;i<state.hexes.length;i++){var h=state.hexes[i];hexMap[h.q+','+h.r]=h;}
  var dirs=[[1,0],[-1,0],[0,1],[0,-1],[1,-1],[-1,1]];
  function dist(q1,r1,q2,r2){return(Math.abs(q1-q2)+Math.abs(q1+r1-q2-r2)+Math.abs(r1-r2))/2;}
  function get(q,r){return hexMap[q+','+r]||null;}
  function key(q,r){return q+','+r;}
  function fN(q,r){var c=0;for(var d=0;d<6;d++){var h=get(q+dirs[d][0],r+dirs[d][1]);if(h&&h.owner===me)c++;}return c;}
  function eN(q,r){var c=0;for(var d=0;d<6;d++){var h=get(q+dirs[d][0],r+dirs[d][1]);if(h&&h.owner!==null&&h.owner!==me)c++;}return c;}

  var unclRes=[], enemyKings=[];
  for(var i=0;i<state.hexes.length;i++){
    var h=state.hexes[i];
    if(h.type==='resource'&&h.owner!==me) unclRes.push(h);
    if(h.hasKing&&h.owner!==null&&h.owner!==me&&state.players[h.owner].alive)
      enemyKings.push({idx:h.owner,q:h.q,r:h.r,units:h.units,terr:state.players[h.owner].territory});
  }
  function dNR(q,r){var m=999;for(var i=0;i<unclRes.length;i++){var d=dist(q,r,unclRes[i].q,unclRes[i].r);if(d<m)m=d;}return m;}

  // Target: most vulnerable king (fewest units on hex * 2 + low territory)
  var vulnKing=null, vulnScore=Infinity;
  for(var i=0;i<enemyKings.length;i++){
    var k=enemyKings[i], sc=k.units*2+k.terr*0.1;
    if(sc<vulnScore){vulnScore=sc;vulnKing=k;}
  }

  // Count escape routes for each enemy king
  var kingEscapes={};
  for(var ki=0;ki<enemyKings.length;ki++){
    var ek=enemyKings[ki], exits=0;
    for(var d=0;d<6;d++){
      var nh=get(ek.q+dirs[d][0],ek.r+dirs[d][1]);
      if(nh&&nh.type!=='mountain'&&(nh.owner===ek.idx||nh.owner===null)) exits++;
    }
    kingEscapes[ek.idx]=exits;
  }

  var KQ=state.myKing.q, KR=state.myKing.r;
  var t=state.tick, early=t<40, mid=t>=40&&t<100, late=t>=100;

  // Territory awareness — am I leading or trailing?
  var myTerr=0,maxEnemyTerr=0;
  for(var i=0;i<state.players.length;i++){
    if(!state.players[i].alive) continue;
    var tt=state.players[i].territory||0;
    if(i===me) myTerr=tt;
    else if(tt>maxEnemyTerr) maxEnemyTerr=tt;
  }
  var leading=myTerr>maxEnemyTerr, trailing=myTerr<maxEnemyTerr*0.8;

  // King threat detection (2-hop)
  var kT1=0, kT2=0;
  for(var d=0;d<6;d++){
    var n1=get(KQ+dirs[d][0],KR+dirs[d][1]);
    if(!n1) continue;
    if(n1.owner!==null&&n1.owner!==me&&n1.units>0) kT1+=n1.units;
    for(var d2=0;d2<6;d2++){
      var n2=get(n1.q+dirs[d2][0],n1.r+dirs[d2][1]);
      if(n2&&n2.owner!==null&&n2.owner!==me&&n2.units>3) kT2+=n2.units;
    }
  }
  var danger=kT1>0||kT2>8;

  var guard={};
  guard[key(KQ,KR)]=true;
  for(var d=0;d<6;d++){var nh=get(KQ+dirs[d][0],KR+dirs[d][1]);if(nh&&nh.owner===me)guard[key(nh.q,nh.r)]=true;}

  var allMoves=[], usedSrc={};

  for(var mi=0;mi<state.legalMoves.length;mi++){
    var m=state.legalMoves[mi], from=get(m.from.q,m.from.r);
    if(!from||from.units<2) continue;
    var isKing=from.hasKing, movable=isKing?from.units:from.units-1;

    if(isKing){
      if(kT1>0||kT2>5){
        var safest=null,ss=-999;
        for(var ai=0;ai<m.adjacent.length;ai++){
          var a=m.adjacent[ai],tgt=get(a.q,a.r);
          if(!tgt) continue;
          var sc=0;
          if(tgt.owner===me) sc=30+tgt.units*3;
          else if(tgt.owner===null) sc=2;
          else continue;
          for(var di=0;di<6;di++){
            var nh2=get(a.q+dirs[di][0],a.r+dirs[di][1]);
            if(nh2&&nh2.owner!==null&&nh2.owner!==me) sc-=nh2.units*5;
            if(nh2&&nh2.owner===me) sc+=nh2.units*2;
          }
          sc+=fN(a.q,a.r)*8;
          if(sc>ss){ss=sc;safest=a;}
        }
        if(safest){orders.push({from:m.from,to:safest});usedSrc[key(m.from.q,m.from.r)]=true;}
      }
      continue;
    }

    if(guard[key(m.from.q,m.from.r)]&&danger&&from.units<=5) continue;

    for(var ai=0;ai<m.adjacent.length;ai++){
      var a=m.adjacent[ai],tgt=get(a.q,a.r);
      if(!tgt) continue;
      var sc=0,fn=fN(a.q,a.r),en=eN(a.q,a.r);

      if(tgt.owner===null){
        if(tgt.type==='resource') sc=early?120:60;
        else{sc=early?12:8;var rd=dNR(a.q,a.r);if(early&&rd<=3) sc+=(4-rd)*12;}
        if(en>0) sc+=fn*6; else if(!early) sc+=fn*4;
        if(mid) sc+=Math.max(0,8-dist(a.q,a.r,0,0));
        // Pin: claim hexes adjacent to enemy kings
        for(var ki=0;ki<enemyKings.length;ki++){
          var dk=dist(a.q,a.r,enemyKings[ki].q,enemyKings[ki].r);
          if(dk===1) sc+=mid?40:late?80:15;
          else if(dk===2) sc+=mid?15:late?30:3;
        }

      } else if(tgt.owner!==me){
        var needed=Math.ceil(tgt.units*1.5)+1;
        if(tgt.hasKing&&movable>needed){
          sc=6000;
        } else if(movable>needed){
          if(early) sc=-10;
          else{
            // Combat efficiency: attacker loses floor(defenders/2)
            // Only attack if we keep good unit advantage after
            var losses=Math.floor(tgt.units/2);
            var remaining=movable-losses;
            sc=15+remaining*2; // More remaining = better attack
            if(tgt.type==='resource') sc+=50;
            if(vulnKing&&tgt.owner===vulnKing.idx) sc+=25; // Focus fire on weakest
            sc+=fn*3;
            // Pin: attack near enemy kings
            for(var ki=0;ki<enemyKings.length;ki++){
              if(dist(a.q,a.r,enemyKings[ki].q,enemyKings[ki].r)<=2) sc+=40;
            }
          }
        } else sc=-50;

      } else {
        if(tgt.type==='resource'&&en>0) sc=14;
        else if(en>0) sc=5;
        else{
          var frd=dNR(m.from.q,m.from.r),tod=dNR(a.q,a.r);
          if(tod<frd&&unclRes.length>0) sc=early?10:5;
          else{var nu=false;for(var di=0;di<6;di++){var nh3=get(a.q+dirs[di][0],a.r+dirs[di][1]);if(nh3&&nh3.owner===null&&nh3.type!=='mountain'){nu=true;break;}}sc=nu?3:-5;}
        }
        if(danger){
          var dF=dist(m.from.q,m.from.r,KQ,KR),dT=dist(a.q,a.r,KQ,KR);
          if(dT<dF&&dT<=4) sc=Math.max(sc,45+kT1+kT2);
        }
      }

      // King hunting — focused within 5 hexes like BMO, but with pin multiplier
      if(t>20&&enemyKings.length>0){
        for(var ki=0;ki<enemyKings.length;ki++){
          var ek=enemyKings[ki];
          var dk=dist(a.q,a.r,ek.q,ek.r);
          if(dk>8) continue; // Don't waste gravity on distant kings
          var escapes=kingEscapes[ek.idx]||6;
          var pinMult=Math.max(1,(7-escapes)*0.5);
          var timeMult=late?6:mid?4:2;
          if(trailing) timeMult*=1.5; // More aggressive when behind in territory
          if(vulnKing&&ek.idx===vulnKing.idx) timeMult*=1.3;
          sc+=Math.max(0,18-dk)*timeMult*pinMult;
          if(dk<=3) sc+=(late?15:8)*pinMult;
        }
      }

      allMoves.push({from:m.from,to:a,sc:sc,sk:key(m.from.q,m.from.r)});
    }
  }

  allMoves.sort(function(a,b){return b.sc-a.sc;});
  for(var i=0;i<allMoves.length;i++){
    var mv=allMoves[i];
    if(usedSrc[mv.sk]) continue;
    if(mv.sc<=0) continue;
    usedSrc[mv.sk]=true;
    orders.push({from:mv.from,to:mv.to});
  }

  var gold=myP.gold;
  while(gold>=10){
    var bS=null,bSS=-1;
    for(var mi2=0;mi2<state.legalMoves.length;mi2++){
      var m2=state.legalMoves[mi2],fh=get(m2.from.q,m2.from.r);
      if(!fh) continue;
      var ss=0;
      for(var ai2=0;ai2<m2.adjacent.length;ai2++){
        var adj=get(m2.adjacent[ai2].q,m2.adjacent[ai2].r);
        if(adj&&adj.owner!==null&&adj.owner!==me) ss+=5;
        if(adj&&adj.owner===null) ss+=3;
        if(adj&&adj.hasKing&&adj.owner!==me) ss+=120;
        if(adj&&adj.type==='resource'&&adj.owner!==me) ss+=15;
      }
      var kd=dist(m2.from.q,m2.from.r,KQ,KR);
      if(danger&&kd<=2) ss+=80;
      else if(kd<=2) ss+=6;
      if(vulnKing&&t>30){var vkd=dist(m2.from.q,m2.from.r,vulnKing.q,vulnKing.r);if(vkd<=4) ss+=(5-vkd)*20;}
      if(ss>bSS){bSS=ss;bS=m2.from;}
    }
    if(bS&&bSS>0){orders.push({spawn:bS});gold-=10;}
    else break;
  }

  return orders;
}
