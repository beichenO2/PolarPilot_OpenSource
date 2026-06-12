# Workflow: 知识库研究

## 框图
+------------------+     +------------------+
| [S1] 文献调研     | --> | [S2] 方法验证     |
+------------------+     +------------------+
        |                        |
        v                        v
+------------------+     +------------------+
| [S1a] 关键论文提取 |   | [S2a] 实验执行    |
+------------------+     +------------------+
        |                        |
        +------------------------+
                                 |
                                 v
                        +------------------+
                        | [END] 交付       |
                        +------------------+

## 步骤定义
[S1]: 文献调研
  type: research
  agent: qwen3:0.6b
  input: topic, keywords
  output: key_papers, gaps
  timeout: 30m

[S1a]: 关键论文提取
  type: extraction
  agent: qwen3:0.6b
  input: S1.output
  output: paper_list.json

[S2]: 方法验证
  type: design
  agent: qwen3:0.6b
  input: S1a.output, S1.output.gaps
  output: method_spec.md
  on_failure: retry(S2, max=3)

[S2a]: 实验执行
  type: experiment
  agent: qwen3:0.6b
  input: S2.output
  output: results.json
  leaf_test: echo "pass"

[END]: 交付
  type: terminal
  deliverables: paper_list.json, results.json
