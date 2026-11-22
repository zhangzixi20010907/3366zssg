# 乌林遗迹（ui.swf 美术 + wulin_classes.swf 逻辑）

架构：

- **ui.swf**：所有美术资源
  - `uiSkin_Map` 里的入口按钮 `_wulinBtn` 复用成都副本入口按钮(61172)的整块建筑图（char 61330），SymbolClass -> `game.ui.WulinEntryButton`；类里加“乌林遗迹”标签
  - `uiSkin_bigMap_wulin`：复制自 `uiSkin_bigMap`，替换为乌林大地图背景（大地图2.png），9 个建筑入口按紫色点重新摆位，SymbolClass -> `game.ui.SkinBigMapWulin`
  - 第 10 个入口 `_wulin10Btn`：符号内叠了 9 个大地图建筑图形，SymbolClass -> `game.ui.Wulin10Button`
- **wulin_classes.swf**（约 17KB）：只有逻辑类，没有美术
  - `game.ui.bigmap_wulin`、`game.ui.WulinEntryButton`、`game.ui.SkinBigMapWulin`、`game.ui.Wulin10Button`、`game.fuben.WulinBossGate`
  - 通过 `game.xml` 以 `context="own"` 加载到主域，并排在 `ui.swf` 之前
- **main.swf 不改**。

> 为什么不是把类合并进 main.swf：实测把编译好的 DoABC 追加到 main.swf（或 FFDec abcmerge）后，
> FFDec 能看到类，但运行时 AVM 不会初始化后追加的 script，`getDefinitionByName` 全部返回未定义；
> 最小 SWF 的合并测试正常，main.swf 这种 200+ script 的大 ABC 不稳定。因此保留一个小逻辑 SWF，
> 所有 UI 美术仍在 ui.swf，避免改动 main.swf 带来的运行风险。

## 编译逻辑类

```bash
# main.swf -> 编译期 SWC
ffdec -swf2swc main.swc main.swf

mxmlc -source-path=src src/game/wulin/ClassesMain.as \
  -output wulin_classes.swf \
  -target-player=11.1 -swf-version=14 \
  -static-link-runtime-shared-libraries=true \
  -compiler.external-library-path+=main.swc \
  -debug=false -use-network=false
```

> 文档类必须是中性的 `game.wulin.ClassesMain`，不能是 `WulinEntryButton`：否则会把 `WulinEntryButton` 的符号绑定到本 SWF 的空主时间线，覆盖 ui.swf 入口按钮的美术，导致 Map 上入口按钮不可见。

## game.xml

```xml
<SWFLoader url="wulin_classes.swf" name="game01.wulin_classes" load="true" autoPlay="false" context="own"/>
<SWFLoader url="ui.swf" ... />
```

## 生成 ui.swf 美术

```bash
ffdec -swf2xml ui.swf ui.xml
python tools/build_ui_wulin_v2.py ui.xml ui_wulin.xml
ffdec -xml2swf ui_wulin.xml ui_wulin.swf
```

`build_ui_wulin_v2.py` 会：

- 把 `tools/wulin_map.png` 内嵌为 DefineBitsLossless2（已用 `tools/clean_map_dots_v2.py` 去掉紫点）；入口按钮直接复制 ui.swf 里的 61172 按钮精灵
- 生成入口按钮，放进 `uiSkin_Map`
- 复制 `uiSkin_bigMap` 为 `uiSkin_bigMap_wulin`（新背景 + 紫点位置 + 第10入口）
- 追加 SymbolClass：
  - `61330 -> game.ui.WulinEntryButton`
  - `61310 -> game.ui.SkinBigMapWulin`
  - `61311 -> game.ui.Wulin10Button`

## 部署

客户端根目录：
- `main.swf`（原服务端 main，未改）
- `ui.swf`（乌林美术）
- `wulin_classes.swf`（逻辑类）
- `game.xml`（加载 wulin_classes.swf）
- `stage.xml`（part=12）

服务端：
- `server/game.js` part=12
- `stage.xml`

备份：`main.swf.bak-wulin-art-*`、`ui.swf.bak-wulin-art-*`、`game.xml.bak-wulin-art-*`
