

// Runtime-only audition. Does not modify the MOC3, atlas or source CMO3.
export async function installAnaTalkingMouth({model, assetBase, getState}){
 const internal=model.internalModel,core=internal.coreModel,d=core.getModel().drawables;
 const index=d.ids.indexOf('ArtMesh9');
 if(index<0)throw Error('Ana mouth drawable ArtMesh9 is missing');
 const enabled={get checked(){return getState().enabled;}};
 let opening=0,form=0;
 const image=new Image();image.src=assetBase+'ana-mouth-texture-atlas-v9-white.png';await image.decode();
 function piece([x,y,w,h],stroke){const c=document.createElement('canvas');c.width=w;c.height=h;const g=c.getContext('2d');g.drawImage(image,x,y,w,h,0,0,w,h);const p=g.getImageData(0,0,w,h);for(let i=0;i<p.data.length;i+=4){const distance=255-Math.min(p.data[i],p.data[i+1],p.data[i+2]);p.data[i+3]=255*Math.max(0,Math.min(1,(distance-(stroke?55:6))/(stroke?25:18)));}g.putImageData(p,0,0);if(stroke){c.centres=[];for(let x=0;x<w;x++){let sum=0,total=0;for(let y=0;y<h;y++){const a=p.data[(y*w+x)*4+3];sum+=a*y;total+=a;}c.centres.push(total?sum/total:h/2);}}return c;}
 const art=[[112,198,410,34],[746,198,390,34],[118,542,400,145],[812,556,255,126]].map((p,i)=>piece(p,i<2));
 const canvas=document.createElement('canvas');canvas.width=400;canvas.height=180;const g=canvas.getContext('2d');
 const texture=PIXI.Texture.from(canvas),sprite=new PIXI.Sprite(texture);sprite.anchor.set(.5,.5);sprite.interactive=false;model.addChild(sprite);
 function render(){g.clearRect(0,0,400,180);g.save();g.translate(200,75);const width=276+form*28-opening*22;
  const profile=(t,upper)=>{const b=Math.sin(Math.PI*t);return -7*form+(3+7*form)*b+1.6*Math.sin(2*Math.PI*t)+(upper?-opening*23*b**1.2:opening*64*b**.72);};
  g.save();g.beginPath();for(let i=0;i<=80;i++){const t=i/80;i?g.lineTo((t-.5)*width,profile(t,true)):g.moveTo(-width/2,profile(t,true));}for(let i=80;i>=0;i--){const t=i/80;g.lineTo((t-.5)*width,profile(t,false));}g.closePath();g.clip();g.drawImage(art[2],-175,-52,350,140);g.drawImage(art[3],-100,22,200,65);g.restore();
  for(let n=0;n<(opening>.015?2:1);n++){const tex=art[n];for(let x=0;x<tex.width;x++){const t=x/(tex.width-1);g.drawImage(tex,x,0,1,tex.height,(t-.5)*width,profile(t,n===0)-tex.centres[x]*.36,width/tex.width+.45,tex.height*.36);}}
  g.restore();texture.baseTexture.update();
 }
 // Identify stable left/right boundary vertices once; track these actual
 // deformed points, not a fixed screen-space sticker. Side-angle occlusion
 // remains outside this runtime audition and needs native mesh integration.
 const initial=internal.getDrawableVertices(index);let left=0,right=0;
 for(let i=2;i<initial.length;i+=2){if(initial[i]<initial[left])left=i;if(initial[i]>initial[right])right=i;}
 const referenceAngle=Math.atan2(initial[right+1]-initial[left+1],initial[right]-initial[left]);
 const centerOffsetY=(75-90);let last=performance.now(),latest={},savedOpacity=d.opacities[index];
 const originalUpdate=core.update.bind(core);
 core.update=function(...args){d.opacities[index]=savedOpacity;const result=originalUpdate(...args);savedOpacity=d.opacities[index];const now=performance.now(),dt=Math.min(.1,(now-last)/1000);last=now;
  const state=getState();
  opening=state.opening;form=state.form;
  const v=internal.getDrawableVertices(index),p=internal.localTransform.apply(new PIXI.Point(v[left],v[left+1])),q=internal.localTransform.apply(new PIXI.Point(v[right],v[right+1]));
  const scale=Math.hypot(q.x-p.x,q.y-p.y)/276,angle=Math.atan2(q.y-p.y,q.x-p.x)-referenceAngle;
  sprite.scale.set(scale);sprite.rotation=angle;sprite.position.set((p.x+q.x)/2+Math.sin(angle)*centerOffsetY*scale,(p.y+q.y)/2-Math.cos(angle)*centerOffsetY*scale);
  sprite.visible=enabled.checked;sprite.alpha=d.opacities[index];if(enabled.checked)d.opacities[index]=0;
  render();
  latest={opening,form,enabled:enabled.checked,anchor:[sprite.x,sprite.y],width:scale*276};return result;
 };
 return {dispose(){core.update=originalUpdate;d.opacities[index]=savedOpacity;model.removeChild(sprite);sprite.destroy();texture.destroy(true);},snapshot:()=>({...latest}),focus(app){model.scale.set(Math.min(app.screen.width,app.screen.height)/150);model.position.set(app.screen.width/2-(sprite.x-model.pivot.x)*model.scale.x,app.screen.height*.43-(sprite.y-model.pivot.y)*model.scale.y);}};
}
