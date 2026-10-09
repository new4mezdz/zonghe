package com.warehouse.pda;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.*;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

public final class MainActivity extends Activity {
    private static final int INK=Color.rgb(24,41,65),BLUE=Color.rgb(37,99,235),MUTED=Color.rgb(104,121,146),BG=Color.rgb(242,245,250),ORANGE=Color.rgb(180,83,9),GREEN=Color.rgb(21,128,61),PAGE_SIZE=100;
    private SyncEngine engine;
    private final Handler handler=new Handler(Looper.getMainLooper());
    private EditText barcode;
    private TextView network,endpoint,batchSummary,batchHint,pageLabel,recovery,empty,homeSummary;
    private Button upload,previous,next;
    private ScanAdapter adapter;
    private QueueStore.Batch batch;
    private String operation="inbound",inspectedBatchId=null,listSignature="",lastCompletion="";
    private int page=0,dialogDepth=0;
    private boolean scanPage=false,receiverRegistered=false,changingText=false,foreground=false;
    private final Runnable tick=new Runnable(){public void run(){if(!foreground)return;refresh();if(dialogDepth==0)engine.sync(false);handler.postDelayed(this,1500);}};
    private final BroadcastReceiver receiver=new BroadcastReceiver(){
        @Override public void onReceive(Context context,Intent intent){
            if(!foreground||!scanPage||dialogDepth>0||!"broadcast".equals(engine.prefs.getString("input","broadcast")))return;
            if(!acceptingScans()){toast(engine.prefs.getBoolean(reviewKey(),false)?"请先处理上方保留的扫码内容":"本批已提交，全部上传成功后可继续扫码");return;}
            try{
                Object value=intent.getExtras()==null?null:intent.getExtras().get(engine.prefs.getString("extra",""));String code;
                if(value instanceof String)code=(String)value;
                else if(value instanceof byte[])code=StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).decode(ByteBuffer.wrap((byte[])value)).toString();
                else throw new IllegalArgumentException("广播字段没有文本或 UTF-8 字节数据，请检查字段名");
                if(!buffer().isEmpty()){toast("有未处理扫码内容，请点上方提示处理后重新扫码");return;}
                String clean=code.replaceFirst("[\\r\\n]+$","");if(!saveScan(clean))setCode(clean);focusScanner();
            }catch(Exception ex){showFailure("扫码广播读取失败："+SyncEngine.message(ex));}
        }
    };
    @Override public void onCreate(Bundle state){
        super.onCreate(state);engine=SyncEngine.get(this);operation=engine.prefs.getString("operation","inbound");if(!"return".equals(operation))operation="inbound";
        if(!engine.prefs.getString("draft","").isEmpty()&&!engine.prefs.contains("legacy_draft_server"))engine.prefs.edit().putString("legacy_draft_server",engine.server()).putString("legacy_draft_operation",operation).commit();
        getWindow().setStatusBarColor(INK);getWindow().setNavigationBarColor(INK);getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN|WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        buildHome();
    }
    private int dp(int value){return Math.round(getResources().getDisplayMetrics().density*value);}
    private GradientDrawable background(int color,int radius){GradientDrawable d=new GradientDrawable();d.setColor(color);d.setCornerRadius(dp(radius));return d;}
    private TextView text(String value,int size,int color,boolean bold){TextView v=new TextView(this);v.setText(value);v.setTextSize(size);v.setTextColor(color);if(bold)v.setTypeface(Typeface.DEFAULT,Typeface.BOLD);v.setPadding(0,dp(3),0,dp(3));return v;}
    private LinearLayout column(){LinearLayout v=new LinearLayout(this);v.setOrientation(LinearLayout.VERTICAL);return v;}
    private void gap(LinearLayout parent,int height){parent.addView(new View(this),new LinearLayout.LayoutParams(1,dp(height)));}
    private Button button(String value,int color,View.OnClickListener listener){Button b=new Button(this);b.setText(value);b.setTextSize(15);b.setAllCaps(false);b.setFocusable(false);b.setFocusableInTouchMode(false);b.setTextColor(Color.WHITE);b.setBackground(background(color,10));b.setMinWidth(0);b.setMinimumWidth(0);b.setMinHeight(dp(40));b.setMinimumHeight(0);b.setPadding(dp(8),dp(6),dp(8),dp(6));b.setOnClickListener(listener);return b;}
    private void rowButton(LinearLayout row,Button b,boolean first,int height){LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(0,dp(height),1);if(!first)p.leftMargin=dp(8);row.addView(b,p);}
    private LinearLayout card(LinearLayout root){LinearLayout c=column();c.setBackground(background(Color.WHITE,14));c.setPadding(dp(16),dp(14),dp(16),dp(14));root.addView(c,new LinearLayout.LayoutParams(-1,-2));return c;}
    private String operationName(String op){return "return".equals(op)?"返回调换":"调换入库";}
    private int operationColor(){return "return".equals(operation)?ORANGE:BLUE;}
    private String bufferKey(){return "batch_buffer_"+operation;}
    private String reviewKey(){return "batch_buffer_review_"+operation;}
    private String buffer(){return barcode==null?engine.prefs.getString(bufferKey(),""):barcode.getText().toString();}
    private boolean hasPartialBuffers(){return !engine.prefs.getString("batch_buffer_return","").isEmpty()||!engine.prefs.getString("batch_buffer_inbound","").isEmpty();}
    private void persistBuffer(){if(barcode!=null)engine.prefs.edit().putString(bufferKey(),barcode.getText().toString()).commit();}
    private void protectPartial(){if(barcode!=null&&!buffer().isEmpty())engine.prefs.edit().putBoolean(reviewKey(),true).commit();}
    private void setCode(String value){if(barcode!=null){changingText=true;barcode.setText(value);barcode.setSelection(barcode.length());changingText=false;}android.content.SharedPreferences.Editor editor=engine.prefs.edit().putString(bufferKey(),value);if(value.isEmpty())editor.remove(reviewKey());editor.commit();updateRecovery();}
    private void buildHome(){
        protectPartial();persistBuffer();unregisterScanner();scanPage=false;barcode=null;batch=null;inspectedBatchId=null;
        ScrollView scroll=new ScrollView(this);scroll.setFillViewport(true);scroll.setBackgroundColor(BG);LinearLayout root=column();root.setPadding(dp(18),dp(22),dp(18),dp(20));scroll.addView(root);
        root.addView(text("仓库扫码",27,INK,true));root.addView(text("选择业务后，按 PDA 实体扫码键",14,MUTED,false));gap(root,20);
        LinearLayout returns=card(root);returns.addView(text("01  返回调换",22,ORANGE,true));returns.addView(text("先核对本批列表，再统一上传",13,MUTED,false));gap(returns,10);returns.addView(button("进入返回调换",ORANGE,v->openScanner("return",null)),new LinearLayout.LayoutParams(-1,dp(56)));gap(root,14);
        LinearLayout inbound=card(root);inbound.addView(text("02  调换入库",22,BLUE,true));inbound.addView(text("两种业务分别保存，切换不丢记录",13,MUTED,false));gap(inbound,10);inbound.addView(button("进入调换入库",BLUE,v->openScanner("inbound",null)),new LinearLayout.LayoutParams(-1,dp(56)));gap(root,16);
        homeSummary=text("",14,INK,true);root.addView(homeSummary);recovery=text("",13,ORANGE,true);recovery.setOnClickListener(v->showRecovery());root.addView(recovery);network=text("",12,MUTED,false);root.addView(network);endpoint=text("",11,MUTED,false);root.addView(endpoint);gap(root,12);
        LinearLayout actions=new LinearLayout(this);rowButton(actions,button("未完成批次",INK,v->showUnfinished()),true,46);rowButton(actions,button("扫码记录",INK,v->showHistory()),false,46);root.addView(actions);gap(root,10);root.addView(button("服务与扫码设置",MUTED,v->settings(null)),new LinearLayout.LayoutParams(-1,dp(46)));gap(root,12);
        root.addView(text("首页不接收扫码。未提交批次留在本机；提交后断网会保留，应用前台联网时自动重试。",12,MUTED,false));setContentView(scroll);refresh();
    }
    private void openScanner(String op,String id){
        protectPartial();persistBuffer();unregisterScanner();operation=op;inspectedBatchId=id;scanPage=true;page=0;listSignature="";lastCompletion="";batch=null;engine.prefs.edit().putString("operation",op).commit();
        LinearLayout root=column();root.setBackgroundColor(BG);root.setPadding(dp(12),dp(10),dp(12),dp(10));LinearLayout top=new LinearLayout(this);top.setGravity(Gravity.CENTER_VERTICAL);
        top.addView(button("返回",INK,v->buildHome()),new LinearLayout.LayoutParams(dp(58),dp(42)));TextView title=text(operationName(op),21,operationColor(),true);title.setGravity(Gravity.CENTER);top.addView(title,new LinearLayout.LayoutParams(0,-2,1));top.addView(button("设置",MUTED,v->settings(null)),new LinearLayout.LayoutParams(dp(58),dp(42)));root.addView(top);gap(root,8);
        batchSummary=text("正在读取本批…",17,INK,true);root.addView(batchSummary);batchHint=text("",12,MUTED,false);root.addView(batchHint);recovery=text("",12,ORANGE,true);recovery.setOnClickListener(v->showRecovery());root.addView(recovery);
        // Keep a tiny, focused keyboard receiver. GONE/INVISIBLE views cannot receive wedge input.
        barcode=new EditText(this);barcode.setSingleLine(false);barcode.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS|InputType.TYPE_TEXT_FLAG_MULTI_LINE);barcode.setImeOptions(EditorInfo.IME_ACTION_DONE);barcode.setShowSoftInputOnFocus(false);barcode.setCursorVisible(false);barcode.setBackgroundColor(Color.TRANSPARENT);barcode.setTextColor(Color.TRANSPARENT);barcode.setPadding(0,0,0,0);barcode.setAlpha(0f);barcode.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);root.addView(barcode,new LinearLayout.LayoutParams(dp(1),dp(1)));
        barcode.setOnEditorActionListener((v,action,event)->{if(action==EditorInfo.IME_ACTION_DONE||action==EditorInfo.IME_ACTION_GO||(event!=null&&event.getKeyCode()==KeyEvent.KEYCODE_ENTER)){if(event==null||event.getAction()==KeyEvent.ACTION_DOWN)consumeInput();return true;}return false;});barcode.setOnKeyListener((v,key,event)->{if(key==KeyEvent.KEYCODE_ENTER||key==KeyEvent.KEYCODE_TAB){if(event.getAction()==KeyEvent.ACTION_DOWN)consumeInput();return true;}return false;});
        barcode.addTextChangedListener(new TextWatcher(){public void beforeTextChanged(CharSequence s,int start,int count,int after){}public void onTextChanged(CharSequence s,int start,int before,int count){}public void afterTextChanged(Editable value){if(!changingText){persistBuffer();updateRecovery();if(hasSeparator(value.toString()))handler.post(()->consumeLines());}}});setCode(engine.prefs.getString(bufferKey(),""));protectPartial();
        ListView list=new ListView(this);list.setDivider(null);list.setDividerHeight(dp(8));list.setItemsCanFocus(false);list.setFocusable(false);list.setFocusableInTouchMode(false);list.setCacheColorHint(Color.TRANSPARENT);adapter=new ScanAdapter();list.setAdapter(adapter);root.addView(list,new LinearLayout.LayoutParams(-1,0,1));empty=text("本批还没有扫码\n按实体扫码键开始",16,MUTED,false);empty.setGravity(Gravity.CENTER);root.addView(empty,new LinearLayout.LayoutParams(-1,0,1));list.setEmptyView(empty);
        LinearLayout pages=new LinearLayout(this);pages.setGravity(Gravity.CENTER_VERTICAL);previous=button("上一页",MUTED,v->{if(page>0){page--;refresh();focusScanner();}});pages.addView(previous,new LinearLayout.LayoutParams(dp(76),dp(38)));pageLabel=text("",11,MUTED,false);pageLabel.setGravity(Gravity.CENTER);pages.addView(pageLabel,new LinearLayout.LayoutParams(0,-2,1));next=button("下一页",MUTED,v->{page++;refresh();focusScanner();});pages.addView(next,new LinearLayout.LayoutParams(dp(76),dp(38)));gap(root,6);root.addView(pages);
        network=text("",12,MUTED,false);network.setMaxLines(2);root.addView(network);endpoint=text("",10,MUTED,false);endpoint.setMaxLines(1);endpoint.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);root.addView(endpoint);upload=button("上传本批",operationColor(),v->uploadBatch());gap(root,5);root.addView(upload,new LinearLayout.LayoutParams(-1,dp(52)));setContentView(root);refresh();registerScanner();focusScanner();
    }
    private boolean acceptingScans(){return foreground&&scanPage&&inspectedBatchId==null&&dialogDepth==0&&batch!=null&&batch.editable()&&!engine.prefs.getBoolean(reviewKey(),false);}
    private void focusScanner(){if(barcode==null)return;boolean keyboard=acceptingScans()&&"keyboard".equals(engine.prefs.getString("input","broadcast"));barcode.setShowSoftInputOnFocus(false);barcode.setFocusableInTouchMode(keyboard);barcode.setFocusable(keyboard);if(keyboard)barcode.requestFocus();else barcode.clearFocus();((InputMethodManager)getSystemService(INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(barcode.getWindowToken(),0);}
    private boolean isSeparator(char c){return c=='\r'||c=='\n'||c=='\t';}
    private boolean hasSeparator(String value){return value.indexOf('\r')>=0||value.indexOf('\n')>=0||value.indexOf('\t')>=0;}
    private void consumeInput(){
        if(!acceptingScans()||changingText)return;
        String value=buffer();if(value.isEmpty())return;
        if(hasSeparator(value))consumeLines();
        // Enter/Tab also terminates a final fragment after a batch such as A\nB.
        // A storage failure marks the buffer for review, so never flush that tail.
        if(!acceptingScans())return;value=buffer();
        if(!value.isEmpty()&&!hasSeparator(value)&&saveScan(value))setCode("");
        focusScanner();
    }
    private void consumeLines(){if(!acceptingScans()||changingText)return;String input=buffer();int position=0;for(int i=0;i<input.length();i++)if(isSeparator(input.charAt(i))){String code=input.substring(position,i);if(!code.trim().isEmpty()&&!saveScan(code)){setCode(input.substring(position));return;}position=i+1;}if(position>0)setCode(input.substring(position));focusScanner();}
    private boolean saveScan(String code){
        try{engine.store.add(code,operation,engine.prefs.getString("device",""),engine.server());}catch(QueueStore.DuplicateScanException ex){toast("本批已扫描，未重复加入");return true;}catch(Exception ex){engine.prefs.edit().putBoolean(reviewKey(),true).commit();showFailure("未保存，扫码内容已保留待处理："+SyncEngine.message(ex));focusScanner();return false;}
        try{Vibrator vibrator=(Vibrator)getSystemService(VIBRATOR_SERVICE);if(vibrator!=null&&vibrator.hasVibrator())vibrator.vibrate(VibrationEffect.createOneShot(55,VibrationEffect.DEFAULT_AMPLITUDE));}catch(Exception ignored){}page=0;lastCompletion="";refresh();return true;
    }
    private String submittedKey(){return "last_submitted|"+operation+"|"+engine.server();}
    private void checkCompletion(){if(inspectedBatchId!=null)return;String id=engine.prefs.getString(submittedKey(),"");if(id.isEmpty())return;QueueStore.Batch prior=engine.store.getBatch(id);if("complete".equals(prior.state)&&prior.total>0){lastCompletion="上批 "+prior.total+" 条全部上传成功，已开启新批";engine.prefs.edit().remove(submittedKey()).commit();toast(lastCompletion);}}
    private void refresh(){
        if(network==null)return;network.setText(engine.status);network.setTextColor(MUTED);endpoint.setText(engine.server());
        try{
            if(!scanPage){QueueStore.Batch a=engine.store.currentBatch("return",engine.server()),b=engine.store.currentBatch("inbound",engine.server());homeSummary.setText("返回调换 "+a.total+" 条  ·  调换入库 "+b.total+" 条\n已提交待确认 "+engine.store.pending()+" 条");}
            else{
                batch=inspectedBatchId==null?engine.store.currentBatch(operation,engine.server()):engine.store.getBatch(inspectedBatchId);checkCompletion();boolean editable=batch.editable()&&inspectedBatchId==null;
                batchSummary.setText((inspectedBatchId==null?"本批 ":"查看批次 ")+batch.total+" 条"+(batch.editable()?" · 未提交":" · 已传 "+batch.sent+" / 待传 "+batch.pending));String hint=editable?"按实体扫码键 · 同批不重复 · 点条码看完整内容":"本批已锁定，全部确认后自动开启新批";if(inspectedBatchId!=null)hint="只读查看 · 扫码已暂停 · 点条码查看详情";if(batch.legacy)hint="旧版记录已保留，按原服务地址继续上传";if(!lastCompletion.isEmpty())hint=lastCompletion+"\n"+hint;batchHint.setText(hint);batchHint.setTextColor(lastCompletion.isEmpty()?MUTED:GREEN);endpoint.setText(batch.server);
                long pages=Math.max(1,(batch.total+PAGE_SIZE-1)/PAGE_SIZE);page=(int)Math.max(0,Math.min(page,pages-1));List<QueueStore.Entry> rows=engine.store.batchEntries(batch.id,PAGE_SIZE,page*PAGE_SIZE);StringBuilder signature=new StringBuilder(batch.id).append('|').append(batch.state).append('|').append(batch.total).append('|').append(page);for(QueueStore.Entry row:rows)signature.append('|').append(row.eventId).append(':').append(row.sent).append(':').append(row.error);if(!signature.toString().equals(listSignature)){listSignature=signature.toString();adapter.rows=rows;adapter.editable=editable;adapter.total=batch.total;adapter.offset=page*PAGE_SIZE;adapter.notifyDataSetChanged();}
                pageLabel.setText((page+1)+" / "+pages+" 页 · 最新在上");previous.setEnabled(page>0);next.setEnabled(page+1<pages);previous.setAlpha(page>0?1f:0.4f);next.setAlpha(page+1<pages?1f:0.4f);empty.setText(inspectedBatchId==null?"本批还没有扫码\n按实体扫码键开始，重复码不会加入":"此批没有记录");
                if(inspectedBatchId!=null){upload.setText(!batch.server.equals(engine.server())?"切换到此服务处理":batch.pending>0&&!batch.editable()?"重试此服务待确认记录":"返回当前扫码批次");upload.setEnabled(!engine.busy.get());}else if(editable){upload.setText("上传本批（"+batch.total+" 条）");upload.setEnabled(batch.total>0&&!engine.busy.get());}else{upload.setText(engine.busy.get()?"正在上传 · 待确认 "+batch.pending+" 条":"重试上传本批（"+batch.pending+" 条）");upload.setEnabled(!engine.busy.get());}upload.setAlpha(upload.isEnabled()?1f:0.5f);focusScanner();
            }updateRecovery();
        }catch(Exception ex){batch=null;network.setText("本机记录读取失败："+SyncEngine.message(ex));network.setTextColor(ORANGE);if(scanPage&&upload!=null)upload.setEnabled(false);focusScanner();}
    }
    private void uploadBatch(){
        if(batch==null)return;if(inspectedBatchId!=null){if(!batch.server.equals(engine.server()))settings(batch.server);else if(batch.pending>0&&!batch.editable()){engine.sync(true);refresh();}else openScanner(operation,null);return;}if(!buffer().isEmpty()){showRecovery();return;}if(!batch.editable()){engine.sync(true);refresh();return;}
        final String id=batch.id;final long count=batch.total;showDialog(new AlertDialog.Builder(this).setTitle("上传"+operationName(operation)+"本批").setMessage("共 "+count+" 条。提交后本批锁定，不能删除或继续加码；全部上传确认后自动开启新批。").setPositiveButton("确认上传",(d,w)->{try{QueueStore.Batch submitted=engine.submitBatch(id);engine.prefs.edit().putString(submittedKey(),submitted.id).commit();refresh();}catch(Exception ex){showFailure("提交失败："+SyncEngine.message(ex));}}).setNegativeButton("继续核对",null).create());
    }
    private final class ScanAdapter extends BaseAdapter{
        List<QueueStore.Entry> rows=new ArrayList<>();boolean editable;long total;int offset;
        public int getCount(){return rows.size();}public Object getItem(int p){return rows.get(p);}public long getItemId(int p){return rows.get(p).id;}
        public View getView(int position,View convert,ViewGroup parent){
            RowViews h;if(convert==null){LinearLayout c=column();c.setBackground(background(Color.WHITE,12));c.setPadding(dp(12),dp(9),dp(12),dp(9));LinearLayout top=new LinearLayout(MainActivity.this);top.setGravity(Gravity.CENTER_VERTICAL);TextView meta=text("",12,MUTED,false);top.addView(meta,new LinearLayout.LayoutParams(0,-2,1));Button remove=button("删除",ORANGE,null);remove.setTextSize(13);top.addView(remove,new LinearLayout.LayoutParams(dp(60),dp(40)));c.addView(top);TextView code=text("",19,INK,true);code.setMaxLines(3);code.setEllipsize(android.text.TextUtils.TruncateAt.END);c.addView(code);TextView state=text("",11,MUTED,false);state.setMaxLines(2);c.addView(state);h=new RowViews(meta,code,state,remove);c.setTag(h);convert=c;}else h=(RowViews)convert.getTag();
            final QueueStore.Entry row=rows.get(position);h.meta.setText("#"+(total-offset-position)+"  "+displayTime(row.time));h.code.setText(preview(row.barcode,256));h.state.setText(entryState(row)+(row.error.isEmpty()?"":" · "+preview(row.error,120)));h.state.setTextColor(row.sent?GREEN:row.error.isEmpty()?MUTED:ORANGE);h.remove.setVisibility(editable?View.VISIBLE:View.GONE);h.remove.setOnClickListener(v->{try{engine.store.deleteDraft(row.batchId,row.eventId);refresh();focusScanner();}catch(Exception ex){showFailure("删除失败："+SyncEngine.message(ex));}});convert.setOnClickListener(v->showEntry(row.eventId));convert.setFocusable(false);h.code.setOnClickListener(v->showEntry(row.eventId));h.code.setFocusable(false);return convert;
        }
    }
    private static final class RowViews{final TextView meta,code,state;final Button remove;RowViews(TextView m,TextView c,TextView s,Button r){meta=m;code=c;state=s;remove=r;}}
    private static String preview(String value,int max){return value.length()>max?value.substring(0,max)+"…":value;}
    private String displayTime(String time){return time.replace('T',' ').replaceFirst("\\.\\d+.*$","");}
    private String entryState(QueueStore.Entry row){return row.sent?"已上传 · 服务已确认":"draft".equals(row.batchState)?"本机草稿 · 可删除":"待上传确认 · 已锁定";}
    private void copy(String value){((ClipboardManager)getSystemService(CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("条码",value));toast("已复制完整条码");}
    private void showEntry(String id){try{QueueStore.Entry row=engine.store.getEntry(id);TextView detail=text(row.barcode+"\n\n"+operationName(row.operation)+" · "+entryState(row)+"\n"+row.time+"\n"+row.server+"\n事件："+row.eventId+(row.error.isEmpty()?"":"\n原因："+row.error),15,INK,false);detail.setTextIsSelectable(true);detail.setPadding(dp(20),dp(12),dp(20),dp(12));ScrollView scroll=new ScrollView(this);scroll.addView(detail);showDialog(new AlertDialog.Builder(this).setTitle("完整条码").setView(scroll).setPositiveButton("关闭",null).setNeutralButton("复制条码",(d,w)->copy(row.barcode)).create());}catch(Exception ex){showFailure("读取条码失败："+SyncEngine.message(ex));}}
    private void showHistory(){try{List<QueueStore.Entry> rows=engine.store.entries(false,"",100);String[] items=new String[rows.size()];for(int i=0;i<rows.size();i++){QueueStore.Entry row=rows.get(i);items[i]=operationName(row.operation)+" · "+entryState(row)+"\n"+preview(row.barcode,90)+"\n"+displayTime(row.time);}showDialog(new AlertDialog.Builder(this).setTitle("最近 100 条（点击查看）").setItems(items,(d,i)->showEntry(rows.get(i).eventId)).setPositiveButton("关闭",null).create());}catch(Exception ex){showFailure("读取记录失败："+SyncEngine.message(ex));}}
    private void showUnfinished(){try{List<QueueStore.Batch> batches=engine.store.unfinishedBatches();String[] items=new String[batches.size()];for(int i=0;i<batches.size();i++){QueueStore.Batch b=batches.get(i);items[i]=operationName(b.operation)+" · "+b.total+" 条 · "+(b.editable()?"未提交":"待确认 "+b.pending+" 条")+"\n"+b.server;}AlertDialog.Builder builder=new AlertDialog.Builder(this).setTitle("未完成批次 · 按服务分别保留").setPositiveButton("关闭",null);if(items.length==0)builder.setMessage("暂无未完成批次");else builder.setItems(items,(d,i)->{QueueStore.Batch b=batches.get(i);openScanner(b.operation,!b.legacy&&b.server.equals(engine.server())?null:b.id);});showDialog(builder.create());}catch(Exception ex){showFailure("读取批次失败："+SyncEngine.message(ex));}}
    private void updateRecovery(){if(recovery==null)return;String value=scanPage?buffer():"";if(!value.isEmpty())recovery.setText("有未处理扫码内容（"+value.length()+" 字符）· 点此处理");else if(!engine.prefs.getString("draft","").isEmpty())recovery.setText("有旧版未保存内容 · 点此恢复或查看");else if(!scanPage&&hasPartialBuffers())recovery.setText("有未处理扫码片段，请进入对应业务处理");else recovery.setText("");recovery.setVisibility(recovery.getText().length()==0?View.GONE:View.VISIBLE);}
    private void showRecovery(){
        final boolean legacy=!scanPage||buffer().isEmpty();final String value=legacy?engine.prefs.getString("draft",""):buffer();if(value.isEmpty()){toast("请进入对应业务，点击未处理内容提示");return;}
        final String op=legacy?engine.prefs.getString("legacy_draft_operation",operation):operation,server=legacy?engine.prefs.getString("legacy_draft_server",engine.server()):engine.server();AlertDialog.Builder builder=new AlertDialog.Builder(this).setTitle(legacy?"旧版未保存内容":"未处理扫码内容").setMessage(operationName(op)+"\n"+server+"\n\n"+preview(value,1000)+"\n\n内容已保留。确认完整后可加入本批；键盘扫码需配置 Enter、Tab 或换行结束符。").setNegativeButton("稍后处理",null).setNeutralButton("复制 / 清除",(d,w)->recoveryOptions(value,op,legacy));if(!server.equals(engine.server()))builder.setPositiveButton("切回原服务",(d,w)->settings(server));else builder.setPositiveButton("加入本批",(d,w)->restoreBuffer(value,op,legacy));showDialog(builder.create());
    }
    private void recoveryOptions(String value,String op,boolean legacy){
        showDialog(new AlertDialog.Builder(this).setTitle("处理未保存内容").setItems(new String[]{"复制完整内容","清除这段未保存内容"},(d,i)->{
            if(i==0){copy(value);return;}
            showDialog(new AlertDialog.Builder(this).setTitle("确认清除未保存内容")
                .setMessage("只清除这段未保存内容，已在批次列表中的记录保持不变。清除后无法恢复，建议先复制核对。")
                .setNegativeButton("保留",null).setPositiveButton("确认清除",(x,w)->{
                    String key=legacy?"draft":"batch_buffer_"+op;
                    if(!value.equals(engine.prefs.getString(key,""))){toast("内容已变化，请重新查看后处理");return;}
                    if(legacy)engine.prefs.edit().remove("draft").remove("legacy_draft_operation").remove("legacy_draft_server").commit();
                    else if(scanPage&&operation.equals(op))setCode("");else engine.prefs.edit().remove(key).remove("batch_buffer_review_"+op).commit();
                    toast("未保存内容已清除");refresh();
                }).create());
        }).setNegativeButton("返回",null).create());
    }
    private void restoreBuffer(String value,String op,boolean legacy){
        String remaining=value;int added=0;try{if(!engine.store.currentBatch(op,engine.server()).editable())throw new IllegalStateException("该业务本批已提交，请等待全部确认后恢复");while(!remaining.isEmpty()){int end=0;while(end<remaining.length()&&!isSeparator(remaining.charAt(end)))end++;String code=remaining.substring(0,end);int consumed=end;while(consumed<remaining.length()&&(isSeparator(remaining.charAt(consumed))))consumed++;if(!code.trim().isEmpty())try{engine.store.add(code,op,engine.prefs.getString("device",""),engine.server());added++;}catch(QueueStore.DuplicateScanException duplicate){}remaining=remaining.substring(consumed);if(legacy)engine.prefs.edit().putString("draft",remaining).commit();else setCode(remaining);}if(legacy)engine.prefs.edit().remove("draft").remove("legacy_draft_server").remove("legacy_draft_operation").commit();toast("已处理，新增 "+added+" 条，重复码未加入");if(!scanPage||!operation.equals(op))openScanner(op,null);else{page=0;refresh();}}catch(Exception ex){showFailure("剩余内容仍已保留："+SyncEngine.message(ex));updateRecovery();}
    }
    private EditText settingField(LinearLayout form,String label,String value,boolean secret){form.addView(text(label,13,INK,true));EditText field=new EditText(this);field.setText(value);field.setTextSize(15);field.setSingleLine(true);field.setInputType(secret?InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_PASSWORD:InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);form.addView(field,new LinearLayout.LayoutParams(-1,-2));gap(form,8);return field;}
    private void settings(String suggestedServer){
        persistBuffer();

        LinearLayout form=column();form.setPadding(dp(20),dp(10),dp(20),dp(10));ScrollView scroll=new ScrollView(this);scroll.addView(form);
        EditText server=settingField(form,"服务地址（端口可修改）",suggestedServer==null?engine.server():suggestedServer,false);
        EditText token=settingField(form,"服务密钥（服务未设置时留空）",engine.prefs.getString("token",""),true);
        form.addView(text("扫码数据接收方式",13,INK,true));Spinner input=new Spinner(this);input.setAdapter(new ArrayAdapter<String>(this,android.R.layout.simple_spinner_dropdown_item,new String[]{"系统输入 / 键盘输出","厂商广播输出"}));input.setSelection("broadcast".equals(engine.prefs.getString("input","keyboard"))?1:0);form.addView(input);gap(form,10);
        EditText action=settingField(form,"广播 Action（使用广播时必填）",engine.prefs.getString("action",""),false);
        EditText extra=settingField(form,"条码字段名（使用广播时必填）",engine.prefs.getString("extra",""),false);
        EditText trigger=settingField(form,"触发扫码 Action（厂商提供时填写，可留空）",engine.prefs.getString("trigger",""),false);
        final boolean[] applySeuic={false};
        form.addView(button("一键配置东集扫码",INK,v->{input.setSelection(1);action.setText(SyncEngine.SEUIC_ACTION);extra.setText(SyncEngine.SEUIC_EXTRA);trigger.setText(SyncEngine.SEUIC_START);applySeuic[0]=true;toast("点击保存后，同时配置设备扫描工具");}));gap(form,8);
        form.addView(text("一键配置会在保存时将设备扫描工具设为本应用专用广播，供本软件接收。切换其他扫码软件时需按其要求恢复设备扫码设置。\n请先打开设备“扫描工具”，选择隐藏保持运行。若一键配置未生效，在扫描工具中手动设置广播方式、上述 Action 和条码字段。\n系统输入模式：设备发送方式选焦点输入或模拟键盘，结束符必须选 Enter、Tab 或换行。\n只在业务扫码页前台接收，设置和详情弹窗期间暂停。",12,MUTED,false));gap(form,8);
        form.addView(text("设备标识："+engine.prefs.getString("device",""),11,MUTED,false));
        Button test=button("测试连接",BLUE,v->{
            final String target,key=token.getText().toString();try{target=SyncEngine.normalizeServer(server.getText().toString());}catch(Exception ex){toast(SyncEngine.message(ex));return;}
            ((Button)v).setEnabled(false);((Button)v).setText("正在测试…");
            new Thread(()->{String result;try{SyncEngine.checkService(target,key,true);result="连接成功，接口兼容";}catch(Exception ex){result="连接失败："+SyncEngine.message(ex);}final String message=result;runOnUiThread(()->{((Button)v).setEnabled(true);((Button)v).setText("测试连接");toast(message);});},"connection-test").start();
        });gap(form,10);form.addView(test);
        AlertDialog dialog=new AlertDialog.Builder(this).setTitle("服务与扫码设置").setView(scroll).setPositiveButton("保存",null).setNegativeButton("取消",null).create();
        showDialog(dialog);
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v->{
            try{
                final String target=SyncEngine.normalizeServer(server.getText().toString()),old=engine.server();
                final String selected=input.getSelectedItemPosition()==0?"keyboard":"broadcast",a=action.getText().toString().trim(),e=extra.getText().toString().trim(),t=trigger.getText().toString().trim(),key=token.getText().toString();
                if("broadcast".equals(selected)&&(a.isEmpty()||e.isEmpty()))throw new IllegalArgumentException("广播模式必须填写 Action 和条码字段名");
                if(key.length()>256)throw new IllegalArgumentException("密钥不能超过 256 位");
                for(int k=0;k<key.length();k++)if(key.charAt(k)<33||key.charAt(k)>126)throw new IllegalArgumentException("密钥应为不含空格的英文字母、数字或符号");
                if(engine.busy.get()){toast("正在上传，请稍后保存设置");return;}
                if(!old.equals(target)&&hasPartialBuffers())throw new IllegalArgumentException("有未处理扫码片段，请先进入对应业务处理，再修改地址");
                Runnable save=()->{
                    if(!engine.prefs.edit().putString("server",target).putString("token",key).putString("input",selected).putString("action",a).putString("extra",e).putString("trigger",t).commit()){toast("设置保存失败，请重试");return;}
                    if(applySeuic[0]&&"broadcast".equals(selected)){
                        try{
                            sendBroadcast(new Intent("com.android.scanner.ENABLED").putExtra("enabled",true));
                            sendBroadcast(new Intent("com.android.scanner.service_settings").putExtra("barcode_send_mode","BROADCAST").putExtra("action_barcode_broadcast",a).putExtra("key_barcode_broadcast",e));
                            toast("已发送东集配置，请实际扫描一个条码确认");
                        }catch(Exception ex){toast("设置已保存，设备配置需手动完成："+SyncEngine.message(ex));}
                    }
                    dialog.dismiss();if(scanPage)openScanner(operation,null);else refresh();engine.sync(true);
                };
                if(!old.equals(target)&&(engine.store.pendingAt(old)>0||engine.store.draftAt(old)>0)){
                    showDialog(new AlertDialog.Builder(this).setTitle("未完成批次的服务地址")
                        .setMessage("原地址："+old+"\n新地址："+target+"\n\n已提交批次固定在原服务，不允许移动。未提交草稿可整体迁移，目标业务已有记录时不能合并。选择仅后续扫码后，可从首页“未完成批次”切回处理。")
                        .setPositiveButton("迁移未提交草稿",(d,w)->{if(engine.busy.get()){toast("正在上传，请稍后重试");return;}try{engine.store.movePending(old,target);save.run();}catch(Exception ex){toast("修改失败："+SyncEngine.message(ex));}})
                        .setNeutralButton("仅后续扫码",(d,w)->save.run()).setNegativeButton("取消",null).create());
                }else save.run();
            }catch(Exception ex){toast(SyncEngine.message(ex));}
        });
    }
    private void showDialog(AlertDialog dialog){protectPartial();dialogDepth++;unregisterScanner();focusScanner();dialog.setOnDismissListener(d->{dialogDepth=Math.max(0,dialogDepth-1);refresh();registerScanner();focusScanner();});dialog.show();}
    private void registerScanner(){if(receiverRegistered||!foreground||!scanPage||inspectedBatchId!=null||dialogDepth>0||!"broadcast".equals(engine.prefs.getString("input","broadcast")))return;String action=engine.prefs.getString("action","");if(action.isEmpty())return;try{registerReceiver(receiver,new IntentFilter(action));receiverRegistered=true;}catch(Exception ex){showFailure("无法注册扫码广播："+SyncEngine.message(ex));}}
    private void unregisterScanner(){if(receiverRegistered){unregisterReceiver(receiver);receiverRegistered=false;}}
    private void toast(String value){android.widget.Toast.makeText(this,value,android.widget.Toast.LENGTH_LONG).show();}
    private void showFailure(String value){if(network!=null){network.setText(value);network.setTextColor(ORANGE);}toast(value);}
    @Override public void onBackPressed(){if(scanPage)buildHome();else super.onBackPressed();}
    @Override protected void onResume(){super.onResume();foreground=true;registerScanner();focusScanner();handler.removeCallbacks(tick);handler.post(tick);}
    @Override protected void onPause(){foreground=false;handler.removeCallbacks(tick);unregisterScanner();protectPartial();persistBuffer();if(SyncEngine.SEUIC_START.equals(engine.prefs.getString("trigger","")))try{sendBroadcast(new Intent(SyncEngine.SEUIC_STOP));}catch(Exception ignored){}super.onPause();}
    @Override protected void onSaveInstanceState(Bundle state){persistBuffer();super.onSaveInstanceState(state);}
}
