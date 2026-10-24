/** Reviewed scene templates. Narration durations determine the final timelines. */
export function derivativeScene(index: number, duration: number, cueEnds: number[], reducedMotion = false): string {
  const shared = `
    const duration = ${duration};
    const P = (x, y) => [1.65*x-3.1, 1.05*y-1.5];
    const f = x => 0.5*x*x;
    const A = P(1, f(1));
    const curve = Array.from({length:101}, (_,i) => { const x=-0.4+i*0.031; return P(x,f(x)); });
    const line = b => { const m=(f(b)-f(1))/(b-1); return [P(-0.1,f(1)+m*(-1.1)),P(2.7,f(1)+m*1.7)]; };
    const text = (id, value, x, y, size=0.3, fill='WHITE') => s.text(id,{text:value,position:[x,y],fontSize:size,fill});
    s.play(s.camera.to2D({height:7}),{duration:0});
    text('title', ${JSON.stringify(['From two points to the slope', 'B approaches A', 'The derivative is the slope of the tangent', 'Up close: almost a straight line'][index])}, 0, 2.9, 0.34);
  `;
  const graph = `
    s.line('axis-x',{points:[P(-0.5,0),P(2.9,0)],stroke:'GREY_C',strokeWidth:0.018});
    s.line('axis-y',{points:[P(0,-0.5),P(0,3.9)],stroke:'GREY_C',strokeWidth:0.018});
    text('axis-x-label','x',1.9,-1.5,0.23,'GREY_B');
    text('axis-y-label','f(x)',-3.1,2.7,0.23,'GREY_B');
    for(let x=1;x<=2;x++) {
      s.line('tick-'+x,{points:[P(x,-0.06),P(x,0.06)],stroke:'GREY_B',strokeWidth:0.02});
      text('number-'+x,String(x),P(x,0)[0],-1.8,0.23,'GREY_B');
    }
    s.path('curve',{points:curve,stroke:'BLUE',strokeWidth:0.045,fill:'none'});
    s.circle('a',{position:A,radius:0.07,fill:'YELLOW'});
    text('a-label','A',A[0]-0.2,A[1]+0.24,0.28,'YELLOW');
    s.latex('function',{tex:'f(x) = '+String.fromCharCode(92)+'frac{1}{2} x^2',position:[-1.3,2.3],fontSize:0.29,fill:'BLUE'});
  `;
  let body: string;
  if (index === 0) {
    body = `${graph}
      const B=P(2.5,f(2.5));
      const secant=s.line('secant',{points:line(2.5),stroke:'YELLOW',strokeWidth:0.035,opacity:0});
      const b=s.circle('b',{position:B,radius:0.07,fill:'WHITE',opacity:0});
      const bl=text('b-label','B',B[0]+0.2,B[1]+0.2,0.28);
      s.play(bl.animate({opacity:0}),{duration:0});
      text('kind','Secant',3.4,1.3,0.47,'YELLOW');
      text('meaning','Connects A and B',3.4,0.7,0.28);
      text('formula','Slope = Δy / Δx',3.4,-0.1,0.31);
      text('value','here: 1.75',3.4,-0.65,0.38,'YELLOW');
      s.wait(${Math.max(0, cueEnds[0] - 0.25)});
      s.play([secant.fadeIn(),b.fadeIn(),bl.fadeIn()],{duration:0.5});
      s.line('run',{points:[A,P(2.5,f(1))],stroke:'TEAL',strokeWidth:0.025});
      s.line('rise',{points:[P(2.5,f(1)),B],stroke:'TEAL',strokeWidth:0.025});
      text('run-label','Δx',(A[0]+B[0])/2,A[1]-0.3,0.25,'TEAL');
      text('rise-label','Δy',B[0]+0.3,(A[1]+B[1])/2,0.25,'TEAL');
      s.wait(duration-${Math.max(0, cueEnds[0] - 0.25)}-0.5);
    `;
  } else if (index === 1) {
    const start = 2.5, end = 1.04, steps = reducedMotion ? 1 : 50;
    body = `${graph}
      const b=s.circle('b',{position:P(${start},f(${start})),radius:0.07,fill:'WHITE'});
      const secant=s.line('secant',{points:line(${start}),stroke:'YELLOW',strokeWidth:0.035});
      text('kind','B moves closer',3.4,1.3,0.43,'WHITE');
      text('meaning','A stays fixed',3.4,0.7,0.29,'YELLOW');
      text('formula','Secant → tangent',3.4,-0.1,0.3,'YELLOW');
      text('value','Slope → 1',3.4,-0.65,0.36);
      s.wait(2);
      for(let i=1;i<=${steps};i++) {
        const t=i/${steps}; const x=${end}+(${start-end})*(1-t)*(1-t);
        s.play([b.moveTo(P(x,f(x))),secant.morphTo({kind:'line',points:line(x)})],{duration:${Math.max(1, cueEnds[0] - 2)/steps},ease:'linear'});
      }
      s.wait(duration-2-${Math.max(1,cueEnds[0]-2)});
    `;
  } else if (index === 2) {
    body = `${graph}
      s.line('tangent',{points:[P(-0.1,-0.6),P(2.7,2.2)],stroke:'YELLOW',strokeWidth:0.04});
      text('kind','Tangent',3.4,1.3,0.47,'YELLOW');
      text('meaning','Slope at A',3.4,0.7,0.29);
      s.latex('formula',{tex:"f'(1) = 1",position:[3.4,-0.1],fontSize:0.48,fill:'YELLOW'});
      text('value','1 to the right, 1 up',3.3,-0.75,0.25);
      s.wait(${cueEnds[0]});
      const run=s.line('run',{points:[A,P(2,f(1))],stroke:'TEAL',strokeWidth:0.03,opacity:0});
      const rise=s.line('rise',{points:[P(2,f(1)),P(2,1.5)],stroke:'TEAL',strokeWidth:0.03,opacity:0});
      text('run-label','1',P(1.5,0.5)[0],A[1]-0.3,0.26,'TEAL');
      text('rise-label','1',P(2,1)[0]+0.25,P(2,1)[1],0.26,'TEAL');
      s.play([run.fadeIn(),rise.fadeIn()],{duration:0.6});
      s.wait(duration-${cueEnds[0]}-0.6);
    `;
  } else {
    const steps = reducedMotion ? 1 : 50;
    body = `
      const points = z => Array.from({length:101},(_,i) => {
        const t=-1.7+i*0.034; const x=1+t/z;
        return [-1.8+t, z*(f(x)-f(1))];
      });
      const zoomCurve=s.path('curve',{points:points(1),stroke:'BLUE',strokeWidth:0.045,fill:'none'});
      s.line('tangent',{points:[[-3.5,-1.7],[-0.1,1.7]],stroke:'YELLOW',strokeWidth:0.035});
      s.circle('a',{position:[-1.8,0],radius:0.07,fill:'YELLOW'});
      text('a-label','A',-2.05,0.3,0.27,'YELLOW');
      text('kind','Local slope',3.1,1.3,0.4,'WHITE');
      text('legend-curve','Blue: the curve',3.1,0.65,0.3,'BLUE');
      text('legend-tangent','Yellow: the tangent',3.1,0.15,0.3,'YELLOW');
      s.latex('formula',{tex:"f'(1) = 1",position:[3.1,-0.65],fontSize:0.48,fill:'YELLOW'});
      text('zoom-label','Section around A',-1.8,-2.3,0.25,'GREY_B');
      s.wait(1);
      for(let i=1;i<=${steps};i++) {
        const z=1+15*i/${steps};
        s.play(zoomCurve.morphTo({kind:'path',points:points(z),fill:'none'}),{duration:${Math.max(1,cueEnds[0]-1)/steps},ease:'linear'});
      }
      s.wait(duration-1-${Math.max(1,cueEnds[0]-1)});
    `;
  }
  return `export default scene({mode:'2d',end:'hold',audio:'narration-${index}',background:'BLACK'}, s => {${shared}${body}});`;
}
