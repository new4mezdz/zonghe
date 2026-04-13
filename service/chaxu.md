---
name: shift-record
description: 查询并总结工艺交接班记录，导出Excel并调用AI分析。当用户提到"总结交接班记录"、"某天/某段时间的交接班情况"、"最近交接班有什么问题"、"各班次上报了什么"、"工艺问题统计"、"交接班分析"等类似表述时触发此skill。即使用户只说"今天工艺有什么问题"、"上周交接班情况怎么样"、"甲班/乙班/丙班出了什么故障"，也应触发。
---

# 工艺交接班记录系统

查询内部工艺交接班记录，导出Excel，并调用AI进行智能分析总结。

## 系统信息

- 基础URL: `http://10.164.62.213/lowcode`
- 查询接口: `GET /data/?start_date={YYYY-MM-DD}&end_date={YYYY-MM-DD}`
- 登录账号: admin / asdqwe#@!890（如需认证时使用）
- 该系统仅在内网可访问

## 接口返回格式

```json
{
  "status": "success",
  "data": [
    {
      "id": 2560,
      "shift": "甲班/乙班/丙班",
      "upload_time": "2026-03-26 14:00:15",
      "area": "封装区/卷接包区",
      "machine": "GD9#/PT8#/封箱机1#",
      "detail": "问题描述...",
      "status": "已解决/已处理待观察",
      "reporter": "上报人姓名",
      "images": "[\"图片URL\"]"
    }
  ],
  "shift_stats": { "甲班": 7, "乙班": 5, "丙班": 3 },
  "msg": "筛选成功，共查询到 15 条数据"
}
```

## 操作步骤

### 1. 确定日期范围

- 用户指定了日期 → 直接使用
- 用户说"今天" → start_date 和 end_date 均为今天
- 用户说"最近一周" → start_date 为7天前，end_date 为今天
- 用户未指定日期 → 默认查询今天

日期格式必须为 `YYYY-MM-DD`。

### 2. 查询记录

使用 curl 调用接口获取数据：

```bash
curl -s "http://10.164.62.213/lowcode/data/?start_date=2026-03-24&end_date=2026-03-30"
```

### 3. 筛选数据

接口返回全部数据后，根据用户需求在本地过滤：

- **按班次筛选**: 过滤 `shift` 字段（甲班/乙班/丙班）
- **按状态筛选**: 过滤 `status` 字段（已解决/已处理待观察）
- **按区域筛选**: 过滤 `area` 字段（封装区/卷接包区）
- **按机台筛选**: 过滤 `machine` 字段

### 4. 导出Excel

将筛选后的数据用 Python + openpyxl 写入 Excel 文件，保存到 `/mnt/user-data/outputs/交接班记录.xlsx`。

Excel包含以下列：班次、上传时间、区域、机台号、问题详情、状态、上报人。

格式要求：
- 表头加粗，带浅蓝色背景填充
- 列宽自适应内容
- 使用 Arial 字体

导出后将文件呈现给用户下载。

### 5. AI分析总结

将查询到的数据整理为文本，调用 Anthropic API 进行分析总结。

调用方式：

```python
import requests, json

response = requests.post(
    "https://api.anthropic.com/v1/messages",
    headers={"Content-Type": "application/json"},
    json={
        "model": "claude-sonnet-4-20250514",
        "max_tokens": 2000,
        "messages": [
            {
                "role": "user",
                "content": f"请对以下工艺交接班记录数据进行分析总结：\n{data_text}\n\n请包含：1.各班次问题数量对比 2.高频故障机台排名 3.未解决问题汇总 4.整体趋势和改善建议"
            }
        ]
    }
)
result = response.json()
summary = result["content"][0]["text"]
```

将AI分析结果展示给用户。

### 6. 输出格式

最终给用户呈现两部分内容：

**第一部分：Excel文件**
提供下载链接，用户可查看完整记录明细。

**第二部分：AI分析报告**
以文字形式展示分析结论，包括：
- 各班次问题数量对比
- 高频故障机台排名
- 未解决问题汇总
- 整体趋势和改善建议

## 注意事项

- images 字段是 JSON 字符串数组，包含图片链接，如用户需要可提供链接
- 如果接口返回了 `shift_stats`，优先使用该字段做班次统计，无需手动计算
- 该系统仅在内网（10.164.62.213）可访问，确保运行环境可达内网