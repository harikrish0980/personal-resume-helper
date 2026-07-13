from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "docs" / "assets"


def font(size, bold=False):
    names = ["arialbd.ttf", "segoeuib.ttf"] if bold else ["arial.ttf", "segoeui.ttf"]
    for name in names:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()


F_TITLE = font(34, True)
F_H2 = font(24, True)
F_BODY = font(18)
F_SMALL = font(15)
F_LABEL = font(14, True)


def rounded(draw, xy, radius, fill, outline=None, width=1):
    draw.rounded_rectangle(xy, radius=radius, fill=fill, outline=outline, width=width)


def text(draw, xy, value, fill="#12212f", fnt=F_BODY):
    draw.text(xy, value, font=fnt, fill=fill)


def base(title, subtitle):
    img = Image.new("RGB", (1440, 920), "#eaf7fb")
    draw = ImageDraw.Draw(img)
    for y in range(920):
      r = int(234 - y * 0.03)
      g = int(247 - y * 0.02)
      b = int(251 - y * 0.005)
      draw.line([(0, y), (1440, y)], fill=(max(r, 210), max(g, 232), max(b, 242)))
    rounded(draw, (0, 0, 260, 920), 0, "#c9faf8")
    rounded(draw, (20, 24, 62, 66), 10, "#1db7c2")
    text(draw, (32, 37), "EZ", "white", F_LABEL)
    text(draw, (76, 27), "EaZy Job Apply", "#12212f", F_LABEL)
    text(draw, (76, 50), "Job command center", "#5d6d7b", F_SMALL)
    for i, item in enumerate(["Dashboard", "Add Job", "Analyzed Jobs", "Scanner Inbox", "Applications", "Documents", "Profile & Resume", "Settings"]):
        y = 112 + i * 52
        if item == title:
            rounded(draw, (18, y - 12, 242, y + 30), 7, "#ffffff", "#b8cad6")
            rounded(draw, (24, y - 4, 28, y + 22), 3, "#13a7a3")
        text(draw, (32, y), item, "#12212f", F_BODY)
    text(draw, (282, 28), title, "#12212f", F_TITLE)
    text(draw, (282, 70), subtitle, "#586a78", F_BODY)
    return img, draw


def field(draw, xy, label, value="", h=46):
    x1, y1, x2, _ = xy
    text(draw, (x1, y1 - 22), label, "#596d7a", F_SMALL)
    rounded(draw, (x1, y1, x2, y1 + h), 8, "#ffffff", "#c9d6df")
    if value:
        text(draw, (x1 + 14, y1 + 13), value, "#6a737d", F_SMALL)


def screenshot_profile():
    img, draw = base("Profile & Resume", "Read the Resume Workspace profile and resume source files.")
    rounded(draw, (282, 114, 1344, 842), 8, "#eefbff", "#c8d8e4")
    field(draw, (304, 154, 804, 200), "Current Role", "Target role")
    field(draw, (820, 154, 1324, 200), "Years Of Experience", "Years of experience")
    field(draw, (304, 238, 804, 284), "Target Roles", "Role 1, Role 2, Role 3", 72)
    field(draw, (820, 238, 1324, 284), "Target Locations", "Remote, city, or country preferences", 72)
    field(draw, (304, 350, 804, 396), "Remote Preference", "Remote")
    field(draw, (820, 350, 1324, 396), "Salary Expectation", "Expected salary or range")
    field(draw, (304, 432, 804, 478), "Work Authorization", "Work authorization or sponsorship notes", 62)
    field(draw, (820, 432, 1324, 478), "Preferred Skills", "Important skills, tools, and platforms", 62)
    rounded(draw, (282, 868, 1344, 910), 8, "#ffffff", "#c8d8e4")
    text(draw, (304, 884), "Resume Sources: cv.md loaded: Yes  |  article-digest.md loaded: Yes", "#12212f", F_LABEL)
    img.save(ASSETS / "profile-and-resume.png")


def screenshot_add_job():
    img, draw = base("Add Job", "Paste a job URL or description, choose a resume profile, and generate review-ready files.")
    rounded(draw, (282, 116, 830, 820), 8, "#ffffff", "#c8d8e4")
    text(draw, (304, 140), "Job Input", "#12212f", F_H2)
    field(draw, (304, 200, 806, 246), "Job URL", "https://company.com/jobs/123")
    field(draw, (304, 294, 806, 340), "Job Description", "Paste the job description here.", 180)
    text(draw, (304, 526), "Run Options", "#12212f", F_H2)
    rounded(draw, (304, 574, 806, 626), 8, "#15334b", "#22c7c7")
    text(draw, (326, 590), "Resume 1", "white", F_BODY)
    rounded(draw, (304, 650, 560, 698), 8, "#16b3ad")
    text(draw, (340, 664), "Generate Analysis", "white", F_LABEL)
    rounded(draw, (862, 116, 1344, 820), 8, "#ffffff", "#c8d8e4")
    text(draw, (884, 140), "Fit Review", "#12212f", F_H2)
    for idx, (label, value, color) in enumerate([("Score", "4.1 / 5", "#0d9488"), ("Recommendation", "Review", "#2563eb"), ("Output", "PDF + Word + HTML", "#7c3aed")]):
        y = 200 + idx * 100
        rounded(draw, (884, y, 1320, y + 72), 8, "#f8fbfd", "#d6e1e8")
        text(draw, (906, y + 15), label, "#596d7a", F_SMALL)
        text(draw, (1080, y + 15), value, color, F_H2)
    img.save(ASSETS / "add-job.png")


def demo_gif():
    frames = []
    steps = [
        ("1. Add resume details", "Update Resume-Workspace/profiles/resume-1/cv.md with truthful resume details."),
        ("2. Add proof points", "Add client, project, tool, metric, and impact points in article-digest.md."),
        ("3. Analyze a job", "Paste the job description, select Resume 1, and review the fit score."),
        ("4. Review outputs", "Open PDF, Word/DOCX, or HTML files and manually apply when ready."),
    ]
    for title_value, body in steps:
        img = Image.new("RGB", (960, 540), "#eaf7fb")
        draw = ImageDraw.Draw(img)
        rounded(draw, (34, 34, 926, 506), 18, "#ffffff", "#b9d2dd", 2)
        rounded(draw, (70, 72, 122, 124), 12, "#1db7c2")
        text(draw, (86, 88), "EZ", "white", F_LABEL)
        text(draw, (144, 78), "EaZy Job Apply", "#12212f", F_H2)
        text(draw, (144, 110), "Local-first resume tailoring workflow", "#596d7a", F_SMALL)
        text(draw, (92, 190), title_value, "#12212f", F_TITLE)
        text(draw, (92, 250), body, "#405260", F_BODY)
        rounded(draw, (92, 346, 868, 408), 10, "#f4fbfd", "#cbdce6")
        text(draw, (118, 366), "Resume 1  +  article-digest.md  +  job description  ->  fit score and resume files", "#1d3c4f", F_SMALL)
        frames.append(img)
    frames[0].save(ASSETS / "demo.gif", save_all=True, append_images=frames[1:], duration=1200, loop=0)


def main():
    ASSETS.mkdir(parents=True, exist_ok=True)
    screenshot_profile()
    screenshot_add_job()
    demo_gif()


if __name__ == "__main__":
    main()
