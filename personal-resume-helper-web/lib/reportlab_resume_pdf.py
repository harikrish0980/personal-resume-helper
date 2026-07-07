import json
import re
import sys

from reportlab.lib.pagesizes import LETTER
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas


PAGE_W, PAGE_H = LETTER


def clean(text):
    text = "" if text is None else str(text)
    replacements = {
        "\u2013": "-",
        "\u2014": "-",
        "\u2018": "'",
        "\u2019": "'",
        "\u201c": '"',
        "\u201d": '"',
        "\u2022": "-",
        "\xa0": " ",
    }
    for src, dst in replacements.items():
        text = text.replace(src, dst)
    text = text.replace("**", "")
    return re.sub(r"\s+", " ", text).strip()


def split_skill(line):
    line = clean(line)
    if ":" not in line:
        return "", line
    category, values = line.split(":", 1)
    return clean(category), clean(values)


def wrap_text(text, font, size, max_width):
    words = clean(text).split()
    if not words:
        return []
    lines = []
    current = words[0]
    for word in words[1:]:
        candidate = f"{current} {word}"
        if stringWidth(candidate, font, size) <= max_width:
            current = candidate
        else:
            lines.append(current)
            current = word
    lines.append(current)
    return lines


class ResumeCanvas:
    def __init__(self, path, one_page=False, scale=1.0):
        self.path = path
        self.one_page = one_page
        self.scale = scale
        self.c = canvas.Canvas(path, pagesize=LETTER)
        self.margin_x = 26 if one_page else 36
        self.margin_top = 52 if one_page else 54
        self.margin_bottom = 20 if one_page else 36
        self.y = PAGE_H - self.margin_top
        self.page_count = 1

    def size(self, value):
        return value * self.scale

    def line_height(self, value):
        return value * self.scale

    def ensure_space(self, height):
        if self.one_page:
            return self.y - height >= self.margin_bottom
        if self.y - height < self.margin_bottom:
            self.c.showPage()
            self.page_count += 1
            self.y = PAGE_H - self.margin_top
        return True

    def text(self, value, x, y=None, font="Helvetica", size=8.5, bold=False):
        if y is None:
            y = self.y
        self.c.setFont("Helvetica-Bold" if bold else font, self.size(size))
        self.c.drawString(x, y, clean(value))

    def centered(self, value, y=None, font="Helvetica", size=8.5, bold=False):
        if y is None:
            y = self.y
        font_name = "Helvetica-Bold" if bold else font
        self.c.setFont(font_name, self.size(size))
        text = clean(value)
        width = stringWidth(text, font_name, self.size(size))
        self.c.drawString((PAGE_W - width) / 2, y, text)

    def right(self, value, y=None, font="Helvetica", size=8.3, bold=False):
        if y is None:
            y = self.y
        font_name = "Helvetica-Bold" if bold else font
        self.c.setFont(font_name, self.size(size))
        text = clean(value)
        width = stringWidth(text, font_name, self.size(size))
        self.c.drawString(PAGE_W - self.margin_x - width, y, text)

    def section(self, title):
        self.ensure_space(self.line_height(18))
        self.y -= self.line_height(4)
        self.c.setFont("Helvetica-Bold", self.size(9.4))
        self.c.drawString(self.margin_x, self.y, clean(title).upper())
        self.y -= self.line_height(3)
        self.c.setLineWidth(0.6)
        self.c.line(self.margin_x, self.y, PAGE_W - self.margin_x, self.y)
        self.y -= self.line_height(7)

    def paragraph(self, text, size=8.1, leading=9.3):
        max_width = PAGE_W - (2 * self.margin_x)
        lines = wrap_text(text, "Helvetica", self.size(size), max_width)
        self.ensure_space(len(lines) * self.line_height(leading))
        self.c.setFont("Helvetica", self.size(size))
        for line in lines:
            if not self.ensure_space(self.line_height(leading)):
                break
            self.c.drawString(self.margin_x, self.y, line)
            self.y -= self.line_height(leading)

    def bullet(self, text, size=7.8, leading=8.7):
        max_width = PAGE_W - (2 * self.margin_x) - 13
        lines = wrap_text(text, "Helvetica", self.size(size), max_width)
        if not lines:
            return
        height = max(1, len(lines)) * self.line_height(leading)
        if not self.ensure_space(height):
            return
        self.c.setFont("Helvetica", self.size(size))
        dot_radius = max(0.9, self.size(size) * 0.13)
        self.c.circle(self.margin_x + 6, self.y + self.size(size) * 0.36, dot_radius, stroke=0, fill=1)
        self.c.drawString(self.margin_x + 13, self.y, lines[0])
        self.y -= self.line_height(leading)
        for line in lines[1:]:
            if not self.ensure_space(self.line_height(leading)):
                break
            self.c.drawString(self.margin_x + 13, self.y, line)
            self.y -= self.line_height(leading)

    def save(self):
        self.c.save()


def render(model, out_path, scale=1.0, trim_one_page=False):
    one_page = model.get("mode") == "one_page"
    doc = ResumeCanvas(out_path, one_page=one_page, scale=scale)
    name = clean(model.get("name") or "Candidate Name")
    doc.centered(name, font="Times-Bold", size=20 if one_page else 16, bold=False)
    doc.y -= doc.line_height(12)

    contact = [clean(item) for item in model.get("contact", []) if clean(item)]
    if contact:
        doc.centered("  |  ".join(contact), size=7.4 if one_page else 8.2)
        doc.y -= doc.line_height(10 if one_page else 11)

    doc.section("Summary")
    doc.paragraph(model.get("summary", ""), size=7.8 if one_page else 8.5, leading=8.8 if one_page else 9.8)

    skills = [clean(line) for line in model.get("skills", []) if clean(line)]
    if skills:
        doc.section("Technical Skills" if one_page else "Skills")
        for line in skills[:6 if one_page else len(skills)]:
            category, values = split_skill(line)
            if category:
                label = f"{category}:"
                doc.c.setFont("Helvetica-Bold", doc.size(7.6 if one_page else 8.1))
                doc.c.drawString(doc.margin_x, doc.y, label)
                offset = stringWidth(label + " ", "Helvetica-Bold", doc.size(7.6 if one_page else 8.1))
                max_width = PAGE_W - (2 * doc.margin_x) - offset
                lines = wrap_text(values, "Helvetica", doc.size(7.6 if one_page else 8.1), max_width)
                doc.c.setFont("Helvetica", doc.size(7.6 if one_page else 8.1))
                if lines:
                    doc.c.drawString(doc.margin_x + offset, doc.y, lines[0])
                    doc.y -= doc.line_height(8.4 if one_page else 9.3)
                    for cont in lines[1:]:
                        doc.c.drawString(doc.margin_x + offset, doc.y, cont)
                        doc.y -= doc.line_height(8.4 if one_page else 9.3)
            else:
                doc.paragraph(line, size=7.6 if one_page else 8.1, leading=8.4 if one_page else 9.3)

    experience = model.get("experience", [])
    if experience:
        doc.section("Work Experience")
        for job in experience:
            company = clean(job.get("company", ""))
            period = clean(job.get("period", ""))
            role_line = " | ".join([clean(job.get("role", "")), clean(job.get("location", ""))]).strip(" |")
            doc.ensure_space(doc.line_height(24))
            if one_page:
                doc.text(company, doc.margin_x, size=8.2, bold=True)
                if period:
                    doc.right(period, size=7.8)
                doc.y -= doc.line_height(9.2)
                if role_line:
                    doc.text(role_line, doc.margin_x, font="Helvetica-Oblique", size=7.7)
                    doc.y -= doc.line_height(8.8)
            else:
                left = " | ".join([item for item in [company, role_line] if item])
                doc.text(left, doc.margin_x, size=8.6, bold=True)
                if period:
                    doc.right(period, size=8.3)
                doc.y -= doc.line_height(10.0)
            for bullet in job.get("bullets", []):
                doc.bullet(bullet, size=7.35 if one_page else 8.0, leading=8.0 if one_page else 9.2)
            doc.y -= doc.line_height(1.5)

    projects = model.get("projects", [])
    if projects:
        doc.section("Project" if len(projects) == 1 else "Projects")
        for project in projects:
            title = clean(project.get("title", ""))
            github = clean(project.get("github", ""))
            if github and github not in title:
                title = f"{title} ({github})"
            doc.text(title, doc.margin_x, size=8.0 if one_page else 8.6, bold=True)
            doc.y -= doc.line_height(8.8 if one_page else 9.6)
            tech = clean(project.get("tech", ""))
            if tech:
                doc.paragraph(tech, size=7.2 if one_page else 7.8, leading=8.0 if one_page else 8.8)
            for bullet in project.get("bullets", []):
                doc.bullet(bullet, size=7.35 if one_page else 8.0, leading=8.0 if one_page else 9.2)

    education = [clean(line) for line in model.get("education", []) if clean(line)]
    certifications = [clean(line) for line in model.get("certifications", []) if clean(line)]
    if education or certifications:
        doc.section("Education & Certifications" if one_page else "Education")
        for line in education[:1 if one_page else len(education)]:
            doc.paragraph(line, size=7.55 if one_page else 8.2, leading=8.4 if one_page else 9.4)
        if not one_page and certifications:
            doc.section("Certifications")
        if certifications:
            doc.paragraph("Certifications: " + " | ".join(certifications[:5 if one_page else len(certifications)]), size=7.35 if one_page else 8.0, leading=8.2 if one_page else 9.2)

    if one_page and trim_one_page and doc.page_count > 1:
        raise RuntimeError("one_page_overflow")
    doc.save()


def trim_for_one_page(model, attempt):
    model = json.loads(json.dumps(model))
    if attempt >= 2:
        limits = [6, 4, 3, 2]
    elif attempt >= 1:
        limits = [7, 4, 3, 2]
    else:
        limits = [7, 5, 4, 2]
    for index, job in enumerate(model.get("experience", [])):
        job["bullets"] = job.get("bullets", [])[: limits[index] if index < len(limits) else 1]
    for project in model.get("projects", []):
        project["bullets"] = project.get("bullets", [])[:2]
    return model


def main():
    if len(sys.argv) != 3:
        print("Usage: reportlab_resume_pdf.py model.json output.pdf", file=sys.stderr)
        sys.exit(2)
    model_path, out_path = sys.argv[1], sys.argv[2]
    with open(model_path, "r", encoding="utf-8-sig") as f:
        model = json.load(f)

    if model.get("mode") == "one_page":
        errors = []
        for attempt, scale in enumerate([1.0, 0.97, 0.94, 0.91, 0.88, 0.85]):
            try:
                render(trim_for_one_page(model, attempt), out_path, scale=scale, trim_one_page=True)
                return
            except RuntimeError as exc:
                errors.append(str(exc))
        render(trim_for_one_page(model, 5), out_path, scale=0.84, trim_one_page=False)
        return

    render(model, out_path, scale=1.0, trim_one_page=False)


if __name__ == "__main__":
    main()
