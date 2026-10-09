package com.warehouse.pda;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

final class SyncEngine {
    static final String DEFAULT_SERVER="http://10.164.62.212:5000";
    static final String SEUIC_ACTION="com.warehouse.pda.SCAN";
    static final String SEUIC_EXTRA="scannerdata";
    static final String SEUIC_START="com.scan.onStartScan";
    static final String SEUIC_STOP="com.scan.onEndScan";
    private static SyncEngine instance;
    final QueueStore store;
    final SharedPreferences prefs;
    final AtomicBoolean busy=new AtomicBoolean(false);
    private final ExecutorService executor=Executors.newSingleThreadExecutor();
    volatile String status="扫码先存入本批，检查后上传";
    private volatile long retryAt=0;
    private int retrySeconds=5;
    static synchronized SyncEngine get(Context context) {
        if(instance==null) instance=new SyncEngine(context.getApplicationContext());
        return instance;
    }
    private SyncEngine(Context context) {
        store=new QueueStore(context); prefs=context.getSharedPreferences("scanner",Context.MODE_PRIVATE);
        if(!prefs.contains("device")) prefs.edit().putString("device","PDA-"+java.util.UUID.randomUUID()).commit();
        if(!prefs.contains("input")) prefs.edit().putString("input","broadcast").putString("action",SEUIC_ACTION).putString("extra",SEUIC_EXTRA).putString("trigger",SEUIC_START).commit();
    }
    String server() { return prefs.getString("server",DEFAULT_SERVER); }
    static String normalizeServer(String value) throws Exception {
        URI uri=new URI(value.trim());
        if(!("http".equals(uri.getScheme())||"https".equals(uri.getScheme())) || uri.getHost()==null || uri.getUserInfo()!=null || uri.getQuery()!=null || uri.getFragment()!=null || uri.getPort()==0 || uri.getPort()>65535)
            throw new IllegalArgumentException("请填写 http://IP:端口 或 https://主机:端口");
        if(uri.getPath()!=null&&!uri.getPath().isEmpty()&&!uri.getPath().equals("/"))
            throw new IllegalArgumentException("服务地址不应包含接口路径");
        return uri.getScheme()+"://"+uri.getRawAuthority();
    }
    static JSONObject request(String server,String path,String token,JSONObject body) throws Exception {
        HttpURLConnection connection=(HttpURLConnection)new URL(server+path).openConnection();
        try {
            connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(5000);connection.setReadTimeout(8000);
            connection.setRequestProperty("Accept","application/json");
            if(!token.isEmpty()) connection.setRequestProperty("X-API-Key",token);
            if(body!=null) {
                byte[] bytes=body.toString().getBytes(StandardCharsets.UTF_8);
                connection.setRequestMethod("POST");connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type","application/json; charset=utf-8");connection.setFixedLengthStreamingMode(bytes.length);
                try(java.io.OutputStream out=connection.getOutputStream()){out.write(bytes);}
            }
            int code=connection.getResponseCode();
            InputStream stream=code>=200&&code<300?connection.getInputStream():connection.getErrorStream();
            ByteArrayOutputStream output=new ByteArrayOutputStream();
            if(stream!=null) try(InputStream in=stream) {
                byte[] buffer=new byte[2048];int n;
                while((n=in.read(buffer))!=-1){if(output.size()+n>65536)throw new Exception("服务响应过大");output.write(buffer,0,n);}
            }
            String raw=new String(output.toByteArray(),StandardCharsets.UTF_8);
            if(code<200||code>=300) {
                String detail="";
                try{detail=new JSONObject(raw).optString("error","");}catch(Exception ignored){}
                throw new Exception("HTTP "+code+(detail.isEmpty()?"":"："+detail.substring(0,Math.min(160,detail.length()))));
            }
            return new JSONObject(raw);
        } finally { connection.disconnect(); }
    }
    QueueStore.Batch submitBatch(String batchId) {
        QueueStore.Batch batch=store.getBatch(batchId);
        if(!batch.server.equals(server()))
            throw new IllegalStateException("请先切换到本批原服务地址，再上传该批");
        // Freeze every row durably before a network request can observe it.
        QueueStore.Batch submitted=store.submitBatch(batchId);
        sync(true);
        return submitted;
    }
    void sync(boolean force) {
        if(!force && android.os.SystemClock.elapsedRealtime()<retryAt) return;
        if(!busy.compareAndSet(false,true)) return;
        final String destination=server(),token=prefs.getString("token","");
        try {executor.execute(()->{
            try {
                int sent=0;
                java.util.List<QueueStore.Entry> rows=store.entries(true,destination,100);
                if(!rows.isEmpty()) checkService(destination,token,false);
                for(QueueStore.Entry row:rows) {
                    status="正在上传…";
                    try {
                        JSONObject ack=request(destination,"/api/scans",token,row.payload());
                        Object recordId=ack.opt("id");
                        if(!Boolean.TRUE.equals(ack.opt("ok")) || !row.eventId.equals(ack.optString("event_id")) || !(recordId instanceof Integer || recordId instanceof Long) || ((Number)recordId).longValue()<=0 || !(ack.opt("duplicate") instanceof Boolean))
                            throw new Exception("服务确认格式不符，记录保留待传");
                        store.acknowledge(row);sent++;
                    } catch(Exception ex) {store.fail(row,message(ex));throw ex;}
                }
                retrySeconds=5;retryAt=0;
                status=store.pending()==0?(sent>0?"已上传，服务已确认":
                    (store.draftAt(destination)>0?"本批尚未提交，检查列表后点击上传本批":"没有已提交的待传记录")):
                    (store.pendingAt(destination)==0?"其他服务地址有已提交待传记录，请查看未完成批次":"继续上传已提交批次的剩余记录…");
            } catch(Exception ex) {
                status="待补传："+message(ex);retryAt=android.os.SystemClock.elapsedRealtime()+retrySeconds*1000L;retrySeconds=Math.min(60,retrySeconds*2);
            } finally {busy.set(false);}
        });} catch(RuntimeException ex) {busy.set(false);throw ex;}
    }
    static void checkService(String destination,String token,boolean checkCredentials) throws Exception {
        JSONObject health=request(destination,"/api/health",token,null);
        Object version=health.opt("api_version");
        if(!Boolean.TRUE.equals(health.opt("ok")) || !"warehouse-scan".equals(health.optString("service")) || !(version instanceof Integer) || ((Integer)version)!=1)
            throw new Exception("服务接口不兼容，请检查 IP、端口或服务版本");
        if(checkCredentials&&health.optBoolean("auth_required",false))request(destination,"/api/report?page_size=1",token,null);
    }
    static String message(Exception ex) {String value=ex.getMessage();return value==null?ex.getClass().getSimpleName():value;}
}
