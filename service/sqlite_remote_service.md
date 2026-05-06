# SQLite 远程访问服务

这个服务用于把本机的 SQLite 数据库通过 HTTP API 暴露给局域网或其他远程客户端访问。

## 启动

先设置环境变量：

```powershell
$env:SQLITE_REMOTE_API_TOKEN="请改成你自己的访问令牌"
$env:SQLITE_REMOTE_DB_PATH="F:\python\zonghe\service\urldata.db"
$env:SQLITE_REMOTE_HOST="0.0.0.0"
$env:SQLITE_REMOTE_PORT="5004"
$env:SQLITE_REMOTE_READ_ONLY="1"
python service\run_sqlite_remote.py
```

默认是只读模式。

如果你确定需要远程写入，再额外开启：

```powershell
$env:SQLITE_REMOTE_READ_ONLY="0"
$env:SQLITE_REMOTE_ENABLE_WRITE="1"
```

## 主要接口

- `GET /sqlite-remote`
- `GET /api/sqlite/health`
- `GET /api/sqlite/tables`
- `GET /api/sqlite/schema/<table_name>`
- `GET /api/sqlite/table/<table_name>/rows?limit=100&offset=0&order_by=id&order=desc`
- `POST /api/sqlite/query`
- `POST /api/sqlite/execute`

请求头需要携带：

```text
X-API-Token: 你的令牌
```

## 调用示例

查询表列表：

```powershell
Invoke-RestMethod `
  -Uri "http://127.0.0.1:5004/api/sqlite/tables" `
  -Headers @{ "X-API-Token" = "请改成你自己的访问令牌" }
```

执行只读 SQL：

```powershell
$body = @{
  sql = "SELECT id, content, record_time FROM records ORDER BY id DESC"
  limit = 20
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:5004/api/sqlite/query" `
  -Headers @{ "X-API-Token" = "请改成你自己的访问令牌" } `
  -ContentType "application/json" `
  -Body $body
```

## 环境变量

- `SQLITE_REMOTE_API_TOKEN`: 访问令牌，建议必填
- `SQLITE_REMOTE_DB_PATH`: SQLite 文件路径，默认是当前 `service` 目录下的 `urldata.db`
- `SQLITE_REMOTE_HOST`: 监听地址，默认 `0.0.0.0`
- `SQLITE_REMOTE_PORT`: 监听端口，默认 `5004`
- `SQLITE_REMOTE_READ_ONLY`: 是否只读，默认 `1`
- `SQLITE_REMOTE_ENABLE_WRITE`: 是否允许写入接口，默认 `0`
- `SQLITE_REMOTE_MAX_ROWS`: 单次最大返回行数，默认 `500`
- `SQLITE_REMOTE_ALLOW_ANONYMOUS`: 是否允许匿名访问，默认 `0`
