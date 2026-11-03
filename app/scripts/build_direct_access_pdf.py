from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    Image,
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "pdf" / "ritm-direct-api-specification.pdf"
SCREENSHOTS = ROOT / "docs" / "screenshots"

PAGE = landscape(A4)
PAGE_W, PAGE_H = PAGE
INK = colors.HexColor("#18342B")
MUTED = colors.HexColor("#66736D")
ACCENT = colors.HexColor("#16735C")
PALE = colors.HexColor("#E9F1EC")
PAPER = colors.HexColor("#FBFCF8")
LINE = colors.HexColor("#DCE4DF")


def register_fonts() -> tuple[str, str]:
    candidates = [
        (Path("C:/Windows/Fonts/arial.ttf"), Path("C:/Windows/Fonts/arialbd.ttf")),
        (Path("C:/Windows/Fonts/segoeui.ttf"), Path("C:/Windows/Fonts/segoeuib.ttf")),
    ]
    for regular, bold in candidates:
        if regular.exists() and bold.exists():
            pdfmetrics.registerFont(TTFont("RitmRegular", str(regular)))
            pdfmetrics.registerFont(TTFont("RitmBold", str(bold)))
            return "RitmRegular", "RitmBold"
    raise FileNotFoundError("Не найден шрифт с поддержкой кириллицы")


REGULAR, BOLD = register_fonts()


def p(text: str, style: ParagraphStyle) -> Paragraph:
    return Paragraph(text, style)


styles = getSampleStyleSheet()
styles.add(
    ParagraphStyle(
        "RitmTitle",
        fontName=BOLD,
        fontSize=28,
        leading=32,
        textColor=INK,
        spaceAfter=7 * mm,
    )
)
styles.add(
    ParagraphStyle(
        "RitmSubtitle",
        fontName=REGULAR,
        fontSize=13,
        leading=18,
        textColor=MUTED,
        spaceAfter=5 * mm,
    )
)
styles.add(
    ParagraphStyle(
        "RitmH2",
        fontName=BOLD,
        fontSize=17,
        leading=21,
        textColor=INK,
        spaceBefore=2 * mm,
        spaceAfter=3 * mm,
    )
)
styles.add(
    ParagraphStyle(
        "RitmBody",
        fontName=REGULAR,
        fontSize=10.5,
        leading=15,
        textColor=INK,
        alignment=TA_LEFT,
        spaceAfter=2.4 * mm,
    )
)
styles.add(
    ParagraphStyle(
        "RitmSmall",
        fontName=REGULAR,
        fontSize=8.5,
        leading=12,
        textColor=MUTED,
    )
)
styles.add(
    ParagraphStyle(
        "RitmLabel",
        fontName=BOLD,
        fontSize=8,
        leading=10,
        textColor=ACCENT,
        uppercase=True,
        spaceAfter=2 * mm,
    )
)


def header_footer(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(PAPER)
    canvas.rect(0, 0, PAGE_W, PAGE_H, stroke=0, fill=1)
    canvas.setStrokeColor(LINE)
    canvas.line(17 * mm, 14 * mm, PAGE_W - 17 * mm, 14 * mm)
    canvas.setFont(BOLD, 9)
    canvas.setFillColor(ACCENT)
    canvas.drawString(17 * mm, PAGE_H - 13 * mm, "РИТМ")
    canvas.setFont(REGULAR, 8)
    canvas.setFillColor(MUTED)
    canvas.drawRightString(PAGE_W - 17 * mm, PAGE_H - 13 * mm, "Спецификация приложения для Яндекс Директа")
    canvas.drawString(17 * mm, 8.5 * mm, "Тестовый контур • действия с рекламой отключены")
    canvas.drawRightString(PAGE_W - 17 * mm, 8.5 * mm, f"{doc.page}")
    canvas.restoreState()


def card(title: str, body: str, width: float):
    content = [p(title, styles["RitmH2"]), p(body, styles["RitmBody"])]
    table = Table([[content]], colWidths=[width], hAlign="LEFT")
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), colors.white),
                ("BOX", (0, 0), (-1, -1), 0.8, LINE),
                ("LEFTPADDING", (0, 0), (-1, -1), 8 * mm),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8 * mm),
                ("TOPPADDING", (0, 0), (-1, -1), 5 * mm),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5 * mm),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ]
        )
    )
    return table


def screenshot_page(story, filename: str, title: str, caption: str):
    path = SCREENSHOTS / filename
    if not path.exists():
        raise FileNotFoundError(path)
    story.extend(
        [
            p("ИНТЕРФЕЙС", styles["RitmLabel"]),
            p(title, styles["RitmTitle"]),
            p(caption, styles["RitmSubtitle"]),
        ]
    )
    img = Image(str(path))
    max_w = PAGE_W - 34 * mm
    # Reserve enough vertical space for the page label, title, caption and footer.
    max_h = PAGE_H - 100 * mm
    scale = min(max_w / img.imageWidth, max_h / img.imageHeight)
    img.drawWidth = img.imageWidth * scale
    img.drawHeight = img.imageHeight * scale
    img.hAlign = "CENTER"
    story.append(img)
    story.append(PageBreak())


def build():
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(
        str(OUTPUT),
        pagesize=PAGE,
        rightMargin=17 * mm,
        leftMargin=17 * mm,
        topMargin=22 * mm,
        bottomMargin=18 * mm,
        title="Ритм — спецификация приложения для Яндекс Директа",
        author="Проект Ритм",
        subject="Назначение, архитектура, безопасность и интерфейс MVP",
    )

    usable_w = PAGE_W - 34 * mm
    gap = 7 * mm
    col = (usable_w - gap) / 2
    story = [
        Spacer(1, 8 * mm),
        p("ПРИЛОЖЕНИЕ ДЛЯ МАЛОГО БИЗНЕСА", styles["RitmLabel"]),
        p("Ритм", styles["RitmTitle"]),
        p(
            "Веб-сервис для прозрачной работы с рекламой в Яндекс Директе: подключение кабинета по OAuth, получение отчетов, сверка исходных данных и формирование рекомендаций владельцу бизнеса.",
            styles["RitmSubtitle"],
        ),
        Spacer(1, 4 * mm),
        Table(
            [[
                card(
                    "Назначение MVP",
                    "Владелец малого бизнеса подключает только собственный кабинет. Сервис читает доступные кампании и статистику, сохраняет исходные снимки отчетов и объясняет возможные улучшения без автоматического применения.",
                    col,
                ),
                card(
                    "Текущий режим",
                    "Тестовый контур. Создание и изменение рекламных кампаний, ставок, лимитов и платежей отключено на сервере. Любое потенциальное изменение требует отдельного явного решения пользователя.",
                    col,
                ),
            ]],
            colWidths=[col, col],
            hAlign="LEFT",
            style=[
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), gap),
                ("RIGHTPADDING", (1, 0), (1, 0), 0),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ],
        ),
        Spacer(1, 7 * mm),
        p("Основной сценарий", styles["RitmH2"]),
        p(
            "1. Пользователь входит через Google и создает карточку бизнеса.  2. Подключает свой кабинет Яндекс Директа через OAuth.  3. Ритм запрашивает список кампаний и отчеты через JSON API.  4. Исходные ответы сохраняются отдельными снимками и сверяются между собой.  5. Пользователь получает понятные показатели и рекомендации; исполнение рекомендаций в MVP не выполняется.",
            styles["RitmBody"],
        ),
        Spacer(1, 4 * mm),
        p("Стек", styles["RitmH2"]),
        p(
            "TypeScript, React, Vite, Node.js, Express, SQLite, JSON API Яндекс Директа, OAuth 2.0. Аналитический модуль на Python формирует объяснимые рекомендации по правилам и не запускает рекламу.",
            styles["RitmBody"],
        ),
        PageBreak(),
        p("АРХИТЕКТУРА И БЕЗОПАСНОСТЬ", styles["RitmLabel"]),
        p("Как приложение взаимодействует с Директом", styles["RitmTitle"]),
        Table(
            [[
                p("Пользователь", styles["RitmH2"]),
                p("Веб-интерфейс Ритм", styles["RitmH2"]),
                p("Сервер Ритм", styles["RitmH2"]),
                p("API Яндекс Директа", styles["RitmH2"]),
            ], [
                p("Явно подключает свой аккаунт и видит результат анализа.", styles["RitmBody"]),
                p("Показывает статусы подключения, отчеты, расхождения и рекомендации.", styles["RitmBody"]),
                p("Обменивает OAuth-код, шифрует токен, делает запросы к API, сохраняет снимки.", styles["RitmBody"]),
                p("Возвращает кампании и статистические отчеты по авторизованному кабинету.", styles["RitmBody"]),
            ]],
            colWidths=[usable_w / 4] * 4,
            hAlign="LEFT",
            style=[
                ("BACKGROUND", (0, 0), (-1, 0), PALE),
                ("BOX", (0, 0), (-1, -1), 0.8, LINE),
                ("INNERGRID", (0, 0), (-1, -1), 0.5, LINE),
                ("LEFTPADDING", (0, 0), (-1, -1), 5 * mm),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5 * mm),
                ("TOPPADDING", (0, 0), (-1, -1), 4 * mm),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4 * mm),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ],
        ),
        Spacer(1, 7 * mm),
        KeepTogether([
            p("Контроль доступа и данных", styles["RitmH2"]),
            p(
                "• OAuth-токены хранятся только на сервере в зашифрованном виде и не передаются браузеру или третьим лицам.<br/>"
                "• Каждый пользователь получает доступ только к собственным организациям и подключениям.<br/>"
                "• В ответах интерфейса секреты и токены маскируются; одноразовые OAuth-коды не журналируются.<br/>"
                "• Исходный отчет сохраняется отдельно от нормализованного представления, чтобы можно было проверить расчеты.<br/>"
                "• Фоновый обработчик ограничивает число повторов и прекращает задачу после трех ошибок.<br/>"
                "• Переключатель запуска реальных рекламных действий выключен по умолчанию и в тестовом контуре.",
                styles["RitmBody"],
            ),
        ]),
        Spacer(1, 5 * mm),
        KeepTogether([
            p("Планируемое развитие", styles["RitmH2"]),
            p(
                "После отдельной проверки и явного подтверждения владельца может быть добавлено управление кампаниями и объявлениями. Автоматический биддинг, самостоятельное расходование бюджета и проведение платежей в текущую версию не входят.",
                styles["RitmBody"],
            ),
        ]),
        PageBreak(),
    ]

    screenshot_page(
        story,
        "analyst-desktop.jpg",
        "Объяснимые рекомендации",
        "Аналитик показывает основание, метрики и предлагаемое действие. Рекомендация не исполняется автоматически.",
    )
    screenshot_page(
        story,
        "report-reconciliation.jpg",
        "Сверка отчетов с первоисточником",
        "Ритм хранит отдельные снимки, показывает расхождения и позволяет выгрузить исходник для проверки.",
    )
    screenshot_page(
        story,
        "shadow-worker.jpg",
        "Фоновая проверка без открытой вкладки",
        "Серверная задача периодически проверяет изменившиеся сохраненные данные. Запуск и изменение рекламы отключены.",
    )

    doc.build(story, onFirstPage=header_footer, onLaterPages=header_footer)
    print(OUTPUT)


if __name__ == "__main__":
    build()
