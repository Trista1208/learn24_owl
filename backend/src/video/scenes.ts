import type { VideoLesson } from '@l45/shared';

export const VIDEO_TEMPLATE_VERSION = 1;

/** Wrap untrusted lesson text before placing it in a fixed-size animation. */
export function wrapText(text: string, width = 40): string[] {
  // MathJax's bundled text font has straight quotes but no guillemets. Speech/captions keep the original.
  const words = text.replace(/[«»„“”]/g, '"').trim().split(/\s+/).flatMap(word => word.match(new RegExp(`.{1,${width}}`, 'gu')) ?? []);
  const lines: string[] = [];
  for (const word of words) {
    if (!lines.length || lines.at(-1)!.length + word.length + 1 > width) lines.push(word);
    else lines[lines.length - 1] += ` ${word}`;
  }
  return lines;
}

/** Reviewed animations receive data, never model-authored executable code. */
export function videoScene(lesson: VideoLesson, index: number, duration: number, speechEnd: number): string {
  const scene = lesson.content.scenes[index];
  const items = scene.items ?? [];
  const title = wrapText(lesson.title, 48);
  const first = lesson.content.scenes.findIndex(s => s.visual === scene.visual) === index;
  let body: string;
  switch (scene.visual) {
    case 'steps': {
      const rows = items.map(item => wrapText(item, items.length > 4 ? 22 : 38));
      body = `
        const rows=${JSON.stringify(rows)};
        const columns=rows.length>4?2:1, count=Math.ceil(rows.length/columns);
        const height=Math.min(1.55,5/count), fade=Math.min(.3,duration/(rows.length+1));
        const gap=Math.max(0,(${speechEnd}*.75-rows.length*fade)/Math.max(1,rows.length-1));
        rows.forEach((lines,i)=>{
          const col=Math.floor(i/count),row=i%count;
          const x=columns===1?0:(col===0?-3:3), y=1.65-row*height;
          const number=s.circle('number-'+i,{position:[x-(columns===1?4.8:2.4),y],radius:.22,fill:'YELLOW',opacity:0});
          const digit=s.text('digit-'+i,{text:String(i+1),position:[x-(columns===1?4.8:2.4),y],fontSize:.23,fill:'BLACK',opacity:0});
          const labels=lines.map((line,j)=>s.text('item-'+i+'-'+j,{text:line,position:[x+.35,y+(lines.length-1)*.18-j*.36],fontSize:.29,fill:'WHITE',opacity:0}));
          play([number.fadeIn(),digit.fadeIn(),...labels.map(label=>label.fadeIn())],fade);
          if(i<rows.length-1)wait(gap);
        });`;
      break;
    }
    case 'url-parts':
      body = `
        label('url',${JSON.stringify(wrapText(items.join(''), 48))},0,1.5,.3,'WHITE');
        label('domain',${JSON.stringify(wrapText((items[2] ?? '') + (items[3] ?? ''), 36))},0,-.2,.43,'YELLOW');
        label('meaning',['This domain counts'],0,-1.65,.32,'WHITE');
        const underline=s.line('underline',{points:[[-3,-.85],[3,-.85]],stroke:'YELLOW',strokeWidth:.04,opacity:0});
        wait(Math.min(1,duration/4));play(underline.fadeIn(),Math.min(.6,duration/4));`;
      break;
    case 'next-word':
      body = `
        label('prompt',['The team meets next …'],0,1.8,.32,'WHITE');
        const words=['Monday','Tuesday','Wednesday','Friday','June'], values=[1,.46,.37,.22,.13];
        words.forEach((word,i)=>{
          const y=.9-i*.7;
          label('word-'+i,[word],-3.8,y,.27,i===0&&${!first}?'YELLOW':'WHITE');
          const bar=s.line('bar-'+i,{points:[[-2.2,y],[-2.2+6*values[i],y]],stroke:i===0&&${!first}?'YELLOW':'BLUE',strokeWidth:.25,opacity:0});
          play(bar.fadeIn(),Math.min(.25,duration/10));
        });
        label('example',['Example values: sounding right does not make it true.'],0,-3,.2,'GREY_B');`;
      break;
    case 'invented-detail':
      body = `
        label('source-title',['Note'],0,1.9,.3,'BLUE');
        label('source',['The team meets next week.','The day is still open.'],0,1.2,.3,'WHITE');
        label('summary-title',['AI summary'],0,-.2,.3,'BLUE');
        label('summary',['The team meets next Monday.'],0,-.9,.32,'YELLOW');
        const warning=s.text('warning',{text:'Monday: not in the note anywhere',position:[0,-2.1],fontSize:.3,fill:'RED',opacity:0});
        wait(Math.min(1,duration/4));play(warning.fadeIn(),Math.min(.5,duration/4));`;
      break;
    case 'falling': {
      const vacuum = /ohne Luft|Vakuum/i.test([scene.caption, ...items].join(' '));
      body = `
        label('environment',[${JSON.stringify(vacuum ? 'Without air (vacuum)' : 'With air')}],0,1.9,.4,'WHITE');
        s.line('ground',{points:[[-5,-2.6],[5,-2.6]],stroke:'GREY_B',strokeWidth:.02});
        label('ball-label',['Ball'],-2.5,-3,.25,'WHITE');label('feather-label',['Feather'],2.5,-3,.25,'YELLOW');
        const ball=s.circle('ball',{position:[-2.5,1.15],radius:.22,fill:'WHITE'});
        const feather=s.path('feather',{position:[2.5,1.15],points:[[-.3,-.15],[0,.25],[.35,.2],[.05,-.05],[-.3,-.15]],fill:'YELLOW',stroke:'YELLOW',strokeWidth:.02});
        wait(Math.min(.6,duration/8));
        play([ball.moveTo([-2.5,-2.35]),feather.moveTo([2.5,${vacuum ? -2.35 : -.1}])],Math.min(3,${speechEnd}*.6));`;
      break;
    }
    case 'secant-tangent':
      body = `
        const P=(x,y)=>[1.6*x-3,1.05*y-1.5],f=x=>.5*x*x;
        s.path('curve',{points:Array.from({length:101},(_,i)=>{const x=-.4+i*.031;return P(x,f(x));}),stroke:'BLUE',strokeWidth:.04,fill:'none'});
        const A=P(1,f(1));s.circle('a',{position:A,radius:.07,fill:'YELLOW'});label('a-label',['A'],A[0]-.2,A[1]+.3,.3,'YELLOW');
        const line=b=>{const m=(f(b)-f(1))/(b-1);return [P(-.1,f(1)-1.1*m),P(2.7,f(1)+1.7*m)];};
        const b=s.circle('b',{position:P(2.5,f(2.5)),radius:.07,fill:'WHITE'});
        const secant=s.line('secant',{points:line(2.5),stroke:'YELLOW',strokeWidth:.035});
        label('kind',[${JSON.stringify(first ? 'Secant through A and B' : 'B moves towards A')}],3.4,.8,.3,'YELLOW');
        label('formula',['Slope = difference in height','divided by distance'],3.4,-.2,.23,'WHITE');
        ${first ? '' : `for(let i=1;i<=30;i++){const x=1.04+1.46*(1-i/30)**2;play([b.moveTo(P(x,f(x))),secant.morphTo({kind:'line',points:line(x)})],${speechEnd}*.75/30);}`}`;
      break;
    case 'slope-zoom':
      body = `
        const f=x=>.5*x*x;
        const points=z=>Array.from({length:101},(_,i)=>{const t=-1.7+i*.034;return [-2+t,z*(f(1+t/z)-f(1))];});
        const curve=s.path('curve',{points:points(1),stroke:'BLUE',strokeWidth:.04,fill:'none'});
        s.line('tangent',{points:[[-3.7,-1.7],[-.3,1.7]],stroke:'YELLOW',strokeWidth:.035});
        s.circle('a',{position:[-2,0],radius:.07,fill:'YELLOW'});
        label('meaning',['Local slope'],3.3,.9,.36,'WHITE');
        s.latex('formula',{tex:"f'(1) = 1",position:[3.3,-.1],fontSize:.45,fill:'YELLOW'});
        label('legend',['Blue: curve','Yellow: tangent'],3.3,-1.2,.28,'WHITE');
        ${first ? '' : `for(let i=1;i<=30;i++)play(curve.morphTo({kind:'path',points:points(1+15*i/30),fill:'none'}),${speechEnd}*.75/30);`}`;
      break;
    default:
      throw new Error(`Unknown video visual: ${String(scene.visual)}`);
  }
  return `export default scene({mode:'2d',end:'hold',audio:'narration-${index}',background:'BLACK'},s=>{
    const duration=${duration};let elapsed=0;
    const wait=t=>{s.wait(t);elapsed+=t;};const play=(a,t)=>{s.play(a,{duration:t,ease:'linear'});elapsed+=t;};
    const label=(id,lines,x,y,size,fill)=>lines.forEach((text,i)=>s.text(id+'-'+i,{text,position:[x,y-i*size*1.4],fontSize:size,fill}));
    s.play(s.camera.to2D({height:8}),{duration:0});
    label('scene',['Scene ${index + 1} / ${lesson.content.scenes.length}'],0,3.7,.18,'GREY_B');
    label('title',${JSON.stringify(title)},0,3.18,.31,'WHITE');
    ${body}
    wait(Math.max(0,duration-elapsed));
  });`;
}
