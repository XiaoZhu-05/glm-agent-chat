# -*- coding: utf-8 -*-
"""生成功能验证测试夹具 → tests/fixtures/
- img_test.png / img_test.jpg / img_test.webp：画有文字的测试图
- sample_text.pdf：带文本层的 PDF（3 页）
- sample_scanned.pdf：无文本层的"扫描件"（纯图片页）
- sample.xlsx：多 sheet + 公式 + 合并单元格
- sample.fasta：3 条序列带 > 注释
"""
import os
import sys

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
os.makedirs(OUT, exist_ok=True)

# ---------- 图片 ----------
from PIL import Image, ImageDraw, ImageFont

FONT = ImageFont.load_default(size=48)

def make_img(fmt, text, bg):
    img = Image.new("RGB", (640, 200), bg)
    d = ImageDraw.Draw(img)
    d.text((24, 70), text, font=FONT, fill=(255, 255, 255))
    p = os.path.join(OUT, f"img_test.{fmt}")
    img.save(p, fmt.upper() if fmt != "jpg" else "JPEG")
    return p

make_img("png", "PNG-TEST-2026", (46, 108, 240))
make_img("jpg", "JPG-TEST-2026", (34, 120, 60))
make_img("webp", "WEBP-TEST-2026", (190, 60, 60))

# ---------- PDF ----------
from pypdf import PdfWriter, PdfReader, PageObject
from pypdf.generic import (
    RectangleObject, NameObject, DictionaryObject, ArrayObject, DecodedStreamObject, NumberObject,
)


def make_stream(data):
    s = DecodedStreamObject()
    s.set_data(data)
    return s


# 文本版：内容流用基础 Helvetica 字体绘制文字
def text_pdf():
    w = PdfWriter()
    for line in ["Hello GLM Agent Chat.", "Functional verification page 2.", "ZhiPu BigModel GLM-5.3 API."]:
        contents = f"BT /F1 18 Tf 72 720 Td ({line}) Tj ET".encode()
        page = PageObject.create_blank_page(width=612, height=792)
        font = w._add_object(DictionaryObject({
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }))
        res = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})})
        stream = w._add_object(make_stream(contents))
        page[NameObject("/Resources")] = res
        page[NameObject("/Contents")] = stream
        w.add_page(page)
    w.write(os.path.join(OUT, "sample_text.pdf"))


text_pdf()

# 扫描件：把 PNG 页作为整页图片（无文本层）
def scanned_pdf():
    import zlib

    def png_data(path):
        img = Image.open(path).convert("RGB")
        raw = b"".join(b"\x00" + bytes(px) for px in img.getdata())
        return img.size, zlib.compress(raw)

    (wpx, hpx), idat = png_data(os.path.join(OUT, "img_test.png"))
    w = PdfWriter()
    sw, sh = 612, 792
    content = f"q {sw} 0 0 {sh} 0 0 cm /Im0 Do Q".encode()
    page = PageObject.create_blank_page(width=sw, height=sh)
    img_stream = make_stream(idat)
    img_stream[NameObject("/Type")] = NameObject("/XObject")
    img_stream[NameObject("/Subtype")] = NameObject("/Image")
    img_stream[NameObject("/Width")] = NumberObject(wpx)
    img_stream[NameObject("/Height")] = NumberObject(hpx)
    img_stream[NameObject("/ColorSpace")] = NameObject("/DeviceRGB")
    img_stream[NameObject("/BitsPerComponent")] = NumberObject(8)
    img_stream[NameObject("/Filter")] = NameObject("/FlateDecode")
    img_obj = w._add_object(img_stream)
    xobj = DictionaryObject({NameObject("/Im0"): img_obj})
    res = DictionaryObject({NameObject("/XObject"): xobj})
    stream = w._add_object(make_stream(content))
    page[NameObject("/Resources")] = res
    page[NameObject("/Contents")] = stream
    w.add_page(page)
    w.write(os.path.join(OUT, "sample_scanned.pdf"))


scanned_pdf()

# 验证两个 PDF 可读
r1 = PdfReader(os.path.join(OUT, "sample_text.pdf"))
assert len(r1.pages) == 3 and "GLM" in (r1.pages[0].extract_text() or ""), "text pdf fixture broken"
r2 = PdfReader(os.path.join(OUT, "sample_scanned.pdf"))
assert len((r2.pages[0].extract_text() or "").strip()) == 0, "scanned pdf should have no text layer"

# ---------- Excel ----------
import openpyxl

wb = openpyxl.Workbook()
ws1 = wb.active
ws1.title = "销售"
ws1.append(["月份", "销量", "单价", "金额(公式=C*D)"])
ws1.append(["1月", 120, 29.9, "=B2*C2"])
ws1.append(["2月", 150, 29.9, "=B3*C3"])
ws1["A5"] = "合计"
ws1["D5"] = "=SUM(D2:D3)"
ws1.merge_cells("A7:B7")
ws1["A7"] = "合并单元格测试"
ws2 = wb.create_sheet("库存")
ws2.append(["SKU", "数量"])
ws2.append(["A-001", 42])
ws2.append(["A-002", 17])
wb.save(os.path.join(OUT, "sample.xlsx"))

# ---------- FASTA ----------
with open(os.path.join(OUT, "sample.fasta"), "w") as f:
    f.write(">seq1 human beta-globin fragment\nMVHLTPEEKSAVTALWGKVNVDEVGGEALGRLLVVYPWTQRFF\n")
    f.write(">seq2 mouse beta-globin fragment\nMVHLTDAEKAAVTSLWGKVNVDGGEALGRLLVVYPWTQRLF\n\n")
    f.write(">seq3 synthetic GC-rich\nGCGCGCGCAAAGCGCGCGTTAGCGCGCGCAAGCGCGC\n")

print("fixtures ready:")
for f_ in sorted(os.listdir(OUT)):
    print(" -", f_, os.path.getsize(os.path.join(OUT, f_)), "bytes")
