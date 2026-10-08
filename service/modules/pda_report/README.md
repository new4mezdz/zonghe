# 仓储扫码报表

综合服务首页的“仓储扫码报表”入口位于 `/pda_report/`，查询东集 PDA 和 Windows 读码器上传的扫码记录。页面展示码值、北京时间、设备编号、入库/返回、来源，支持筛选、分页、汇总、每日趋势和 CSV 导出。页面可见时每 10 秒自动刷新，也可手动刷新。

## 部署与 PDA 配置

1. 在运行综合服务的机器上更新代码，按原方式启动或重启 `service/app.py`。模块随综合服务一起监听原端口（默认 5000），无需另开扫码进程。同一地址和端口不要同时运行独立的“扫码统一服务.exe”。
2. 可在 `service/.env` 中配置以下项目，也可设置同名环境变量。配置优先级为 Flask 配置、进程环境变量、`service/.env`、默认值。

   ```dotenv
   WAREHOUSE_API_KEY=
   WAREHOUSE_SCAN_DATA_DIR=D:\ServiceData\WarehouseScan
   ```

   `WAREHOUSE_API_KEY` 是可选共享密钥，最多 256 位无空格 ASCII 字符；启用后 PDA、读码器和报表填写同一密钥。留空仅适合受控内网。配置示例见 `service/.env.example`，修改后重启综合服务。
3. 将现有 `仓库PDA扫码.apk` 安装到东集 PDA，连接能够访问综合服务的现场 Wi-Fi。服务地址填写服务器根地址，例如 `http://10.164.62.212:5000`，不要添加 `/pda_report/` 或 `/api/scans`。服务器需允许现场网段访问该端口。
4. 打开设备自带“扫描工具”并保持后台运行；在 APK 的“服务与扫码设置”中点击“一键配置东集扫码”，保存服务地址及密钥，再点击“测试连接”。如固件不响应一键配置，在设备扫描工具中选择广播输出，Action 为 `com.warehouse.pda.SCAN`，字段名为 `scannerdata`。
5. 选择“入库手动扫码”或“返回手动扫码”，按实体扫码键。PDA 显示“已上传”后，报表应在下一次刷新时出现记录。

APK 上传协议保持不变，无需为本次整合重新打包。设备先保存到本机，断网时保留待传记录；重新联网并打开应用后补传。当前应用没有退出后持续补传的后台服务。存在待传记录时不要卸载应用或清除其数据。

## 数据目录与历史数据

数据库文件为 `scan-events.sqlite3`。未配置目录时，Windows 使用 `%LOCALAPPDATA%\WarehouseScanService`，Linux 使用 `~/.local/share/warehouse-scan-service`，与原独立扫码服务的默认位置相同。扫码数据库默认放在项目外，正式部署建议指定稳定的项目外绝对路径。

如此前运行过独立扫码服务，先停止该服务，再将 `WAREHOUSE_SCAN_DATA_DIR` 指向原数据目录。更换数据目录或运行账号时，需要停服后复制完整原数据目录，包括仍存在的 SQLite WAL 文件，再启动综合服务。已确认上传的记录不会由 PDA 自动重传到新数据库。备份也应先停服，再复制整个目录。

## 兼容接口与统计口径

| 接口 | 用途 |
| --- | --- |
| `GET /api/health` | PDA 连接检查，返回 `service=warehouse-scan`、`api_version=1` 和 `auth_required` |
| `POST /api/scans` | 保存扫码事件；首次返回 201，相同事件重试返回 200 |
| `GET /api/report` | 筛选、分页、汇总及每日趋势 |
| `GET /api/export.csv` | 导出当前筛选范围，UTF-8 BOM 编码 |

除健康检查外，启用密钥后上述 API 均要求 `X-API-Key`。上传 JSON 保留 `event_id`、`barcode`、`source`（`pda`/`reader`）、`operation`（`inbound`/`return`）、`scanned_at`（含时区）和 `device_id`，可选 `reader_host`、`reader_port`。单次请求正文不超过 2 MiB。服务确认包含 `ok`、原 `event_id`、正整数 `id` 及布尔值 `duplicate`。

筛选参数为 `keyword`、`start_date`、`end_date`、`source`、`operation`；分页使用 `page` 和 `page_size`（1–200）。日期首尾均包含，按北京时间统计，趋势展示最近 31 个有记录日期。CSV 单次最多 100000 条，码值内容总量最多 32 MiB，超限时缩小筛选范围。

每次实际扫码生成一个 UUID，网络重试复用同一个 UUID，不重复计数；同 UUID 内容不同返回 409。同一码重新扫描是新事件，会再次计数。返回记录单独统计，不冲减入库次数，不计算实时库存。

## 验证约定

测试脚本、临时数据库、缓存、截图和结果均放在项目目录之外。接口验证可用独立 Flask 应用注册 `pda_report_bp`，通过 Flask 配置 `WAREHOUSE_SCAN_DATA_DIR` 指向外部临时目录；无需启动包含其他现场设备连接的完整综合服务。正式使用前需以真实 PDA 验证 Wi-Fi 可达性、扫码广播和上传结果。
