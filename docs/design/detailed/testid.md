---
id: TESTID
kind: detailed
status: review
title: テストID採番 詳細設計
traces: [BD-VIEWER]
---

# テストID採番 詳細設計

## 構造

```mermaid id=class
classDiagram
  class Graph {
    +type: state | flow
    +nodes: GraphNode[]
    +edges: GraphEdge[]
  }
  class TestCase {
    +kind: P | T | S | X
    +signature: string
    +nodes: string[]
    +edges: number[]
  }
  class LockDiagram {
    +doc: string
    +diagram: string
    +next: Record~kind, number~
    +cases: Record~signature, LockCase~
  }
  class LockCase {
    +id: string
    +kind: string
    +status: active | retired
  }
  Graph ..> TestCase : generateMatrix()
  LockDiagram "1" *-- "*" LockCase
  TestCase ..> LockCase : assignIds()
```

## 採番

参照：:ref[../basic/viewer.md#データ]

```mermaid id=assign-seq
sequenceDiagram
  participant CLI as ddv-testid generate
  participant M as generateAll
  participant G as graph
  participant L as assignIds
  CLI->>M: repo, config
  M->>G: parseMermaidGraph(code)
  G-->>M: Graph
  M->>G: generateMatrix(graph, nSwitch, loopLimit)
  G-->>M: TestCase[]
  M->>L: assignIds(lockEntry, code, cases)
  L-->>M: 採番済みケース, 欠番
  M->>CLI: .ddv/testids.lock.json を更新
```

- ID 形式：`{REQ|BD|DD}-{文書ID}-{図の略号}-{P|T|S|X}{連番3桁}`
- 連番は種別ごとに `next` から払い出し、欠番は再利用しない

## テストIDの状態

```mermaid id=lock-case code=LOCK matrix nswitch=0
stateDiagram-v2
  [*] --> 有効
  有効 --> 有効 : 再生成 [経路あり]
  有効 --> 欠番 : 再生成 [経路なし]
  欠番 --> 有効 : 再生成 [経路あり]
  欠番 --> 欠番 : 再生成 [経路なし]
```

- 有効になるとき：新しい経路は種別ごとの末尾番号、復活した経路は元の番号
