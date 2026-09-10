(() => {
    'use strict';
    const T=window.BoxTrajectory;
    // Shared by the scan query and record table; each page owns its selected record.
    function create({diagram,status:statusElement,emptyText='等待查询'}) {
        const ns='http://www.w3.org/2000/svg';
        const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
        const wheels=[];
        let frame=0,selectedRecord=null;
        function stopFrame() {if(frame)cancelAnimationFrame(frame);frame=0;}
        function svg(tag,attrs,parent) {
            const el=document.createElementNS(ns,tag);
            Object.entries(attrs).forEach(([k,v])=>el.setAttribute(k,String(v)));
            if(parent)parent.appendChild(el);return el;
        }
        function formatNumber(value) {return String(value).padStart(2,'0');}
        function mold(parent,cls,label='') {
            const group=svg('g',{class:'mold '+cls},parent);
            svg('ellipse',{cx:3,cy:14,rx:17,ry:5,class:'mold-shadow'},group);
            const faces=svg('g',{transform:'rotate(-7)'},group);
            svg('rect',{x:-10,y:-8,width:29,height:26,rx:5,class:'mold-side'},faces);
            svg('rect',{x:-15,y:-13,width:29,height:26,rx:5,class:'mold-face'},faces);
            svg('path',{d:'M-10 -8 H8',class:'mold-edge'},faces);
            const text=svg('text',{x:0,y:5,class:'mold-label'},faces);
            text.textContent=label;
            if(label.length>3){text.setAttribute('textLength','23');text.setAttribute('lengthAdjust','spacingAndGlyphs');}
            return {group,text};
        }
        function place(el,p,scale=1) {el.setAttribute('transform','translate('+p.x+' '+p.y+')'+(scale!==1?' scale('+scale+')':''));}
        function setLayout(configs) {
            const list=Array.isArray(configs)?configs:[];
            for(const w of wheels) {
                const config=list.find(item=>T.number(item.id)===w.id);
                w.motion.configure(config?config.min:null,config?config.max:null);
                w.ticks.replaceChildren();w.spokes.replaceChildren();w.slots.replaceChildren();
                // Keep every slot fixed. Large configured ranges use a scale instead of fictitious boxes.
                const count=Math.min(w.motion.count,24);
                for(let i=0;i<count;i++) {
                    const slot=Math.floor(i*w.motion.count/count),fraction=slot/w.motion.count;
                    const p=T.point(w,fraction,5),q=T.point(w,fraction,17);
                    svg('line',{x1:p.x,y1:p.y,x2:q.x,y2:q.y,class:'wheel-tick'},w.ticks);
                }
                if(w.motion.count && w.motion.count<=12) {
                    const slots=Array.from({length:w.motion.count},(_,i)=>({value:w.motion.min+i,p:T.point(w,i/w.motion.count)}));
                    slots.sort((a,b)=>a.p.y-b.p.y).forEach(slot=>{
                        svg('line',{x1:w.cx,y1:w.cy,x2:slot.p.x,y2:slot.p.y,class:'wheel-spoke'},w.spokes);
                        const tile=mold(w.slots,'mold-station',formatNumber(slot.value));place(tile.group,slot.p,w.id===1?.85:1);
                        tile.group.dataset.number=slot.value;
                        svg('title',{},tile.group).textContent=w.name+' · 模盒 '+slot.value;
                    });
                } else if(w.motion.count) {
                    for(let i=0;i<4;i++) {
                        const slot=Math.floor(i*w.motion.count/4),p=T.point(w,slot/w.motion.count);
                        svg('line',{x1:w.cx,y1:w.cy,x2:p.x,y2:p.y,class:'wheel-spoke'},w.spokes);
                    }
                }
            }
            if(selectedRecord) select(selectedRecord); else draw();
        }
        function wheelDescription(w) {
            const m=w.motion;
            if(m.status==='empty')return '等待查询';
            if(m.status==='missing')return '暂无编号';
            if(m.status==='unconfigured')return '范围未配置';
            if(m.status==='out-of-range')return '编号超出范围';
            return m.status==='moving'?'目标模盒':'模盒编号';
        }
        function draw() {
            for(const w of wheels) {
                const m=w.motion,description=wheelDescription(w);
                w.group.dataset.state=m.status;w.value.textContent=m.target===null?'—':'M-'+formatNumber(m.target);
                if(w.value.textContent.length>6){w.value.setAttribute('textLength',w.id===1?'78':'103');w.value.setAttribute('lengthAdjust','spacingAndGlyphs');}
                else {w.value.removeAttribute('textLength');w.value.removeAttribute('lengthAdjust');}
                w.detail.textContent=description;
                w.title.textContent=w.name+'：'+description+(m.target!==null?' '+m.target:'')+(m.count?'，编号范围 '+m.min+' 至 '+m.max:'');
                const visible=m.cursor!==null && ['located','moving'].includes(m.status);
                w.marker.setAttribute('visibility',visible?'visible':'hidden');
                if(visible) {
                    const p=T.point(w,m.cursor);
                    place(w.marker,p,w.id===1?.85:1);
                    // The moving highlight carries no station number until it reaches the fixed target.
                    w.markerValue.textContent=m.status==='moving'?'·':formatNumber(m.target);
                    if(w.markerValue.textContent.length>3){w.markerValue.setAttribute('textLength','23');w.markerValue.setAttribute('lengthAdjust','spacingAndGlyphs');}
                    else {w.markerValue.removeAttribute('textLength');w.markerValue.removeAttribute('lengthAdjust');}
                }
                const length=m.animation?Math.min(.17,Math.max(0,m.cursor-m.animation.from)):0;
                w.trail.setAttribute('d',length>.001?T.path(w,m.cursor-length,m.cursor):'');
                w.ghosts.forEach((ghost,index)=>{
                    const offset=(index+1)*.025,show=length>offset;
                    ghost.setAttribute('visibility',show?'visible':'hidden');
                    if(show)place(ghost,T.point(w,m.cursor-offset),w.id===1?.85:1);
                });
            }
            const moving=wheels.filter(w=>w.motion.status==='moving').length;
            const located=wheels.filter(w=>w.motion.status==='located').length;
            const missing=wheels.filter(w=>['missing','unconfigured','out-of-range'].includes(w.motion.status)).length;
            const summary=!selectedRecord?emptyText:moving?'正在定位 · '+located+' / 7':missing?'已定位 '+located+' / 7 · '+missing+' 轮待确认':'7 / 7 轮已定位';
            if(statusElement.textContent!==summary) statusElement.textContent=summary;
        }
        function tick(now) {
            frame=0;wheels.forEach(w=>w.motion.sample(now));draw();
            if(wheels.some(w=>w.motion.animation))frame=requestAnimationFrame(tick);
        }

        function select(record) {
            stopFrame();selectedRecord=record;
            const now=performance.now();
            wheels.forEach(w=>w.motion.select(T.wheelNumber(record,w.id),now,reduced.matches));
            draw();if(wheels.some(w=>w.motion.animation))frame=requestAnimationFrame(tick);
        }
        function clear() {
            stopFrame();selectedRecord=null;wheels.forEach(w=>w.motion.clear());draw();
        }
        const defs=svg('defs',{},diagram);
        const surface=svg('linearGradient',{id:'platter-surface',x1:'0%',y1:'0%',x2:'0%',y2:'100%'},defs);
        svg('stop',{offset:'0%','stop-color':'#ffffff'},surface);svg('stop',{offset:'100%','stop-color':'#e8edf9'},surface);
        const edge=svg('linearGradient',{id:'platter-edge',x1:'0%',y1:'0%',x2:'0%',y2:'100%'},defs);
        svg('stop',{offset:'0%','stop-color':'#d5def0'},edge);svg('stop',{offset:'100%','stop-color':'#aebfdd'},edge);
        const shadow=svg('filter',{id:'platter-shadow',x:'-30%',y:'-60%',width:'160%',height:'220%'},defs);
        svg('feGaussianBlur',{stdDeviation:4},shadow);
        for(const config of T.WHEELS) {
            const group=svg('g',{class:'wheel-group','data-wheel':config.id},diagram);
            const title=svg('title',{},group);
            const rotation='rotate('+config.rotation+' '+config.cx+' '+config.cy+')';
            function ellipse(cls,inset=0,depth=0) {
                return svg('ellipse',{cx:config.cx,cy:config.cy,rx:config.rx-inset,ry:config.ry-inset,transform:'translate(0 '+depth+') '+rotation,class:cls},group);
            }
            ellipse('wheel-shadow',2,22);ellipse('wheel-side',0,14);ellipse('wheel-bottom-line',0,11);
            ellipse('wheel-body');ellipse('wheel-track',11);ellipse('wheel-inner',22);
            const spokes=svg('g',{'aria-hidden':'true'},group),ticks=svg('g',{'aria-hidden':'true'},group);
            const arrows=svg('g',{'aria-hidden':'true'},group);
            [.14,.39,.64,.89].forEach(fraction=>{
                const p=T.point(config,fraction),q=T.point(config,fraction+.002);
                const angle=Math.atan2(q.y-p.y,q.x-p.x)*180/Math.PI;
                svg('path',{d:'M-3 -3 L0 0 L-3 3',transform:'translate('+p.x+' '+p.y+') rotate('+angle+')',class:'wheel-arrow'},arrows);
            });
            const trail=svg('path',{d:'',class:'wheel-trail'},group);
            const labelX=config.id===1?65:config.cx;
            const labelY=config.id===1?145:config.cy-config.ry-32;
            svg('text',{x:labelX,y:labelY,class:'wheel-name'},group).textContent=config.name;
            // The upright first wheel keeps its hub information in a callout above the platter.
            const hubY=config.id===1?174:config.cy;
            if(config.id!==1)svg('ellipse',{cx:config.cx,cy:config.cy,rx:46,ry:23,class:'wheel-hub'},group);
            else svg('path',{d:'M65 199 L65 210',class:'wheel-callout'},group);
            const value=svg('text',{x:labelX,y:hubY+2,class:'wheel-number'},group);
            const detail=svg('text',{x:labelX,y:hubY+16,class:'wheel-detail'},group);
            const slots=svg('g',{'aria-hidden':'true'},group);
            const ghosts=Array.from({length:4},(_,index)=>mold(group,'mold-ghost ghost-'+index).group);
            const active=mold(group,'mold-active');active.group.setAttribute('visibility','hidden');
            wheels.push({...config,group,title,ticks,spokes,slots,trail,value,detail,ghosts,marker:active.group,markerValue:active.text,motion:new T.WheelMotion()});
        }

        function motionPreference(event) {
            if(event.matches){stopFrame();wheels.forEach(w=>w.motion.finish());draw();}
        }
        reduced.addEventListener('change',motionPreference);
        draw();
        return {setLayout,select,clear,destroy(){stopFrame();reduced.removeEventListener('change',motionPreference);}};
    }
    window.BoxTrajectoryView={create};
})();
