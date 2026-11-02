"""Optional acceptance fixtures: pip install python-docx openpyxl python-pptx."""
from pathlib import Path
import sys
from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches
from openpyxl import Workbook
from pptx import Presentation

root = Path(sys.argv[1] if len(sys.argv) > 1 else "output/preview-fixtures")
root.mkdir(parents=True, exist_ok=True)
external = sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:9/external"
(root / "report.md").write_text(
    "# Markdown acceptance\n\n"
    "A compiled preview keeps **strong text**, `inline code`, and [the status link](./status.json).\n\n"
    "| Item | Result |\n| --- | --- |\n| Synthetic | Passed |\n\n"
    "```ts\nconst ready = true;\n```\n",
    encoding="utf-8",
)
(root / "status.json").write_text('{"ready": true}\n', encoding="utf-8")
doc = Document()
section = doc.sections[0]
section.top_margin = section.bottom_margin = Inches(1)
section.left_margin = section.right_margin = Inches(1)
doc.add_heading("Document acceptance", 0)
doc.add_paragraph("PAGE ONE: report, table and original download.")
doc.add_paragraph("\u6587\u6863\u9884\u89c8\u9a8c\u6536\uff1a\u4e2d\u6587\u6b63\u6587\u4e0e\u8868\u683c\u3002")
table = doc.add_table(rows=2, cols=2)
for row, values in zip(table.rows, [("Item", "Result"), ("Synthetic", "Passed")]):
    for cell, value in zip(row.cells, values):
        cell.text = value
doc.add_page_break()
doc.add_heading("PAGE TWO", 1)
doc.add_paragraph("Second page for navigation and copy acceptance.")
doc.save(root / "report.docx")
linked = Document()
linked.add_paragraph("External linked content must not be refreshed.")
field = OxmlElement("w:fldSimple")
field.set(qn("w:instr"), f'INCLUDETEXT "{external}"')
linked.paragraphs[0]._p.append(field)
linked.save(root / "external.docx")
book = Workbook()
book.active.title = "Summary"
book.active.append(["Quarter", "Revenue"])
book.active.append(["Q1", 125])
book.active.append(["Q2", 180])
book.create_sheet("Details").append(["SECOND SHEET", 305])
book.save(root / "workbook.xlsx")
slides = Presentation()
for title, body in [("SLIDE ONE", "Presentation acceptance"), ("SLIDE TWO", "Second slide content")]:
    slide = slides.slides.add_slide(slides.slide_layouts[1])
    slide.shapes.title.text = title
    slide.placeholders[1].text = body
slides.save(root / "slides.pptx")
(root / "broken.docx").write_bytes(b"not a valid office document\x00")
print(root.resolve())
