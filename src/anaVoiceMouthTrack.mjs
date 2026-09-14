// Hand-authored vowel-shape hints; speech intervals measured from WAV RMS.
// Within each interval timings are estimated, NOT forced phoneme alignment.
const phrases=[
 [0,.52,[['你',.65],['好',-.35]]],
 [.82,1.64,[['我',-.7],['是',.25],['安',.1],['娜',.15]]],
 [1.94,3.26,[['很',0],['高',-.25],['兴',.55],['见',.4],['到',-.35],['你',.7]]],
 [3.48,5.44,[['我',-.7],['们',-.1],['先',.5],['试',.3],['着',-.2],['慢',0],['慢',0],['说',-.75],['话',-.25]]],
 [5.72,6.92,[['然',.05],['后',-.55],['停',.65],['一',.8],['下',.25]]],
 [7.14,7.66,[['现',.5],['在',.2]]],
 [7.98,10.96,[['你',.7],['能',0],['看',.05],['到',-.4],['我',-.7],['的',0],['嘴',-.55],['巴',.1],['跟',0],['着',-.15],['声',.1],['音',.7],['动',-.8],['了',0],['吗',.1]]]
];
export const track=phrases.flatMap(([start,end,syllables])=>syllables.map(([label,form],i)=>({start:start+(end-start)*i/syllables.length,end:start+(end-start)*(i+1)/syllables.length,label,form})));
export function sampleMouthTrack(time){
 const i=track.findIndex(k=>time>=k.start&&time<k.end);
 if(i<0)return {form:0,label:'停顿',closed:true};
 const k=track[i],previous=track[i-1],connected=previous&&k.start-previous.end<.03;
 const p=Math.max(0,Math.min(1,(time-k.start)/Math.min(.055,(k.end-k.start)*.4))),smooth=p*p*(3-2*p);
 // Explicit bilabial onsets, estimated for this recording only. Keep a full
 // closure instead of allowing the energy of m/b to hold the mouth open.
 const closed=['们','慢','巴','吗'].includes(k.label)&&time-k.start<Math.min(.065,(k.end-k.start)*.32);
 return {form:(connected?previous.form:0)*(1-smooth)+k.form*smooth,label:k.label,closed};
}
export function advanceOpening(previous,rms,dt,closed){
 if(closed)return 0;
 const target=Math.max(0,Math.min(.85,(rms-.018)*7));
 const next=previous+(target-previous)*(1-Math.exp(-dt/(target>previous?.035:.025)));
 return target===0&&next<.035?0:next;
}

