import type { VisualSettings } from './visual-settings-model';

const fonts = { sans: 'ui-sans-serif,system-ui,sans-serif', serif: 'Georgia,serif', mono: 'ui-monospace,Menlo,monospace' };
const rgba = (hex: string, alpha: number) => { const v = parseInt(hex.slice(1),16); return `rgba(${v>>>16},${(v>>>8)&255},${v&255},${alpha})`; };
const stamp = (time: number) => `${Math.floor(time/60)}:${String(Math.floor(time%60)).padStart(2,'0')}`;
const fit = (ctx: CanvasRenderingContext2D, text: string, width: number) => {
  if (ctx.measureText(text).width <= width) return text;
  let value = text; while (value && ctx.measureText(value+'…').width > width) value = value.slice(0,-1);
  return value ? value+'…' : '';
};
export function trackOverlayLayout(w: number, h: number, s: VisualSettings, captionLane = 0) {
  const unit = Math.min(w,h), edge = Math.max(22, unit*.055), pad = Math.max(10,unit*.018);
  const titleSize = Math.max(21,Math.round(unit*.037*s.infoSize)), secondarySize = Math.max(14,Math.round(unit*.02*s.infoSize));
  const title = s.showTrackInfo && !!s.trackTitle.trim(), artist = s.showTrackInfo && !!s.trackArtist.trim();
  const compact = s.mode === 'spectrum' && s.infoPosition === 'bottom' && captionLane > 0;
  const contentH = compact ? (title ? titleSize : secondarySize)*1.2 : (title ? titleSize*1.35 : 0)+(artist ? secondarySize*1.55 : 0)+(s.showTimer ? secondarySize*1.7 : 0);
  const visible = title || artist || s.showTimer;
  const y = s.infoPosition === 'center' ? (h-contentH)/2 : s.infoPosition === 'top' ? edge+unit*.055 : h-edge-contentH-(captionLane ? captionLane+unit*.025 : unit*.025);
  const maxWidth = Math.max(1,compact ? w-edge*2-pad*2 : Math.min(w-edge*2-pad*2,unit*.86));
  return {title,artist,compact,visible,unit,edge,pad,titleSize,secondarySize,contentH,y,maxWidth,
    topSpace: visible && s.infoPosition === 'top' ? y+contentH+pad : 0,
    bottomSpace: visible && s.infoPosition === 'bottom' ? h-y+pad : 0};
}
export function drawTrackOverlay(ctx: CanvasRenderingContext2D, w: number, h: number, s: VisualSettings, time: number, duration: number, captionLane = 0) {
  const layout = trackOverlayLayout(w,h,s,captionLane);
  if (!layout.visible) return;
  const {title,artist,compact,unit,edge,pad,titleSize,secondarySize,contentH,y,maxWidth} = layout;
  const family = fonts[s.infoFont ?? 'sans'], weight = s.infoWeight ?? 700;
  const primary = s.infoColor ?? '#ffffff', secondary = s.infoSecondaryColor ?? '#c8d0e5';
  const rows = [ ...(title ? [{text:s.trackTitle.trim(),size:titleSize,color:primary,height:titleSize*1.35}] : []),
    ...(artist ? [{text:s.trackArtist.trim(),size:secondarySize,color:secondary,height:secondarySize*1.55}] : []),
    ...(s.showTimer ? [{text:`${stamp(time)} / ${stamp(duration)}`,size:secondarySize,color:secondary,height:secondarySize*1.7}] : []) ];
  ctx.save(); ctx.globalAlpha *= (s.infoOpacity ?? 100)/100;
  let rowWidth = 0;
  for (const row of rows) { ctx.font = `${weight} ${row.size}px ${family}`; row.text = fit(ctx,row.text,maxWidth); rowWidth = Math.max(rowWidth,ctx.measureText(row.text).width); }
  // Preserve title/artist colors in the compact caption footer too.
  const compactSize = title ? titleSize : secondarySize;
  if (compact) {
    ctx.font = `${weight} ${compactSize}px ${family}`;
    const share = maxWidth/Math.max(1,rows.length) - ctx.measureText(' · ').width;
    for(const row of rows) row.text = fit(ctx,row.text,share);
    rowWidth = Math.min(maxWidth,rows.reduce((sum,row)=>sum+ctx.measureText(row.text).width,0)+ctx.measureText(' · ').width*(rows.length-1));
  }
  const boxW = Math.min(w-edge*2,rowWidth+pad*2), boxH = contentH+pad*2;
  const left = s.infoAlign === 'center' ? (w-boxW)/2 : s.infoAlign === 'right' ? w-edge-boxW : edge;
  const top = Math.max(0,y-pad), background = s.infoBackground ?? '#040816', opacity = (s.infoBackgroundOpacity ?? 55)/100;
  const style = s.infoStyle ?? 'shade';
  if(style === 'shade') {
    const shade = ctx.createLinearGradient(0,top-pad,0,top+boxH+pad);
    shade.addColorStop(0,rgba(background,0)); shade.addColorStop(.45,rgba(background,opacity)); shade.addColorStop(1,rgba(background,0));
    ctx.fillStyle=shade; ctx.fillRect(0,top-pad,w,boxH+pad*2);
  } else if(style === 'card' || style === 'accent') {
    ctx.fillStyle=rgba(background,opacity); ctx.beginPath(); ctx.roundRect(left,top,boxW,boxH,style==='card' ? Math.min(boxH/2,(s.infoRadius ?? 16)*unit/720) : pad*.5);ctx.fill();
    if(style === 'accent'){ctx.fillStyle=s.primary;ctx.beginPath();ctx.roundRect(left,top+pad*.5,Math.max(3,unit*.004),boxH-pad,pad*.15);ctx.fill();}
  }
  const textX = s.infoAlign === 'center' ? w/2 : s.infoAlign === 'right' ? w-edge-pad : edge+pad;
  ctx.textAlign=s.infoAlign;ctx.textBaseline='top';ctx.shadowColor='#020513';ctx.shadowBlur=unit*.012;
  if(compact) {
    ctx.textAlign='left';ctx.font=`${weight} ${compactSize}px ${family}`;
    let x = s.infoAlign === 'center' ? (w-rowWidth)/2 : s.infoAlign === 'right' ? w-edge-pad-rowWidth : edge+pad;
    for(let i=0;i<rows.length;i++) {const row=rows[i];ctx.fillStyle=row.color;ctx.fillText(row.text,x,y);x+=ctx.measureText(row.text).width;if(i<rows.length-1){ctx.fillStyle=secondary;ctx.fillText(' · ',x,y);x+=ctx.measureText(' · ').width;}}
  } else {
    let rowY=y;for(const row of rows){ctx.font=`${row===rows[0]&&title ? weight : 500} ${row.size}px ${family}`;ctx.fillStyle=row.color;ctx.fillText(row.text,textX,rowY);rowY+=row.height;}
  }
  ctx.restore();
}
