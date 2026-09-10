(() => {
    'use strict';
    const byId=id=>document.getElementById(id), T=window.BoxTrajectory;
    const view=window.BoxTrajectoryView.create({
        diagram:byId('recordWheelDiagram'),status:byId('recordLocationStatus'),emptyText:'请选择下方记录'
    });
    let records=[],selected=null,layoutSequence=0;
    const key=record=>JSON.stringify([record.date,record.content,record.numbers,record.verification,record.type,record.corrected]);
    function select(index) {
        if(!Number.isInteger(index) || index<0 || index>=records.length)return;
        selected=records[index];
        // numbers[0] is the transport mold; the remaining indexes match the wheel IDs.
        const numbers=Array.isArray(selected.numbers)?selected.numbers:[];
        const wheel_numbers=Object.fromEntries(T.WHEELS.map(w=>[w.id,T.number(numbers[w.id])]));
        view.select({wheel_numbers});
        byId('recordSelectedCode').textContent=String(selected.content??'');
        byId('recordSelectedTime').textContent='记录时间：'+String(selected.date||'未知');
        byId('recordSelectedIndex').textContent='第 '+(index+1)+' / '+records.length+' 条';
        byId('resultsBody').querySelectorAll('tr[data-idx]').forEach(row=>{
            const active=Number(row.dataset.idx)===index;
            row.classList.toggle('is-trajectory-selected',active);
            row.querySelector('.record-select').setAttribute('aria-pressed',String(active));
        });
    }
    function clearSelection() {
        selected=null;view.clear();
        byId('recordSelectedCode').textContent='尚未选择';
        byId('recordSelectedTime').textContent='点击表格中的任意记录，查看对应轨迹';
        byId('recordSelectedIndex').textContent='';
        byId('resultsBody').querySelectorAll('.is-trajectory-selected').forEach(row=>{
            row.classList.remove('is-trajectory-selected');
            row.querySelector('.record-select').setAttribute('aria-pressed','false');
        });
    }
    async function refreshLayout() {
        const sequence=++layoutSequence;
        try {
            const response=await fetch('/api/urldata/box_layout');
            if(!response.ok)throw new Error('HTTP '+response.status);
            const data=await response.json();
            if(sequence!==layoutSequence)return;
            if(!Array.isArray(data.wheels))throw new Error('编号配置不完整');
            view.setLayout(data.wheels);
            byId('recordLayoutStatus').textContent='一至八号轮（不含七号轮）';
        } catch(error) {
            if(sequence===layoutSequence)byId('recordLayoutStatus').textContent='轮位配置加载失败，重新查询可重试';
        }
    }
    function setRecords(nextRecords) {
        const selectedKey=selected?key(selected):null;
        records=Array.isArray(nextRecords)?nextRecords:[];
        if(!records.length){clearSelection();return;}
        const previous=selectedKey===null?-1:records.findIndex(record=>key(record)===selectedKey);
        select(previous<0?0:previous);
        refreshLayout();
    }
    byId('resultsBody').addEventListener('click',event=>{
        if(event.target.closest('.copy-btn'))return;
        const row=event.target.closest('tr[data-idx]');
        if(row)select(Number(row.dataset.idx));
    });
    byId('resetRecordTrajectory').addEventListener('click',clearSelection);
    window.RecordTrajectory={setRecords,select,refreshLayout};
    clearSelection();refreshLayout();
})();
