export function sampleWaveMesh(mesh, phase) {
  const action=mesh.actionSwitch;
  if(!action)return {vertices:mesh.vertices,opacity:1};
  const value=Math.max(action.keys[0],Math.min(action.keys.at(-1),phase));
  let i=0;while(i<action.keys.length-2&&action.keys[i+1]<=value)i++;
  const t=(value-action.keys[i])/(action.keys[i+1]-action.keys[i]);
  return {vertices:action.stateVertices[i].map((n,j)=>n+(action.stateVertices[i+1][j]-n)*t),
    opacity:action.stateOpacities[i]+(action.stateOpacities[i+1]-action.stateOpacities[i])*t};
}

export function phaseAtTime(seconds, mode='full') {
  if(mode==='wave')return 1+(seconds%1.2)/.6;
  const t=seconds%5;
  if(t<.25)return 0;if(t<1.25)return t-.25;
  if(t<2.45)return 1+(t-1.25)/.6;
  if(t<3.65)return 3-(t-2.45)/.6;
  if(t<4.65)return 4.65-t;return 0;
}

function triangle(ctx,image,source,dest,tri,xOffset,yOffset) {
  const [i,j,k]=tri;
  const x0=source[2*i]-xOffset,y0=source[2*i+1]-yOffset,x1=source[2*j]-xOffset,y1=source[2*j+1]-yOffset,x2=source[2*k]-xOffset,y2=source[2*k+1]-yOffset;
  const X0=dest[2*i],Y0=dest[2*i+1],X1=dest[2*j],Y1=dest[2*j+1],X2=dest[2*k],Y2=dest[2*k+1];
  const det=(x1-x0)*(y2-y0)-(x2-x0)*(y1-y0);if(Math.abs(det)<1e-9)return;
  const a=((X1-X0)*(y2-y0)-(X2-X0)*(y1-y0))/det,b=((Y1-Y0)*(y2-y0)-(Y2-Y0)*(y1-y0))/det;
  const c=((X2-X0)*(x1-x0)-(X1-X0)*(x2-x0))/det,d=((Y2-Y0)*(x1-x0)-(Y1-Y0)*(x2-x0))/det;
  ctx.save();ctx.beginPath();ctx.moveTo(X0,Y0);ctx.lineTo(X1,Y1);ctx.lineTo(X2,Y2);ctx.closePath();ctx.clip();
  ctx.transform(a,b,c,d,X0-a*x0-c*y0,Y0-b*x0-d*y0);ctx.drawImage(image,0,0);ctx.restore();
}

export function renderWave(ctx, result, phase, wireframe=false) {
  ctx.clearRect(0,0,ctx.canvas.width,ctx.canvas.height);
  for(const mesh of result.meshes){const state=sampleWaveMesh(mesh,phase);if(state.opacity<=0)continue;
    ctx.globalAlpha=state.opacity;
    if(!mesh.actionSwitch)ctx.drawImage(mesh.image,mesh.x,mesh.y);
    else {
      for(let i=0;i<mesh.triangles.length;i+=3)triangle(ctx,mesh.image,mesh.vertices,state.vertices,mesh.triangles.slice(i,i+3),mesh.x,mesh.y);
      if(wireframe){ctx.strokeStyle='#008c80';ctx.lineWidth=.6;ctx.globalAlpha=.35;ctx.beginPath();
        for(let i=0;i<mesh.triangles.length;i+=3){for(let j=0;j<3;j++){const v=mesh.triangles[i+j];if(j===0)ctx.moveTo(state.vertices[2*v],state.vertices[2*v+1]);else ctx.lineTo(state.vertices[2*v],state.vertices[2*v+1]);}ctx.closePath();}ctx.stroke();}
    }
  }
  ctx.globalAlpha=1;
}
