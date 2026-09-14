(() => {
    'use strict';
    const T=window.BoxTrajectory, byId=id=>document.getElementById(id);
    const view=window.BoxTrajectoryView.create({diagram:byId('wheelDiagram'),status:byId('locationStatus')});
    let querySequence=0, controller=null, activeEntry=null, selectedRecord=null;
    let history=[], historyId=0, roundCount=0, hitCounts=Array(8).fill(0), layoutVersion=0;
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
        queryLoading(false);
    }
    function setLayout(configs) {view.setLayout(configs);}
    function selectRecord(record) {
        cancelQuery();selectedRecord=record;
        byId('selectedCode').textContent=String(record.content||activeEntry.qrcode||'');
        byId('selectedTime').textContent='记录时间：'+timeText(record.time);
        view.select(record);
        renderDataSource();
        renderMatches();
    }
    function clearSelection() {
        selectedRecord=null;view.clear();
        byId('selectedCode').textContent='尚未选择';byId('selectedTime').textContent='';
        renderDataSource();
    }
    function renderDataSource() {
        const entry=activeEntry;
        if(!entry){byId('dataSource').textContent='编号范围读取现有配置';return;}
        const recentLabel=entry.lookbackMinutes?'最近'+entry.lookbackMinutes+'分钟':'';
        if(entry.source==='influxdb') {
            const inferred=Array.isArray(selectedRecord?.inferred_wheels)?selectedRecord.inferred_wheels.length:0;
            const adjacent=selectedRecord?.box_number_source==='adjacent_verification';
            const unknown=selectedRecord && T.wheelNumber(selectedRecord,3)===null;
            byId('dataSource').textContent='远程'+(recentLabel||'最近'+entry.lookbackHours+'小时')+(unknown?' · 校验不足，编号待确认':adjacent?' · 相邻校验推算 · '+inferred+'轮已推算':inferred?' · 三号轮校验 · '+inferred+'轮按校验推算':' · 仅三号轮可确认编号');
        } else {
            const normalized=Array.isArray(selectedRecord?.normalized_wheels)?selectedRecord.normalized_wheels.length:0;
            byId('dataSource').textContent='本地'+(recentLabel||'轨迹数据')+(normalized?' · '+normalized+'轮按配置换算 · 原编号见表格提示':' · 编号范围读取现有配置');
        }
    }
    function renderMatches() {
        const body=byId('matchBody');body.replaceChildren();
        const matches=activeEntry?activeEntry.matches:[];
        const prefix=activeEntry?.lookbackMinutes?'最近'+activeEntry.lookbackMinutes+'分钟 · ':'';
        const count=activeEntry?.hasMore?'共 '+activeEntry.totalRecords+' 条 · 显示最新 '+matches.length+' 条':matches.length+' 条';
        byId('matchCount').textContent=prefix+count+' · 时间倒序';
        if(!matches.length) {
            const row=element('tr','',null,body);
            element('td','table-empty',activeEntry?'本次查询没有匹配记录，请调整二维码或查询范围。':'查询二维码或选择快捷时段后，在这里对照各轮模盒编号。',row).colSpan=T.WHEELS.length+3;
            return;
        }
        matches.forEach(record=>{
            const row=element('tr',record===selectedRecord?'is-selected':'',null,body);
            element('td','time-cell',timeText(record.time),row);
            const codeCell=element('td','',null,row);
            const codeButton=button('record-code',record.content||activeEntry.qrcode,codeCell,()=>selectRecord(record));
            codeButton.title=String(record.content||'');codeButton.setAttribute('aria-label','定位此记录：'+String(record.content||''));
            for(const wheel of T.WHEELS) {
                const value=T.wheelNumber(record,wheel.id);
                const cell=element('td','number-cell'+(wheel.id===3?' inspection-column':''),value??'—',row);
                cell.dataset.wheel=wheel.id;
                const inferred=Array.isArray(record.inferred_wheels) && record.inferred_wheels.includes(wheel.id);
                const normalized=Array.isArray(record.normalized_wheels) && record.normalized_wheels.includes(wheel.id);
                const adjacent=record.box_number_source==='adjacent_verification';
                cell.title=wheel.name+'：'+(value===null?'暂无编号':value)+(normalized?'（原编号 '+record.original_wheel_numbers?.[String(wheel.id)]+'，按配置循环范围换算）':inferred?(adjacent?'（校验原值 '+(record.verification_value??'空')+'；前后校验一致，按循环推算）':'（按三号轮校验推算）'):'');
                cell.setAttribute('aria-label',cell.title);
            }
            button('select-record',record===selectedRecord?'已选中':'查看轨迹',element('td','',null,row),()=>selectRecord(record));
        });
    }
    function chooseEntry(entry) {
        cancelQuery();activeEntry=entry;setLayout(entry.wheels);
        const recentLabel=entry.lookbackMinutes?'最近'+entry.lookbackMinutes+'分钟':'';
        if(entry.matches.length) {
            selectRecord(entry.matches[0]);
            status((recentLabel?recentLabel+'内':'')+(entry.hasMore?'共 '+entry.totalRecords+' 条记录，显示最新 '+entry.matches.length+' 条':'找到 '+entry.matches.length+' 条匹配记录')+'，已选择最新记录；可点击其他记录切换。');
            const box=T.wheelNumber(entry.matches[0],3);
            if(box===null || box<1 || box>8)status('已找到二维码记录，但最新记录缺少有效的三号轮模盒编号。'+(entry.warning||'请检查校验数据。')+(entry.hasMore?'共 '+entry.totalRecords+' 条，仅显示最新 '+entry.matches.length+' 条。':''),'warning');
            else if(entry.warning)status(entry.warning,'warning');
        } else {
            clearSelection();renderMatches();
            status(recentLabel?'本地及远程'+recentLabel+'内未找到记录，可稍后重试或扩大时段。':entry.source==='influxdb'?'本地历史记录及远程最近'+entry.lookbackHours+'小时内未找到匹配的二维码，请确认输入或扩大远程查询范围。':'未找到匹配的二维码，请确认输入内容。','warning');
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
    function registerScan(entry) {
        if(entry.matches[0]?.box_number_source==='adjacent_verification')return false;
        const value=entry.matches.length?T.wheelNumber(entry.matches[0],3):null;
        if(value!==null && value>=1 && value<=8)hitCounts[value-1]++;
        let completed=false;
        if(hitCounts.every(Boolean)){roundCount++;hitCounts=Array(8).fill(0);completed=true;}
        renderInspection();return completed;
    }
    async function doQuery(event,recentMinutes=null) {
        if(event)event.preventDefault();
        const recent=recentMinutes!==null;
        const qrcode=byId('qrcodeInput').value.trim();
        if(!recent && !qrcode){status('请输入二维码内容。','warning');byId('qrcodeInput').focus();return;}
        const lookbackHours=Number(byId('lookbackHours').value);
        cancelQuery();const sequence=querySequence;controller=new AbortController();
        queryLoading(true,recentMinutes);status(recent?'正在查询最近'+recentMinutes+'分钟的记录…':'正在查询二维码对应的模盒轨迹…');
        try {
            const payload=recent?{lookback_minutes:recentMinutes}:{qrcode,lookback_hours:lookbackHours};
            const response=await fetch(recent?'/api/urldata/box_recent':'/api/urldata/box_query',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:controller.signal});
            const data=await response.json();
            if(sequence!==querySequence)return;
            if(!response.ok || !data.success)throw new Error(data.error||'查询失败（HTTP '+response.status+'）');
            if(!Array.isArray(data.matches) || data.matches.some(m=>!m || typeof m!=='object'))throw new Error('查询返回的数据格式不完整');
            layoutVersion++;
            // Backend returns newest first, including the real-time fallback.
            const entry={id:++historyId,qrcode:recent?'最近'+recentMinutes+'分钟':qrcode,matches:data.matches,wheels:data.wheels||[],source:data.source,lookbackHours:data.lookback_hours??lookbackHours,lookbackMinutes:recentMinutes,totalRecords:data.total_records,hasMore:data.has_more===true,warning:data.warning,queriedAt:clockText(),round:roundCount+1};
            let completed=false;
            if(!recent) {
                history.unshift(entry);history=history.slice(0,200);
                completed=registerScan(entry);
            }
            chooseEntry(entry);
            if(completed)status('已完成第 '+roundCount+' 轮八盒检验。当前二维码已定位，继续扫码开始下一轮。');
            if(!recent) {
                if(entry.matches[0]?.box_number_source==='adjacent_verification')status(byId('queryStatus').textContent+' 按相邻校验推算，未计入八盒检验。','warning');
                if(byId('qrcodeInput').value.trim()===qrcode)byId('qrcodeInput').value='';
                byId('qrcodeInput').focus();
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
    byId('clearInputButton').addEventListener('click',()=>{byId('qrcodeInput').value='';byId('qrcodeInput').focus();});
    byId('resetButton').addEventListener('click',()=>{cancelQuery();activeEntry=null;clearSelection();renderMatches();renderHistory();status('高亮已重置，可点击查询记录重新定位。');});
    byId('clearHistoryButton').addEventListener('click',()=>{
        cancelQuery();history=[];activeEntry=null;roundCount=0;hitCounts=Array(8).fill(0);
        clearSelection();renderHistory();renderMatches();renderInspection();status('查询记录与检验进度已清空。');
    });
    renderHistory();renderInspection();loadLayout();
})();
