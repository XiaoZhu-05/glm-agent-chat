# -*- coding: utf-8 -*-
"""PDF 文本提取（服务端调用）：python extract_pdf.py <file> [max_pages]
输出单行 JSON：{ok, pages, extracted_pages, truncated, has_text, text, warning?, error?}
"""
import sys
import json

try:
    from pypdf import PdfReader
except ImportError:
    print(json.dumps({"ok": False, "error": "服务器缺少 pypdf 库（pip install pypdf）"}, ensure_ascii=False))
    sys.exit(0)


def main():
    path = sys.argv[1]
    max_pages = int(sys.argv[2]) if len(sys.argv) > 2 else 30
    try:
        reader = PdfReader(path)
        if getattr(reader, "is_encrypted", False):
            try:
                reader.decrypt("")
            except Exception:
                print(json.dumps({"ok": False, "error": "PDF 已加密，无法读取。请提供未加密版本。"}, ensure_ascii=False))
                return
        total = len(reader.pages)
        texts = []
        for i, page in enumerate(reader.pages[:max_pages]):
            try:
                texts.append(page.extract_text() or "")
            except Exception as e:  # 单页失败不影响整体
                texts.append(f"[第 {i + 1} 页提取失败：{e}]")
        joined = "".join(texts).strip()
        has_text = len(joined) >= 20
        out = {
            "ok": True,
            "pages": total,
            "extracted_pages": min(total, max_pages),
            "truncated": total > max_pages,
            "has_text": has_text,
            "text": "\n\n".join(f"--- 第 {i + 1} 页 ---\n{t}" for i, t in enumerate(texts)),
        }
        if not has_text:
            out["warning"] = (
                "未能提取到文本层：该 PDF 很可能是扫描件/纯图片。"
                "本项目未内置 OCR，无法读取其中的文字内容；如需处理请先在本地做 OCR 或提供文本版。"
            )
        print(json.dumps(out, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"PDF 解析失败：{e}"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
