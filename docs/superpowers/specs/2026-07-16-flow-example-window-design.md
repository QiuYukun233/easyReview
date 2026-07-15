# 单 example 切窗(flow example window)· 设计

日期:2026-07-16
背景:flow phase(PR #20)真仓验收发现,多 example spec 下每个 example 重建工厂数据,工厂文件在首个分界点之后被再次命中 → 双相判定全归 request,setup 只折出 3/81 步。根治:只跑单个 example,「分界后命中」恢复为纯请求信号。

## 1. 目标

`flow trace spec/xxx_spec.rb:55 --name <名>` 只跑该行 example;setup 段回到应有量级(~40 步级)、request 段短而干净。纯文件形式行为完全不变。

已定决策(用户确认):**同 spec 不同行号共存**(id 含行号,两个 example 的流程可并列对比);同 file:line 重跑覆盖自己。

## 2. CLI 解析(cli-flow.ts)

- specFile 尾部 `:<正整数>` 识别:最后一个冒号切分,数字校验(正整数,`:abc`/`:0` 友好拒绝)。
- 文件部分做 `_spec.rb` 后缀校验与沙箱存在性检查。
- rspec 参数透传**完整 `file:line`**(rspec 原生行号定位)。

## 3. id 与落盘

- id = `flow-<basename>`(无行号,现状不变)/ `flow-<basename>-L<行号>`(有行号)。
- `source.spec` 落盘完整 `file:line`(诚实来源;UI 来源标注自然带行号)。

## 4. serve 与 UI

**双零改动**——多流程列表、phase 折叠、来源标注全部现成。

## 5. 测试计划(预计 +5 条,cli-flow 6→11)

① 行号成功路径:id 带 `-L55`、传给 exec 的参数含 `spec/...:55`、存在性检查用文件部分;② `:abc` 拒绝;③ `:0` 拒绝;④ 无行号回归(id/行为不变);⑤ 同 file:line 重跑覆盖自己、不动同 spec 其它行号的流程。

## 6. 真仓验收

从 messages_controller_spec 挑一个 POST create example 的行号 trace:**setup 段步数显著回升**(核心物证=双相判定语义恢复)、request 段短而干净;与全 spec 版两条流程并存于流程 Tab;真实仓零接触;umwelt 零接触。

## 7. 不做什么

- example 发现辅助(列出 spec 内 example+行号)——用户自己挑行号,打样期够用。
- `--example` 名字过滤(行号已覆盖需求)。
- 多行号批量 trace。
