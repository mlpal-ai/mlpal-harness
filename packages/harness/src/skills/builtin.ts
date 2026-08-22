import type { Skill } from "./skills";

/**
 * Built-in skills, embedded as strings so they ship inside the compiled binary.
 * User skills in ~/.yodex/skills or ./.yodex/skills override these by name.
 */

const DOCX: Skill = {
  name: "docx",
  description: "Create and edit Microsoft Word (.docx) documents",
  source: "builtin",
  body: `# Creating Word documents (.docx)

Use Python with the \`python-docx\` library to create .docx files.

## Setup
Ensure the library is installed (install it if the import fails):
\`\`\`bash
python3 -c "import docx" 2>/dev/null || pip3 install --quiet python-docx
\`\`\`

## Build the document
Write a Python script, then run it with Bash:
\`\`\`python
from docx import Document
from docx.shared import Pt

doc = Document()
doc.add_heading("Document Title", level=0)        # title
doc.add_heading("Introduction", level=1)          # section heading
doc.add_paragraph("A normal paragraph of body text.")
doc.add_paragraph("A bulleted item", style="List Bullet")
doc.add_paragraph("A numbered item", style="List Number")

# bold / italic runs
p = doc.add_paragraph()
p.add_run("Bold text").bold = True
p.add_run(" and ").italic = False
p.add_run("italic text").italic = True

# a table
table = doc.add_table(rows=1, cols=2)
table.style = "Light Grid Accent 1"
hdr = table.rows[0].cells
hdr[0].text, hdr[1].text = "Name", "Value"
row = table.add_row().cells
row[0].text, row[1].text = "Example", "123"

doc.save("output.docx")
print("wrote output.docx")
\`\`\`

## Verify
After running, confirm the file exists (\`ls -la *.docx\`). Use a descriptive filename based on the document's content, not "output.docx".

## Headings & structure
- \`level=0\` is the title; \`level=1..9\` are nested section headings.
- Use \`List Bullet\` / \`List Number\` styles for lists.
- Keep formatting clean and professional unless asked otherwise.

## Reading an existing .docx
The Read tool does not parse .docx (it is a binary zip). Extract its text with python-docx:
\`\`\`python
from docx import Document
doc = Document("input.docx")
for p in doc.paragraphs:
    print(p.text)
for t in doc.tables:
    for row in t.rows:
        print(" | ".join(c.text for c in row.cells))
\`\`\`
Run it with Bash and read the printed text.`,
};

export const BUILTIN_SKILLS: Skill[] = [DOCX];
