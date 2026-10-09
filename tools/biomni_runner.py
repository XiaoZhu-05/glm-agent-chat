# -*- coding: utf-8 -*-
"""Biomni 桥接脚本（由 server.js 以子进程方式调用，沙箱隔离）

用法：python biomni_runner.py < stdin: JSON 配置
  {task, model, baseUrl, apiKey}
输出：stdout = Biomni ReAct 过程日志 + 最后的 ===BIOMNI_RESULT=== 标记与结果
安全：cwd 锁定在服务端指定的沙箱目录；expected_data_lake_files=[] 跳过 11GB 数据湖
"""
import io
import json
import os
import sys


def main():
    cfg = json.loads(sys.stdin.read())
    # cwd 已由父进程设为沙箱目录；A1(path=".") 会在其下建 biomni_data/
    from biomni.agent import A1

    agent = A1(
        path=".",
        llm=cfg["model"],
        base_url=cfg["baseUrl"],
        api_key=cfg["apiKey"],
        expected_data_lake_files=[],   # 跳过 11GB 数据湖下载
        use_tool_retriever=False,      # 不依赖 OpenAI embedding key
    )
    result = agent.go(cfg["task"])
    print("\n===BIOMNI_RESULT===")
    if result is None:
        print("(agent 未返回最终答案，请查看上方过程日志)")
    else:
        print(result)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"\n===BIOMNI_ERROR===\n{type(e).__name__}: {e}", file=sys.stdout)
        sys.exit(1)
