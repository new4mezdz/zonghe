(() => {
    'use strict';
    const T=window.BoxTrajectory, byId=id=>document.getElementById(id);
    const view=window.BoxTrajectoryView.create({diagram:byId('wheelDiagram'),status:byId('locationStatus')});
    const transport=createTransportView(byId('wheelDiagram'),byId('transportStatus'));
    const stations=[{id:0,name:'输送盒模'},...T.WHEELS];
    const REFRESH_WAIT_MINUTES=5,REFRESH_WAIT_MS=REFRESH_WAIT_MINUTES*60*1000;
    let querySequence=0, controller=null, activeEntry=null, selectedRecord=null;
    let refreshTimer=0,refreshExpiry=0,refreshController=null;
    let history=[], historyId=0, roundCount=0, hitCounts=Array(8).fill(0), layoutVersion=0;
    const beijingDay=()=>new Date(Date.now()+8*3600000).toISOString().slice(0,10);
    let activeDay=beijingDay();
    function todayRange(entry,remote=false) {
        const minutes=entry.lookbackMinutes||(remote?entry.recentWindowMinutes:null);
        return minutes?'今天内最近'+minutes+'分钟':'今天';
    }
    function syncTodayScope() {
        const day=beijingDay();
        if(day===activeDay)return false;
        activeDay=day;cancelQuery();history=[];activeEntry=null;roundCount=0;hitCounts=Array(8).fill(0);
        clearSelection();renderMatches();renderHistory();renderInspection();
        status('已切换到北京时间今天 '+day+'，请重新查询；历史数据仍保留。');
        return true;
    }
    function element(tag,cls,text,parent) {
        const el=document.createElement(tag);if(cls)el.className=cls;
        if(text!==null && text!==undefined)el.textContent=String(text);
        if(parent)parent.appendChild(el);return el;
    }
    function button(cls,text,parent,handler) {
        const el=element('button',cls,text,parent);el.type='button';el.addEventListener('click',handler);return el;
    }
    function status(message,kind='info') {
        const el=byId('queryStatus');el.textContent=message;el.dataset.kind=kind;
    }
    function timeText(value) { return String(value||'时间未知').replace('T',' ').replace(/(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/,'').slice(0,23); }
    function clockText() { return new Date().toLocaleString('zh-CN',{hour12:false}); }
    function createTransportView(diagram,statusElement) {
        const ns='http://www.w3.org/2000/svg',motion=new T.WheelMotion();
        const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
        let frame=0,selected=false,inferred=false;
        function svg(tag,attrs,parent) {
            const el=document.createElementNS(ns,tag);
            Object.entries(attrs).forEach(([key,value])=>el.setAttribute(key,String(value)));
            parent.appendChild(el);return el;
        }
        // A continuous conveyor scale keeps the 40-position loop readable.
        const group=svg('g',{class:'transport-group','data-wheel':0},diagram);
        const title=svg('title',{},group);
        svg('path',{d:'M-190 240 H-87 A46 46 0 0 1 -87 332 H-190 A46 46 0 0 1 -190 240 Z',transform:'translate(0 8)',class:'transport-side'},group);
        svg('path',{d:'M-190 237 H-87 A49 49 0 0 1 -87 335 H-190 A49 49 0 0 1 -190 237 Z',class:'transport-body'},group);
        svg('path',{d:'M-190 243 H-87 A43 43 0 0 1 -87 329 H-190 A43 43 0 0 1 -190 243 Z',class:'transport-track'},group);
        const ticks=svg('g',{'aria-hidden':'true'},group);
        svg('path',{d:'M-190 256 H-87 A30 30 0 0 1 -87 316 H-190 A30 30 0 0 1 -190 256 Z',class:'transport-inner'},group);
        svg('text',{x:-139,y:202,class:'transport-name'},group).textContent='输送盒模';
        svg('text',{x:-139,y:220,class:'transport-caption'},group).textContent='一号轮前';
        const value=svg('text',{x:-139,y:285,class:'transport-number'},group);
        const detail=svg('text',{x:-139,y:304,class:'transport-detail'},group);
        const range=svg('text',{x:-139,y:365,class:'transport-range'},group);
        svg('path',{d:'M-23 285 H8 M2 280 L8 285 L2 290',class:'transport-link','aria-hidden':'true'},group);
        svg('path',{d:'M-150 239 L-145 243 L-150 247 M-126 325 L-131 329 L-126 333',class:'transport-direction','aria-hidden':'true'},group);
        const marker=svg('g',{class:'transport-marker',visibility:'hidden','aria-hidden':'true'},group);
        svg('rect',{x:-17,y:-13,width:34,height:30,rx:5,class:'transport-marker-side'},marker);
        svg('rect',{x:-17,y:-17,width:34,height:30,rx:5,class:'transport-marker-face'},marker);
        const markerValue=svg('text',{x:0,y:3,class:'transport-marker-label'},marker);
        function point(fraction,inset=0) {
            const radius=43,straight=103,arc=Math.PI*radius;
            let distance=((fraction%1)+1)%1*(2*straight+2*arc);
            if(distance<=straight)return {x:-190+distance,y:243+inset};
            distance-=straight;
            if(distance<=arc) {
                const angle=-Math.PI/2+distance/radius;
                return {x:-87+(radius-inset)*Math.cos(angle),y:286+(radius-inset)*Math.sin(angle)};
            }
            distance-=arc;
            if(distance<=straight)return {x:-87-distance,y:329-inset};
            const angle=Math.PI/2+(distance-straight)/radius;
            return {x:-190+(radius-inset)*Math.cos(angle),y:286+(radius-inset)*Math.sin(angle)};
        }
        function stop() {if(frame)cancelAnimationFrame(frame);frame=0;}
        function draw() {
            const state=motion.status,valid=['located','moving'].includes(state);
            const description=state==='empty'?'等待查询':state==='missing'?'暂无编号':state==='unconfigured'?'范围未配置':state==='out-of-range'?'编号超出范围':state==='moving'?'目标模盒':'模盒编号';
            group.dataset.state=state;
            value.textContent=motion.target===null?'—':'M-'+String(motion.target).padStart(2,'0');
            detail.textContent=valid && inferred?'已知编号与连续记录推算':description;
            range.textContent=motion.count?'循环 '+motion.min+'–'+motion.max+' · '+motion.count+' 个盒模':'循环范围待加载';
            title.textContent='输送盒模：'+description+(motion.target!==null?' '+motion.target:'')+(motion.count?'，编号范围 '+motion.min+' 至 '+motion.max:'')+(valid && inferred?'，依据已知输送编号及连续记录推算':'');
            marker.setAttribute('visibility',valid?'visible':'hidden');
            if(valid) {
                const p=point(motion.cursor);marker.setAttribute('transform','translate('+p.x+' '+p.y+')');
                markerValue.textContent=state==='moving'?'·':String(motion.target).padStart(2,'0');
            }
            statusElement.textContent=!selected?'输送：等待查询':state==='moving'?'输送：正在定位':state==='located'?'输送：'+motion.target+' 号':'输送：'+description;
            statusElement.dataset.state=state;
        }
        function tick(now) {frame=0;motion.sample(now);draw();if(motion.animation)frame=requestAnimationFrame(tick);}
        function select(record) {
            stop();selected=Boolean(record);inferred=Array.isArray(record?.inferred_wheels) && record.inferred_wheels.includes(0);motion.select(T.wheelNumber(record,0),performance.now(),reduced.matches);
            draw();if(motion.animation)frame=requestAnimationFrame(tick);
        }
        function setLayout(configs) {
            const config=(Array.isArray(configs)?configs:[]).find(item=>T.number(item.id)===0);
            stop();motion.configure(config?.min,config?.max);ticks.replaceChildren();
            const count=Math.min(motion.count,80);
            for(let i=0;i<count;i++) {
                const slot=Math.floor(i*motion.count/count),fraction=slot/motion.count;
                const p=point(fraction,-4),q=point(fraction,slot%5===0?6:2);
                svg('line',{x1:p.x,y1:p.y,x2:q.x,y2:q.y,class:'transport-tick'},ticks);
            }
            draw();
        }
        reduced.addEventListener('change',event=>{if(event.matches){stop();motion.finish();draw();}});
        draw();
        return {setLayout,select,clear(){stop();selected=false;inferred=false;motion.clear();draw();}};
    }
    function queryLoading(loading,minutes=null) {
        byId('queryForm').setAttribute('aria-busy',String(loading));
        byId('queryButton').disabled=loading;
        byId('queryButton').textContent=loading && minutes===null?'正在查询':'查询定位';
        for(const value of [5,30]) {
            const el=byId('recent'+value+'Button'),busy=loading && minutes===value;
            el.disabled=busy;el.textContent=busy?'正在查询…':'最近'+value+'分钟';
        }
    }
    function cancelQuery() {
        querySequence++;if(controller)controller.abort();controller=null;
        stopRefresh();
        queryLoading(false);
    }
    function stopRefresh() {
        if(refreshTimer)clearTimeout(refreshTimer);if(refreshExpiry)clearTimeout(refreshExpiry);
        refreshTimer=0;refreshExpiry=0;
        if(refreshController)refreshController.abort();refreshController=null;
    }
    function recordKey(record) {return JSON.stringify([record.content??'',record.time??'']);}
    function mergeRefreshMatches(previous,incoming) {
        const records=new Map(previous.map(record=>[recordKey(record),record]));
        for(const record of incoming) {
            const key=recordKey(record),old=records.get(key);
            if(!old){records.set(key,record);continue;}
            const merged={...old,...record,wheel_numbers:{...old.wheel_numbers,...record.wheel_numbers}};
            const sources=new Map();
            for(const station of stations) {
                const value=T.wheelNumber(record,station.id),known=T.wheelNumber(old,station.id);
                const source=value===null && known!==null?old:record;
                sources.set(station.id,source);
                if(value!==null || known!==null)merged.wheel_numbers[String(station.id)]=value??known;
            }
            // Retained numbers keep their own inference/normalization provenance.
            for(const field of ['inferred_wheels','normalized_wheels']) {
                merged[field]=stations.filter(station=>Array.isArray(sources.get(station.id)[field]) && sources.get(station.id)[field].includes(station.id)).map(station=>station.id);
            }
            merged.original_wheel_numbers={};
            for(const id of merged.normalized_wheels) {
                const original=sources.get(id)?.original_wheel_numbers?.[String(id)];
                if(original!==undefined)merged.original_wheel_numbers[String(id)]=original;
            }
            if(sources.get(3)===old) {
                for(const field of ['box_number_source','verification_value','verification_issue']) {
                    if(Object.prototype.hasOwnProperty.call(old,field))merged[field]=old[field];else delete merged[field];
                }
            }
            merged.box_num=T.wheelNumber(merged,3);merged.numbers=[merged.box_num];
            records.set(key,merged);
        }
        const matches=[...records.values()].sort((a,b)=>String(b.time||'').localeCompare(String(a.time||'')));
        return {matches:matches.slice(0,50),total:matches.length};
    }
    function startRefresh(entry) {
        if(entry.lookbackMinutes || entry.refreshPending!==true)return;
        const sequence=querySequence,deadline=Date.now()+REFRESH_WAIT_MS;
        const current=()=>!syncTodayScope() && sequence===querySequence && activeEntry===entry;
        const pendingStatus=()=>{
            const record=selectedRecord||entry.matches[0];
            const transportOnly=record && T.WHEELS.every(wheel=>T.wheelNumber(record,wheel.id)!==null) && T.wheelNumber(record,0)===null;
            const waiting=transportOnly?'轮位已更新，输送盒模待确认':entry.matches.length?'部分编号尚待确认':'尚未收到对应记录';
            status(inspectionCompletion(entry)+(entry.warning?entry.warning+' ':'')+waiting+'，正在自动刷新，最多等待'+REFRESH_WAIT_MINUTES+'分钟；可继续扫描其他二维码。','warning');
        };
        function schedule(delay) {
            if(!current() || entry.refreshPending!==true || Date.now()>=deadline)return;
            refreshTimer=setTimeout(refresh,Math.max(500,Math.min(10000,Number(delay)||3000)));
        }
        async function refresh() {
            refreshTimer=0;
            if(!current() || Date.now()>=deadline)return;
            const requestController=new AbortController();refreshController=requestController;
            try {
                const pendingList=[...new Set(entry.matches.filter(record=>{
                    const verification=T.number(record.verification_value);
                    return verification===null || verification<1 || verification>8
                        || stations.some(station=>T.wheelNumber(record,station.id)===null);
                }).map(record=>record.time).filter(time=>typeof time==='string' && time.trim()))].slice(0,50);
                const pendingCursor=(entry.pendingCursor||0)%Math.max(1,pendingList.length);
                const pendingTimes=pendingList.slice(pendingCursor,pendingCursor+3);
                entry.pendingCursor=pendingCursor+pendingTimes.length>=pendingList.length?0:pendingCursor+pendingTimes.length;
                const response=await fetch('/api/urldata/box_query',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({qrcode:entry.qrcode,lookback_hours:entry.lookbackHours,refresh:true,pending_times:pendingTimes}),signal:requestController.signal});
                const data=await response.json();
                if(!current() || Date.now()>=deadline)return;
                if(!response.ok || !data.success)throw new Error(data.error||'查询失败');
                if(!Array.isArray(data.matches) || data.matches.some(record=>!record || typeof record!=='object'))throw new Error('查询返回的数据格式不完整');
                const previous=selectedRecord;
                const merged=mergeRefreshMatches(entry.matches,data.matches);
                const totalRecords=Math.max(merged.total,data.total_records||0,entry.hasMore?entry.totalRecords||0:0);
                const hasMore=entry.hasMore || data.has_more===true || merged.total>merged.matches.length;
                Object.assign(entry,{matches:merged.matches,wheels:data.wheels||entry.wheels,source:data.source,lookbackHours:data.lookback_hours??entry.lookbackHours,recentWindowMinutes:data.recent_window_minutes,queryScope:data.query_scope,queryStart:data.query_start,queryStop:data.query_stop,scopeLabel:data.scope_label,totalRecords,hasMore,warning:data.warning,refreshPending:data.refresh_pending===true,retryAfterMs:data.retry_after_ms});
                layoutVersion++;setLayout(entry.wheels);
                const record=entry.matches.find(item=>previous && recordKey(item)===recordKey(previous))||previous||entry.matches[0];
                if(record)applySelection(record);else {clearSelection();renderMatches();}
                registerScan(entry);
                renderHistory();
                if(entry.refreshPending) {pendingStatus();schedule(entry.retryAfterMs);}
                else {
                    stopRefresh();
                    status(inspectionCompletion(entry)+(entry.warning||(entry.matches.length?'记录已自动更新，可继续扫描或切换记录。':'本次自动更新未找到匹配记录，可重新查询。')),entry.warning||!entry.matches.length?'warning':'info');
                }
            } catch(error) {
                if(!current() || Date.now()>=deadline || error.name==='AbortError')return;
                status(inspectionCompletion(entry)+'自动更新暂未成功，正在重试；已有记录仍可查看。','warning');schedule(entry.retryAfterMs);
            } finally {
                if(refreshController===requestController)refreshController=null;
            }
        }
        refreshExpiry=setTimeout(()=>{
            if(!current())return;
            stopRefresh();status(inspectionCompletion(entry)+'已等待'+REFRESH_WAIT_MINUTES+'分钟，自动更新已暂停；可重新查询获取最新记录。','warning');
        },REFRESH_WAIT_MS);
        pendingStatus();schedule(entry.retryAfterMs);
    }
    function setLayout(configs) {view.setLayout(configs);transport.setLayout(configs);}
    function selectRecord(record) {
        cancelQuery();applySelection(record);status('已切换记录，可继续扫描其他二维码。');
    }
    function applySelection(record) {
        selectedRecord=record;
        byId('selectedCode').textContent=String(record.content||activeEntry.qrcode||'');
        byId('selectedTime').textContent='记录时间：'+timeText(record.time);
        view.select(record);
        transport.select(record);
        renderDataSource();
        renderMatches();
    }
    function clearSelection() {
        selectedRecord=null;view.clear();transport.clear();
        byId('selectedCode').textContent='尚未选择';byId('selectedTime').textContent='';
        renderDataSource();
    }
    function renderDataSource() {
        const entry=activeEntry;
        if(!entry){byId('dataSource').textContent='今天 · 编号范围读取现有配置';return;}
        if(entry.source==='influxdb' || entry.source==='mixed') {
            const inferred=Array.isArray(selectedRecord?.inferred_wheels)?selectedRecord.inferred_wheels.filter(id=>id!==0).length:0;
            const adjacent=selectedRecord?.box_number_source==='adjacent_verification';
            const unknown=selectedRecord && T.wheelNumber(selectedRecord,3)===null;
            const sourceRange=entry.source==='mixed'?'本地'+todayRange(entry)+' · 远程'+todayRange(entry,true):'远程'+todayRange(entry,true);
            byId('dataSource').textContent=sourceRange+(unknown?' · 校验不足，编号待确认':adjacent?' · 相邻校验推算 · '+inferred+'轮已推算':inferred?' · 三号轮校验 · '+inferred+'轮按校验推算':entry.source==='mixed'?' · 编号读取采集与校验数据':' · 仅三号轮可确认编号');
        } else {
            const normalized=Array.isArray(selectedRecord?.normalized_wheels)?selectedRecord.normalized_wheels.length:0;
            byId('dataSource').textContent='本地'+todayRange(entry)+(normalized?' · '+normalized+'工位按配置换算 · 原编号见表格提示':' · 编号范围读取现有配置');
        }
    }
    function renderMatches() {
        const body=byId('matchBody');body.replaceChildren();
        const matches=activeEntry?activeEntry.matches:[];
        const prefix=activeEntry?todayRange(activeEntry)+' · ':'';
        const count=activeEntry?.hasMore?'共 '+activeEntry.totalRecords+' 条 · 显示最新 '+matches.length+' 条':matches.length+' 条';
        byId('matchCount').textContent=prefix+count+' · 时间倒序';
        if(!matches.length) {
            const row=element('tr','',null,body);
            element('td','table-empty',activeEntry?'本次查询没有匹配记录，请调整二维码或查询范围。':'查询二维码或选择快捷时段后，在这里对照输送盒模与各轮编号。',row).colSpan=stations.length+3;
            return;
        }
        matches.forEach(record=>{
            const row=element('tr',record===selectedRecord?'is-selected':'',null,body);
            element('td','time-cell',timeText(record.time),row);
            const codeCell=element('td','',null,row);
            const codeButton=button('record-code',record.content||activeEntry.qrcode,codeCell,()=>selectRecord(record));
            codeButton.title=String(record.content||'');codeButton.setAttribute('aria-label','定位此记录：'+String(record.content||''));
            for(const wheel of stations) {
                const value=T.wheelNumber(record,wheel.id);
                const cell=element('td','number-cell'+(wheel.id===3?' inspection-column':''),value??'—',row);
                cell.dataset.wheel=wheel.id;
                const inferred=Array.isArray(record.inferred_wheels) && record.inferred_wheels.includes(wheel.id);
                const normalized=Array.isArray(record.normalized_wheels) && record.normalized_wheels.includes(wheel.id);
                const adjacent=record.box_number_source==='adjacent_verification';
                cell.title=wheel.name+'：'+(value===null?'暂无编号':value)+(normalized?'（原编号 '+record.original_wheel_numbers?.[String(wheel.id)]+'，按配置循环范围换算）':inferred?(wheel.id===0?'（依据已知输送编号及连续记录推算）':adjacent?'（校验原值 '+(record.verification_value??'空')+'；前后校验一致，按循环推算）':'（按三号轮校验推算）'):'');
                cell.setAttribute('aria-label',cell.title);
            }
            button('select-record',record===selectedRecord?'已选中':'查看轨迹',element('td','',null,row),()=>selectRecord(record));
        });
    }
    function chooseEntry(entry) {
        if(syncTodayScope())return;
        cancelQuery();activeEntry=entry;setLayout(entry.wheels);
        const recentLabel=todayRange(entry);
        if(entry.matches.length) {
            selectRecord(entry.matches[0]);
            status((recentLabel?recentLabel+'内':'')+(entry.hasMore?'共 '+entry.totalRecords+' 条记录，显示最新 '+entry.matches.length+' 条':'找到 '+entry.matches.length+' 条匹配记录')+'，已选择最新记录；可点击其他记录切换。');
            const box=T.wheelNumber(entry.matches[0],3);
            if(box===null || box<1 || box>8)status('已找到二维码记录，但最新记录缺少有效的三号轮模盒编号。'+(entry.warning||'请检查校验数据。')+(entry.hasMore?'共 '+entry.totalRecords+' 条，仅显示最新 '+entry.matches.length+' 条。':''),'warning');
            else if(entry.warning)status(entry.warning,'warning');
        } else {
            clearSelection();renderMatches();
            status('本地及远程'+recentLabel+'内未找到匹配记录，可稍后重试或查询今天其他时段。','warning');
        }
        renderHistory();
    }
    function renderHistory() {
        const list=byId('historyList');list.replaceChildren();
        byId('historyCount').textContent=history.length+' 条';
        if(!history.length){element('div','empty-state','暂无查询记录',list);return;}
        let previousGroup=null;
        for(const entry of history) {
            const group='round-'+entry.round;
            if(group!==previousGroup) {
                element('h3','history-group','第 '+entry.round+' 轮 · '+(entry.round<=roundCount?'已完成':'进行中'),list);previousGroup=group;
            }
            const el=button('history-choice','',list,()=>chooseEntry(entry));
            el.setAttribute('aria-pressed',String(entry===activeEntry));el.title=entry.qrcode;
            element('span','history-code',entry.qrcode,el);
            const meta=element('span','history-meta',null,el);
            const box=entry.matches.length?T.wheelNumber(entry.matches[0],3):null;
            element('span','',box===null?'三号轮：—':'三号轮：'+box,meta);
            element('span','',entry.queriedAt.split(' ').slice(-1)[0],meta);
        }
    }
    function renderInspection() {
        const slots=byId('inspectionSlots');slots.replaceChildren();
        hitCounts.forEach((count,index)=>{
            const el=element('span','inspection-slot'+(count?' is-hit':''),index+1,slots);
            el.title='模盒 '+(index+1)+'，扫码 '+count+' 次';el.setAttribute('aria-label',el.title);
            if(count>1)element('small','',count,el);
        });
        byId('inspectionProgress').textContent=hitCounts.filter(Boolean).length+' / 8';
        byId('inspectionMeter').value=hitCounts.filter(Boolean).length;
        byId('roundStatus').textContent='第 '+(roundCount+1)+' 轮检验'+(roundCount?' · 已完成 '+roundCount+' 轮':'');
    }
    function inspectionCompletion(entry) {return entry.completedRound?'已完成第 '+entry.completedRound+' 轮八盒检验。':'';}
    function registerScan(entry) {
        if(entry!==activeEntry || entry.lookbackMinutes || entry.scanRegistered)return false;
        const record=entry.matches[0],value=T.wheelNumber(record,3);
        if(!record || value===null || value<1 || value>8 || ['adjacent_verification','unavailable'].includes(record.box_number_source)
            || (Array.isArray(record.inferred_wheels) && record.inferred_wheels.includes(3)))return false;
        entry.scanRegistered=true;entry.round=roundCount+1;hitCounts[value-1]++;
        let completed=false;
        if(hitCounts.every(Boolean)){roundCount++;entry.completedRound=roundCount;hitCounts=Array(8).fill(0);completed=true;}
        renderInspection();return completed;
    }
    async function doQuery(event,recentMinutes=null) {
        if(event)event.preventDefault();
        syncTodayScope();
        const recent=recentMinutes!==null;
        const qrcode=byId('qrcodeInput').value.trim();
        if(!recent && !qrcode){status('请输入二维码内容。','warning');byId('qrcodeInput').focus();return;}
        const lookbackHours=Number(byId('lookbackHours').value);
        cancelQuery();const sequence=querySequence;controller=new AbortController();
        queryLoading(true,recentMinutes);status(recent?'正在查询今天内最近'+recentMinutes+'分钟的记录…':'正在查询今天二维码对应的模盒轨迹…');
        try {
            const payload=recent?{lookback_minutes:recentMinutes}:{qrcode,lookback_hours:lookbackHours};
            const response=await fetch(recent?'/api/urldata/box_recent':'/api/urldata/box_query',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:controller.signal});
            const data=await response.json();
            if(syncTodayScope() || sequence!==querySequence)return;
            if(!response.ok || !data.success)throw new Error(data.error||'查询失败（HTTP '+response.status+'）');
            if(!Array.isArray(data.matches) || data.matches.some(m=>!m || typeof m!=='object'))throw new Error('查询返回的数据格式不完整');
            layoutVersion++;
            // Backend returns newest first, including the real-time fallback.
            const entry={id:++historyId,qrcode:recent?'今天内最近'+recentMinutes+'分钟':qrcode,matches:data.matches,wheels:data.wheels||[],source:data.source,lookbackHours:data.lookback_hours??lookbackHours,lookbackMinutes:recentMinutes,recentWindowMinutes:data.recent_window_minutes,queryScope:data.query_scope,queryStart:data.query_start,queryStop:data.query_stop,scopeLabel:data.scope_label,totalRecords:data.total_records,hasMore:data.has_more===true,warning:data.warning,refreshPending:data.refresh_pending===true,retryAfterMs:data.retry_after_ms,queriedAt:clockText(),round:roundCount+1};
            let completed=false;
            if(!recent) {
                history.unshift(entry);history=history.slice(0,200);
            }
            chooseEntry(entry);
            if(!recent)completed=registerScan(entry);
            if(completed){renderHistory();status(inspectionCompletion(entry)+'当前二维码已定位，继续扫码开始下一轮。');}
            if(!recent) {
                if(entry.matches[0]?.box_number_source==='adjacent_verification')status(byId('queryStatus').textContent+' 按相邻校验推算，未计入八盒检验。','warning');
                if(byId('qrcodeInput').value.trim()===qrcode)byId('qrcodeInput').value='';
                byId('qrcodeInput').focus();
                startRefresh(entry);
            }
        } catch(error) {
            if(sequence!==querySequence || error.name==='AbortError')return;
            activeEntry=null;clearSelection();renderMatches();renderHistory();status('查询失败：'+error.message,'error');
        } finally {
            if(sequence===querySequence){controller=null;queryLoading(false);}
        }
    }
    async function loadLayout() {
        const version=layoutVersion;
        try {
            const response=await fetch('/api/urldata/box_layout');
            if(!response.ok)throw new Error('HTTP '+response.status);
            const data=await response.json();
            if(version!==layoutVersion || activeEntry)return;
            if(!Array.isArray(data.wheels))throw new Error('编号配置格式不完整');
            setLayout(data.wheels);
        } catch(error) {
            if(version===layoutVersion && !activeEntry)status('编号配置暂未加载；查询时将重新读取。','warning');
        }
    }
    byId('queryForm').addEventListener('submit',doQuery);
    for(const minutes of [5,30])byId('recent'+minutes+'Button').addEventListener('click',event=>doQuery(event,minutes));
    byId('clearInputButton').addEventListener('click',()=>{cancelQuery();byId('qrcodeInput').value='';byId('qrcodeInput').focus();status('输入已清空，可扫描其他二维码。');});
    byId('resetButton').addEventListener('click',()=>{cancelQuery();activeEntry=null;clearSelection();renderMatches();renderHistory();status('高亮已重置，可点击查询记录重新定位。');});
    byId('clearHistoryButton').addEventListener('click',()=>{
        cancelQuery();history=[];activeEntry=null;roundCount=0;hitCounts=Array(8).fill(0);
        clearSelection();renderHistory();renderMatches();renderInspection();status('查询记录与检验进度已清空。');
    });
    window.addEventListener('pagehide',cancelQuery);
    window.addEventListener('focus',syncTodayScope);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)syncTodayScope();});
    setInterval(syncTodayScope,1000);
    renderHistory();renderInspection();loadLayout();
})();
