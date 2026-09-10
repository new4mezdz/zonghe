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
    function cancelQuery() {
        querySequence++;if(controller)controller.abort();controller=null;
        byId('queryButton').disabled=false;byId('queryButton').textContent='查询定位';
    }
    function setLayout(configs) {view.setLayout(configs);}
    function selectRecord(record) {
        cancelQuery();selectedRecord=record;
        byId('selectedCode').textContent=String(record.content||activeEntry.qrcode||'');
        byId('selectedTime').textContent='记录时间：'+timeText(record.time);
        view.select(record);
        renderMatches();
    }
    function clearSelection() {
        selectedRecord=null;view.clear();
        byId('selectedCode').textContent='尚未选择';byId('selectedTime').textContent='';
    }
    function renderMatches() {
        const panel=byId('matchPanel'),body=byId('matchBody');body.replaceChildren();
        const matches=activeEntry?activeEntry.matches:[];panel.hidden=!matches.length;
        byId('matchCount').textContent=matches.length+' 条 · 时间倒序';
        matches.forEach(record=>{
            const row=element('tr',record===selectedRecord?'is-selected':'',null,body);
            element('td','time-cell',timeText(record.time),row);
            const codeCell=element('td','',null,row);
            const codeButton=button('record-code',record.content||activeEntry.qrcode,codeCell,()=>selectRecord(record));
            codeButton.title=String(record.content||'');codeButton.setAttribute('aria-label','定位此记录：'+String(record.content||''));
            element('td','number-cell',T.wheelNumber(record,3)??'—',row);
            button('select-record',record===selectedRecord?'已选中':'查看轨迹',element('td','',null,row),()=>selectRecord(record));
        });
    }
    function chooseEntry(entry) {
        cancelQuery();activeEntry=entry;setLayout(entry.wheels);
        byId('dataSource').textContent=entry.source==='influxdb'?'实时回退查询 · 仅三号轮可确认编号':'本地轨迹数据 · 编号范围读取现有配置';
        if(entry.matches.length) {
            selectRecord(entry.matches[0]);
            status('找到 '+entry.matches.length+' 条匹配记录，已选择最新记录；可点击其他记录切换。');
        } else {
            clearSelection();renderMatches();status('未找到匹配的二维码，请确认输入内容。','warning');
        }
        renderHistory();
    }
    function renderHistory() {
        const list=byId('historyList');list.replaceChildren();
        if(!history.length){element('div','empty-state','暂无查询记录',list);return;}
        let previousRound=null;
        for(const entry of history) {
            if(entry.round!==previousRound) {
                element('h3','history-group','第 '+entry.round+' 轮 · '+(entry.round<=roundCount?'已完成':'进行中'),list);previousRound=entry.round;
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
        byId('roundStatus').textContent='第 '+(roundCount+1)+' 轮检验'+(roundCount?' · 已完成 '+roundCount+' 轮':'');
    }
    function registerScan(entry) {
        const value=entry.matches.length?T.wheelNumber(entry.matches[0],3):null;
        if(value!==null && value>=1 && value<=8)hitCounts[value-1]++;
        let completed=false;
        if(hitCounts.every(Boolean)){roundCount++;hitCounts=Array(8).fill(0);completed=true;}
        renderInspection();return completed;
    }
    async function doQuery(event) {
        if(event)event.preventDefault();
        const qrcode=byId('qrcodeInput').value.trim();
        if(!qrcode){status('请输入二维码内容。','warning');byId('qrcodeInput').focus();return;}
        cancelQuery();const sequence=querySequence;controller=new AbortController();
        byId('queryButton').disabled=true;byId('queryButton').textContent='正在查询';status('正在查询二维码对应的模盒轨迹…');
        try {
            const response=await fetch('/api/urldata/box_query',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({qrcode}),signal:controller.signal});
            const data=await response.json();
            if(sequence!==querySequence)return;
            if(!response.ok || !data.success)throw new Error(data.error||'查询失败（HTTP '+response.status+'）');
            if(!Array.isArray(data.matches) || data.matches.some(m=>!m || typeof m!=='object'))throw new Error('查询返回的数据格式不完整');
            layoutVersion++;
            // Backend returns newest first, including the real-time fallback.
            const entry={id:++historyId,qrcode,matches:data.matches,wheels:data.wheels||[],source:data.source,queriedAt:clockText(),round:roundCount+1};
            history.unshift(entry);history=history.slice(0,200);
            const completed=registerScan(entry);chooseEntry(entry);
            if(completed)status('已完成第 '+roundCount+' 轮八盒检验。当前二维码已定位，继续扫码开始下一轮。');
            if(byId('qrcodeInput').value.trim()===qrcode)byId('qrcodeInput').value='';
            byId('qrcodeInput').focus();
        } catch(error) {
            if(sequence!==querySequence || error.name==='AbortError')return;
            activeEntry=null;clearSelection();renderMatches();renderHistory();status('查询失败：'+error.message,'error');
        } finally {
            if(sequence===querySequence){controller=null;byId('queryButton').disabled=false;byId('queryButton').textContent='查询定位';}
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
    byId('clearInputButton').addEventListener('click',()=>{byId('qrcodeInput').value='';byId('qrcodeInput').focus();});
    byId('resetButton').addEventListener('click',()=>{cancelQuery();activeEntry=null;clearSelection();renderMatches();renderHistory();status('高亮已重置，可点击查询记录重新定位。');});
    byId('clearHistoryButton').addEventListener('click',()=>{
        cancelQuery();history=[];activeEntry=null;roundCount=0;hitCounts=Array(8).fill(0);
        clearSelection();renderHistory();renderMatches();renderInspection();status('查询记录与检验进度已清空。');
    });
    renderHistory();renderInspection();loadLayout();
})();
