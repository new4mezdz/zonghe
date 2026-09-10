(function (root) {
    'use strict';
    const WHEELS = [
        {id:1,name:'一号轮',cx:58,cy:285,rx:35,ry:83,rotation:20},
        {id:2,name:'二号轮',cx:201,cy:286,rx:88,ry:54,rotation:0},
        {id:3,name:'三号轮',cx:390,cy:293,rx:88,ry:54,rotation:0},
        {id:4,name:'四号轮',cx:497,cy:144,rx:96,ry:57,rotation:0},
        {id:5,name:'五号轮',cx:704,cy:144,rx:89,ry:54,rotation:0},
        {id:6,name:'六号轮',cx:789,cy:327,rx:91,ry:54,rotation:0},
        {id:8,name:'八号轮',cx:902,cy:146,rx:83,ry:54,rotation:0}
    ];
    const mod = value => ((value % 1) + 1) % 1;
    function number(value) {
        if (value === null || value === undefined || typeof value === 'boolean' || (typeof value === 'string' && !value.trim())) return null;
        if (typeof value !== 'number' && typeof value !== 'string') return null;
        const result = Number(value);
        return Number.isSafeInteger(result) ? result : null;
    }
    function wheelNumber(record, id) {
        if (record && record.wheel_numbers && Object.prototype.hasOwnProperty.call(record.wheel_numbers, String(id))) return number(record.wheel_numbers[String(id)]);
        return id === 3 && record ? number(record.box_num) : null;
    }
    function point(wheel, fraction, inset = 11) {
        const angle = fraction * Math.PI * 2 - Math.PI / 2, rotation = wheel.rotation * Math.PI / 180;
        const x = (wheel.rx - inset) * Math.cos(angle), y = (wheel.ry - inset) * Math.sin(angle);
        return {x:wheel.cx + x * Math.cos(rotation) - y * Math.sin(rotation), y:wheel.cy + x * Math.sin(rotation) + y * Math.cos(rotation)};
    }
    function path(wheel, from, to) {
        let result = '';
        for (let i=0;i<=32;i++) {
            const p = point(wheel, from + (to-from)*i/32);
            result += (i?'L':'M') + p.x.toFixed(3) + ',' + p.y.toFixed(3) + ' ';
        }
        return result;
    }
    class WheelMotion {
        constructor() { this.min=null;this.max=null;this.count=0;this.clear(); }
        configure(minimum, maximum) {
            const min=number(minimum), max=number(maximum);
            const valid=min!==null && max!==null && max>=min && Number.isSafeInteger(max-min+1);
            const nextMin=valid?min:null,nextMax=valid?max:null;
            if(this.min!==nextMin || this.max!==nextMax) this.clear();
            this.min=nextMin;this.max=nextMax;this.count=valid?max-min+1:0;
        }
        clear() { this.cursor=null;this.target=null;this.animation=null;this.status='empty'; }
        sample(now) {
            if(!this.animation) return;
            const a=this.animation,t=Math.min(1,Math.max(0,(now-a.started)/a.duration));
            a.progress=t;this.cursor=a.from+(a.to-a.from)*t*t*(3-2*t);
            if(t>=1) {this.cursor=a.to;this.animation=null;this.status='located';}
        }
        select(value, now, reduced=false) {
            this.sample(now);
            const target=number(value);
            if(target===this.target && ['located','moving'].includes(this.status)) return;
            this.target=target;this.animation=null;
            if(target===null) {this.cursor=null;this.status='missing';return;}
            if(!this.count) {this.cursor=null;this.status='unconfigured';return;}
            if(target<this.min || target>this.max) {this.cursor=null;this.status='out-of-range';return;}
            const fraction=(target-this.min)/this.count;
            if(this.cursor===null) this.cursor=0;
            let distance=mod(fraction-mod(this.cursor));
            if(distance<1e-9 || 1-distance<1e-9) distance=0;
            if(reduced || !distance) {this.cursor+=distance;this.status='located';return;}
            this.animation={from:this.cursor,to:this.cursor+distance,started:now,duration:700+distance*1400,progress:0};
            this.status='moving';
        }
        finish() {if(this.animation){this.cursor=this.animation.to;this.animation=null;this.status='located';}}
    }
    const api={WHEELS,WheelMotion,number,wheelNumber,point,path};
    if(typeof module!=='undefined' && module.exports) module.exports=api;
    else root.BoxTrajectory=api;
})(typeof window!=='undefined'?window:globalThis);
