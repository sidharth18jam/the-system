// Fits the board skeletons so every district's LAND AREA is proportional to its
// voter capacity. Prints SKELETON_SRC rows to paste into public/client.js.
//   node scripts/fit-board.js nine     # 9-zone board
//   node scripts/fit-board.js two      # 2 Player board
// The seeds below are hand-drawn starting layouts (topology = engine adjacency in
// data/zones*.json). The solver nudges inner border points by gradient descent on
// (area share − capacity share)², rejecting any move that flips a shape, creates a
// sliver (< 2.5% clearance) or shrinks a lake below 60%. Frame corners are fixed and
// frame points only slide along their side. If capacities change, update `caps`,
// re-run, paste, then check: node test/client-render.js.
const fs=require('fs');
const boards={
 nine:{caps:{NW:11,N:9,NE:11,W:15,C:9,E:15,SW:17,S:11,SE:21},
  lakes:[[[32,30],[40,36],[38,60],[32,66],[24,62],[24,33]],[[64,31],[76,28],[76,60],[68,66],[62,60],[60,36]]],
  sk:{
  NW: [[0,0],[56,0],[52,8],[49,14],[40,15],[30,17],[26,24],[32,30],[24,33],[16,30],[10,24],[0,22]],
  N:  [[49,14],[60,16],[66,24],[64,31],[60,36],[50,34],[40,36],[32,30],[26,24],[30,17],[40,15]],
  NE: [[56,0],[100,0],[100,30],[88,22],[76,28],[64,31],[66,24],[60,16],[49,14],[52,8]],
  W:  [[0,22],[10,24],[16,30],[24,33],[24,62],[14,66],[0,70]],
  C:  [[40,36],[50,34],[60,36],[62,60],[50,63],[38,60]],
  E:  [[100,30],[100,64],[86,68],[76,60],[76,28],[88,22]],
  SW: [[0,70],[14,66],[24,62],[32,66],[36,72],[38,80],[50,83],[46,91],[42,100],[0,100]],
  S:  [[38,60],[50,63],[62,60],[68,66],[74,72],[70,82],[60,82],[50,83],[38,80],[36,72],[32,66]],
  SE: [[100,64],[100,100],[42,100],[46,91],[50,83],[60,82],[70,82],[74,72],[68,66],[76,60],[86,68]]}},
 two:{caps:{Z1:9,Z2:11,Z3:13,Z4:9,Z5:11,Z6:13,Z7:15},
  lakes:[[[30,26],[38,34],[38,66],[30,74],[24,62],[20,50],[24,38]],[[70,26],[76,38],[80,50],[76,62],[70,74],[62,66],[62,34]]],
  sk:{
  Z1: [[30,0],[70,0],[66,14],[70,26],[62,34],[50,31],[38,34],[30,26],[34,14]],
  Z2: [[70,0],[100,0],[100,52],[90,54],[80,50],[76,38],[70,26],[66,14]],
  Z3: [[100,52],[100,100],[70,100],[66,86],[70,74],[76,62],[80,50],[90,54]],
  Z4: [[30,100],[34,86],[30,74],[38,66],[50,69],[62,66],[70,74],[66,86],[70,100]],
  Z5: [[0,48],[10,46],[20,50],[24,62],[30,74],[34,86],[30,100],[0,100]],
  Z6: [[0,0],[30,0],[34,14],[30,26],[24,38],[20,50],[10,46],[0,48]],
  Z7: [[38,34],[50,31],[62,34],[62,66],[50,69],[38,66]]}}};
const which=process.argv[2];const B=boards[which];
// unique vertex table
const V=new Map();const ref=(p)=>{const k=p.join();if(!V.has(k))V.set(k,{p0:p.slice(),p:p.slice()});return V.get(k);};
const polys={};for(const id in B.sk)polys[id]=B.sk[id].map(ref);
const lakes=B.lakes.map(l=>l.map(ref));
const isl=(v)=>{const [x,y]=v.p;const corner=(x===0||x===100)&&(y===0||y===100);return corner?[x?90:10,y?90:10]:[5+x*.9,5+y*.9];};
const area=P=>{let s=0;for(let i=0;i<P.length;i++){const a=isl(P[i]),b=isl(P[(i+1)%P.length]);s+=a[0]*b[1]-b[0]*a[1];}return s/2;};
const cap=B.caps;const tc=Object.values(cap).reduce((a,b)=>a+b);
const lake0=lakes.map(l=>Math.abs(area(l)));
function E(){let land=0;const A={};for(const id in polys){A[id]=Math.abs(area(polys[id]));land+=A[id];}
 let e=0;for(const id in polys){const t=cap[id]/tc*land;e+=((A[id]-t)/t)**2*40;}
 lakes.forEach((l,i)=>{const r=Math.abs(area(l))/lake0[i];if(r<0.6)e+=(0.6-r)**2*40;});
 for(const v of V.values())e+=((v.p[0]-v.p0[0])**2+(v.p[1]-v.p0[1])**2)*0.0004;
 return e;}
const allP=[...Object.values(polys),...lakes];
const sign0=allP.map(P=>Math.sign(area(P)));
function sd(p,a,b){const dx=b[0]-a[0],dy=b[1]-a[1];const l=dx*dx+dy*dy||1;let t=((p[0]-a[0])*dx+(p[1]-a[1])*dy)/l;t=Math.max(0,Math.min(1,t));return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);}
function valid(){for(let k=0;k<allP.length;k++){const P=allP[k];if(Math.sign(area(P))!==sign0[k])return false;const n=P.length;
 for(let i=0;i<n;i++){const v=isl(P[i]);for(let j=0;j<n;j++){if(j===i||(j+1)%n===i)continue;if(sd(v,isl(P[j]),isl(P[(j+1)%n]))<2.5)return false;}}}return true;}
console.error('start valid',valid());
const free=[...V.values()].map(v=>{const [x,y]=v.p0;return {v,fx:x===0||x===100,fy:y===0||y===100};}).filter(f=>!(f.fx&&f.fy));
for(let it=0;it<1500;it++){
 const lr=0.6*(1-it/1500)+0.05;
 for(const f of free)for(const d of [0,1]){if((d===0&&f.fx)||(d===1&&f.fy))continue;
  const e0=E();f.v.p[d]+=0.05;const e1=E();f.v.p[d]-=0.05;const g=(e1-e0)/0.05;
  const old=f.v.p[d];f.v.p[d]-=Math.max(-1,Math.min(1,g*lr*20));f.v.p[d]=Math.max(0,Math.min(100,f.v.p[d]));if(!valid())f.v.p[d]=old;}
}
let land=0;const A={};for(const id in polys){A[id]=Math.abs(area(polys[id]));land+=A[id];}
for(const id in polys)console.error(id,'ratio',(A[id]/(cap[id]/tc*land)).toFixed(3));
lakes.forEach((l,i)=>console.error('lake',i,(Math.abs(area(l))/lake0[i]).toFixed(2)));
const r=(n)=>Math.round(n*2)/2;
for(const id in polys)console.log(`  ${(id+':').padEnd(3)} [${polys[id].map(v=>`[${r(v.p[0])}, ${r(v.p[1])}]`).join(', ')}],`);
