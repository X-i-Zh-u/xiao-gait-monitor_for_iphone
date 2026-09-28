(function (root) {
  "use strict";
  // Quaternion maps sensor coordinates into a local world frame. Position is
  // step based; acceleration is used for attitude and event cues, never double integrated.
  function create() {
    return {q:[1,0,0,0],x:0,y:0,steps:0,distance:0,headingZero:0,lastFrame:null,
      previousVertical:0,olderVertical:0,filteredVertical:0,lastStepS:-Infinity,
      active:false,stepLength:0.65,path:[{x:0,y:0}]};
  }
  const dot=(a,b)=>a.reduce((sum,value,index)=>sum+value*b[index],0);
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  function gravityBody(q){const [w,x,y,z]=q;return [2*(x*z-w*y),2*(w*x+y*z),w*w-x*x-y*y+z*z];}
  function yaw(q){const [w,x,y,z]=q;return Math.atan2(2*(w*z+x*y),1-2*(y*y+z*z));}
  function normalize(q){const n=Math.sqrt(dot(q,q));return n>0?q.map(v=>v/n):[1,0,0,0];}
  function resetPath(s){s.x=0;s.y=0;s.steps=0;s.distance=0;s.path=[{x:0,y:0}];s.lastStepS=-Infinity;}
  function process(s,sample,allowSteps){
    const frame=sample.frame>>>0;if(s.lastFrame===frame)return null;
    const delta=s.lastFrame===null?1:((frame-s.lastFrame)>>>0);s.lastFrame=frame;
    if(delta===0||delta>6){s.olderVertical=s.previousVertical=s.filteredVertical=0;return null;}
    const dt=delta/50,accel=sample.acceleration.map(v=>v*9.80665),norm=Math.sqrt(dot(accel,accel));
    const gyro=sample.angular_rate.map(v=>v*Math.PI/180),gravity=gravityBody(s.q);
    if(norm>7&&norm<12.5){const measured=accel.map(v=>v/norm),correction=cross(measured,gravity);for(let i=0;i<3;i++)gyro[i]+=1.8*correction[i];}
    const [w,x,y,z]=s.q,[gx,gy,gz]=gyro,half=dt*.5;
    s.q=normalize([w+(-x*gx-y*gy-z*gz)*half,x+(w*gx+y*gz-z*gy)*half,
      y+(w*gy-x*gz+z*gx)*half,z+(w*gz+x*gy-y*gx)*half]);
    const dynamicZ=dot(accel,gravityBody(s.q))-9.80665;
    s.filteredVertical+=.28*(dynamicZ-s.filteredVertical);
    const detected=allowSteps&&s.olderVertical<s.previousVertical&&s.previousVertical>=s.filteredVertical&&
      s.previousVertical>.75&&sample.plot_s-s.lastStepS>=.32;
    s.olderVertical=s.previousVertical;s.previousVertical=s.filteredVertical;
    if(!detected)return null;
    const direction=yaw(s.q)-s.headingZero,length=s.stepLength;
    s.x+=Math.sin(direction)*length;s.y+=Math.cos(direction)*length;s.distance+=length;s.steps++;
    s.lastStepS=sample.plot_s;s.path.push({x:s.x,y:s.y});return {direction,length};
  }
  root.GaitTrajectory={create,process,resetPath,yaw};
})(typeof window!=="undefined"?window:globalThis);
