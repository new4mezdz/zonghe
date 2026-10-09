package com.warehouse.pda;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteConstraintException;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

/** Draft batches are editable; submitted events retain their UUID until acknowledged. */
final class QueueStore extends SQLiteOpenHelper {
    private static final String[] ENTRY_COLUMNS={
        "s.id AS id","s.event_id AS event_id","s.barcode AS barcode",
        "s.operation AS operation","s.scanned_at AS scanned_at","s.device_id AS device_id",
        "s.server AS server","s.sent AS sent","s.error AS error",
        "s.batch_id AS batch_id","b.state AS batch_state"
    };
    private static final String ENTRY_TABLE="scans AS s JOIN batches AS b ON b.id=s.batch_id";
    private static final String BATCH_SELECT="SELECT b.id,b.operation,b.server,b.state,b.created_at,b.legacy,"
        +"COUNT(s.id) AS total,COALESCE(SUM(CASE WHEN s.sent=1 THEN 1 ELSE 0 END),0) AS sent_count "
        +"FROM batches b LEFT JOIN scans s ON s.batch_id=b.id ";

    QueueStore(Context context) { super(context,"pda-scans.db",null,2); }

    @Override public void onConfigure(SQLiteDatabase db) {
        db.setForeignKeyConstraintsEnabled(true);
        db.execSQL("PRAGMA synchronous=FULL");
    }

    private void createBatches(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE batches (id TEXT PRIMARY KEY NOT NULL,operation TEXT NOT NULL CHECK(operation IN ('return','inbound')),server TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('draft','submitted','complete')),legacy INTEGER NOT NULL DEFAULT 0 CHECK(legacy IN (0,1)),created_at TEXT NOT NULL,submitted_at TEXT,completed_at TEXT)");
        db.execSQL("CREATE UNIQUE INDEX current_batch ON batches(server,operation) WHERE legacy=0 AND state IN ('draft','submitted')");
        db.execSQL("CREATE INDEX batches_upload ON batches(server,state)");
    }

    private void createScanIndexes(SQLiteDatabase db) {
        db.execSQL("CREATE UNIQUE INDEX batch_barcode ON scans(batch_id,barcode)");
        db.execSQL("CREATE INDEX scans_batch ON scans(batch_id,id)");
    }

    @Override public void onCreate(SQLiteDatabase db) {
        createBatches(db);
        db.execSQL("CREATE TABLE scans (id INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,barcode TEXT NOT NULL,operation TEXT NOT NULL,scanned_at TEXT NOT NULL,device_id TEXT NOT NULL,server TEXT NOT NULL,sent INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '',batch_id TEXT NOT NULL REFERENCES batches(id))");
        db.execSQL("CREATE INDEX pending_scans ON scans(sent,id)");
        createScanIndexes(db);
    }

    @Override public void onUpgrade(SQLiteDatabase db,int oldVersion,int newVersion) {
        if(oldVersion!=1||newVersion!=2)
            throw new IllegalStateException("数据库版本不兼容，请保留现有应用数据并联系维护人员");
        // SQLiteOpenHelper wraps this migration in one transaction. A legacy
        // sent=0 row may already exist remotely after a lost acknowledgement:
        // freeze it and preserve its exact original payload and event UUID.
        createBatches(db);
        db.execSQL("ALTER TABLE scans ADD COLUMN batch_id TEXT REFERENCES batches(id)");
        db.execSQL("INSERT INTO batches(id,operation,server,state,legacy,created_at) SELECT 'legacy-'||event_id,operation,server,CASE WHEN sent=1 THEN 'complete' ELSE 'submitted' END,1,scanned_at FROM scans");
        db.execSQL("UPDATE scans SET batch_id='legacy-'||event_id");
        createScanIndexes(db);
    }

    private static String now() {
        return OffsetDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSSXXX",Locale.ROOT));
    }

    private static void validateContext(String operation,String server) {
        if(!"return".equals(operation)&&!"inbound".equals(operation))
            throw new IllegalArgumentException("扫码业务类型无效");
        if(server==null||server.trim().isEmpty()||server.length()>2048)
            throw new IllegalArgumentException("服务地址无效");
    }

    private static String normalizedBarcode(String barcode) {
        if(barcode==null||barcode.indexOf('\0')>=0)
            throw new IllegalArgumentException("码内容为空或包含空字符");
        String value=barcode.trim();
        if(value.isEmpty()||value.getBytes(StandardCharsets.UTF_8).length>65536)
            throw new IllegalArgumentException("码内容为空或超过 64 KB");
        for(int i=0;i<value.length();i++) {
            char current=value.charAt(i);
            if(Character.isHighSurrogate(current)) {
                if(i+1>=value.length()||!Character.isLowSurrogate(value.charAt(++i)))
                    throw new IllegalArgumentException("码内容包含无效字符");
            } else if(Character.isLowSurrogate(current)) {
                throw new IllegalArgumentException("码内容包含无效字符");
            }
        }
        return value;
    }

    static final class DuplicateScanException extends IllegalArgumentException {
        DuplicateScanException() { super("本批已有此条码，未重复添加"); }
    }

    static final class Batch {
        final String id,operation,server,state,createdAt;
        final long total,sent,pending;
        final boolean legacy;
        Batch(Cursor c) {
            id=c.getString(0);operation=c.getString(1);server=c.getString(2);
            state=c.getString(3);createdAt=c.getString(4);legacy=c.getInt(5)==1;
            total=c.getLong(6);sent=c.getLong(7);pending=total-sent;
        }
        boolean editable() { return "draft".equals(state)&&!legacy; }
    }

    static final class Entry {
        final long id;
        final String eventId,barcode,operation,time,device,server,error,batchId,batchState;
        final boolean sent;
        Entry(Cursor c) {
            id=c.getLong(c.getColumnIndexOrThrow("id"));
            eventId=c.getString(c.getColumnIndexOrThrow("event_id"));
            barcode=c.getString(c.getColumnIndexOrThrow("barcode"));
            operation=c.getString(c.getColumnIndexOrThrow("operation"));
            time=c.getString(c.getColumnIndexOrThrow("scanned_at"));
            device=c.getString(c.getColumnIndexOrThrow("device_id"));
            server=c.getString(c.getColumnIndexOrThrow("server"));
            sent=c.getInt(c.getColumnIndexOrThrow("sent"))==1;
            error=c.getString(c.getColumnIndexOrThrow("error"));
            batchId=c.getString(c.getColumnIndexOrThrow("batch_id"));
            batchState=c.getString(c.getColumnIndexOrThrow("batch_state"));
        }
        JSONObject payload() throws Exception {
            // Batch metadata is local only; keep the existing server API exact.
            return new JSONObject().put("event_id",eventId).put("barcode",barcode).put("source","pda")
                .put("operation",operation).put("scanned_at",time).put("device_id",device);
        }
    }

    private Batch readBatch(SQLiteDatabase db,String id) {
        try(Cursor c=db.rawQuery(BATCH_SELECT+"WHERE b.id=? GROUP BY b.id",new String[]{id})) {
            if(!c.moveToFirst())throw new IllegalArgumentException("批次不存在，请刷新列表");
            return new Batch(c);
        }
    }

    Batch getBatch(String id) { return readBatch(getReadableDatabase(),id); }

    private String activeBatchId(SQLiteDatabase db,String operation,String server) {
        try(Cursor c=db.rawQuery("SELECT id FROM batches WHERE legacy=0 AND operation=? AND server=? AND state IN ('draft','submitted') LIMIT 1",new String[]{operation,server})) {
            return c.moveToFirst()?c.getString(0):null;
        }
    }

    private Batch currentBatch(SQLiteDatabase db,String operation,String server) {
        String id=activeBatchId(db,operation,server);
        if(id==null) {
            id=UUID.randomUUID().toString();
            ContentValues values=new ContentValues();
            values.put("id",id);values.put("operation",operation);values.put("server",server);
            values.put("state","draft");values.put("legacy",0);values.put("created_at",now());
            db.insertOrThrow("batches",null,values);
        }
        return readBatch(db,id);
    }

    Batch currentBatch(String operation,String server) {
        validateContext(operation,server);
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();
        try {
            Batch batch=currentBatch(db,operation,server);db.setTransactionSuccessful();return batch;
        } finally {db.endTransaction();}
    }

    String add(String barcode,String operation,String device,String server) {
        String code=normalizedBarcode(barcode);validateContext(operation,server);
        if(device==null||device.trim().isEmpty()||device.length()>128)
            throw new IllegalArgumentException("设备编号无效，请检查设置");
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();
        try {
            Batch batch=currentBatch(db,operation,server);
            if(!batch.editable())throw new IllegalStateException("本批已提交并锁定，请等待全部上传成功后扫描新批");
            String eventId=UUID.randomUUID().toString();
            ContentValues values=new ContentValues();
            values.put("event_id",eventId);values.put("barcode",code);values.put("operation",operation);
            values.put("scanned_at",now());values.put("device_id",device);values.put("server",server);values.put("batch_id",batch.id);
            try {db.insertOrThrow("scans",null,values);}
            catch(SQLiteConstraintException ex) {
                try(Cursor c=db.rawQuery("SELECT 1 FROM scans WHERE batch_id=? AND barcode=? LIMIT 1",new String[]{batch.id,code})) {
                    if(c.moveToFirst())throw new DuplicateScanException();
                }
                throw ex;
            }
            db.setTransactionSuccessful();return eventId;
        } finally {db.endTransaction();}
    }

    void deleteDraft(String batchId,String eventId) {
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();
        try {
            Batch batch=readBatch(db,batchId);
            if(!batch.editable())throw new IllegalStateException("本批已提交，不能删除可能已送达服务端的记录");
            int changed=db.delete("scans","batch_id=? AND event_id=? AND sent=0",new String[]{batchId,eventId});
            if(changed!=1)throw new IllegalArgumentException("该记录已不存在，请刷新列表");
            db.setTransactionSuccessful();
        } finally {db.endTransaction();}
    }

    Batch submitBatch(String batchId) {
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();
        try {
            Batch batch=readBatch(db,batchId);
            if("draft".equals(batch.state)) {
                if(batch.total==0)throw new IllegalStateException("本批没有条码，请先扫码");
                ContentValues values=new ContentValues();values.put("state","submitted");values.put("submitted_at",now());
                db.update("batches",values,"id=? AND state='draft'",new String[]{batchId});
            }
            Batch result=readBatch(db,batchId);db.setTransactionSuccessful();return result;
        } finally {db.endTransaction();}
    }

    private static void validatePage(int limit,int offset) {
        if(limit<1||limit>1000||offset<0)throw new IllegalArgumentException("记录分页参数无效");
    }

    List<Entry> batchEntries(String batchId,int limit,int offset) {
        validatePage(limit,offset);
        List<Entry> result=new ArrayList<>();
        try(Cursor c=getReadableDatabase().query(ENTRY_TABLE,ENTRY_COLUMNS,"s.batch_id=?",new String[]{batchId},null,null,"s.id DESC",offset+","+limit)) {
            while(c.moveToNext())result.add(new Entry(c));
        }
        return result;
    }

    Entry getEntry(String eventId) {
        try(Cursor c=getReadableDatabase().query(ENTRY_TABLE,ENTRY_COLUMNS,"s.event_id=?",new String[]{eventId},null,null,null,"1")) {
            if(!c.moveToFirst())throw new IllegalArgumentException("记录不存在，请刷新列表");
            return new Entry(c);
        }
    }

    List<Entry> entries(boolean pending,String server,int limit) {
        validatePage(limit,0);
        List<Entry> result=new ArrayList<>();
        String where=pending?"s.sent=0 AND s.server=? AND b.state='submitted'":null;
        try(Cursor c=getReadableDatabase().query(ENTRY_TABLE,ENTRY_COLUMNS,where,pending?new String[]{server}:null,null,null,pending?"s.id ASC":"s.id DESC",Integer.toString(limit))) {
            while(c.moveToNext())result.add(new Entry(c));
        }
        return result;
    }

    List<Batch> unfinishedBatches() {
        List<Batch> result=new ArrayList<>();
        try(Cursor c=getReadableDatabase().rawQuery(BATCH_SELECT+"WHERE b.state IN ('draft','submitted') GROUP BY b.id HAVING COUNT(s.id)>0 ORDER BY b.rowid DESC",null)) {
            while(c.moveToNext())result.add(new Batch(c));
        }
        return result;
    }

    long pending() {
        try(Cursor c=getReadableDatabase().rawQuery("SELECT COUNT(*) FROM scans s JOIN batches b ON b.id=s.batch_id WHERE s.sent=0 AND b.state='submitted'",null)) {
            c.moveToFirst();return c.getLong(0);
        }
    }

    long pendingAt(String server) {
        try(Cursor c=getReadableDatabase().rawQuery("SELECT COUNT(*) FROM scans s JOIN batches b ON b.id=s.batch_id WHERE s.sent=0 AND b.state='submitted' AND s.server=?",new String[]{server})) {
            c.moveToFirst();return c.getLong(0);
        }
    }

    long draftAt(String server) {
        try(Cursor c=getReadableDatabase().rawQuery("SELECT COUNT(*) FROM scans s JOIN batches b ON b.id=s.batch_id WHERE b.state='draft' AND b.server=?",new String[]{server})) {
            c.moveToFirst();return c.getLong(0);
        }
    }

    void acknowledge(Entry row) {
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();
        try {
            Batch batch=readBatch(db,row.batchId);
            if(!batch.server.equals(row.server)||"draft".equals(batch.state))
                throw new IllegalStateException("批次地址或状态已变化，上传确认未写入");
            ContentValues values=new ContentValues();values.put("sent",1);values.put("error","");
            int changed=db.update("scans",values,"event_id=? AND server=? AND batch_id=?",new String[]{row.eventId,row.server,row.batchId});
            if(changed!=1)throw new IllegalStateException("记录不存在，上传确认未写入");
            Batch updated=readBatch(db,row.batchId);
            if(updated.pending==0&&updated.total>0&&"submitted".equals(updated.state)) {
                ContentValues completed=new ContentValues();completed.put("state","complete");completed.put("completed_at",now());
                db.update("batches",completed,"id=? AND state='submitted'",new String[]{row.batchId});
            }
            db.setTransactionSuccessful();
        } finally {db.endTransaction();}
    }

    void fail(Entry row,String error) {
        String text=error==null?"上传失败":error;
        ContentValues values=new ContentValues();values.put("error",text.substring(0,Math.min(1000,text.length())));
        getWritableDatabase().update("scans",values,"event_id=? AND server=? AND batch_id=? AND sent=0",new String[]{row.eventId,row.server,row.batchId});
    }

    /** Only never-submitted batches can change destination; batches never merge. */
    void movePending(String oldServer,String newServer) {
        if(oldServer.equals(newServer))return;
        validateContext("inbound",newServer);
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();
        try {
            try(Cursor c=db.rawQuery("SELECT 1 FROM batches b JOIN scans s ON s.batch_id=b.id WHERE b.server=? AND b.state='submitted' AND s.sent=0 LIMIT 1",new String[]{oldServer})) {
                if(c.moveToFirst())throw new IllegalStateException("旧地址有已提交待确认记录，不能迁移；请选择仅后续扫码，旧批仍保留原地址");
            }
            for(String operation:new String[]{"return","inbound"}) {
                String sourceId=activeBatchId(db,operation,oldServer);
                if(sourceId==null)continue;
                Batch source=readBatch(db,sourceId);
                if(!source.editable())throw new IllegalStateException("已提交批次不能迁移服务地址");
                if(source.total==0) {
                    db.delete("batches","id=?",new String[]{sourceId});continue;
                }
                String targetId=activeBatchId(db,operation,newServer);
                if(targetId!=null) {
                    Batch target=readBatch(db,targetId);
                    if(target.total>0||!target.editable())
                        throw new IllegalStateException("新地址已有本业务的未完成批次，不能合并；请先完成该批或选择仅后续扫码");
                    db.delete("batches","id=?",new String[]{targetId});
                }
                ContentValues values=new ContentValues();values.put("server",newServer);
                db.update("batches",values,"id=? AND state='draft'",new String[]{sourceId});
                db.update("scans",values,"batch_id=? AND sent=0",new String[]{sourceId});
            }
            db.setTransactionSuccessful();
        } finally {db.endTransaction();}
    }
}
