import csv
import datetime as dt
import io
import json
import posixpath
import re
import unicodedata
import zipfile
from pathlib import Path
from xml.etree import ElementTree


MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_ARCHIVE_BYTES = 50 * 1024 * 1024
MAX_ARCHIVE_FILES = 1000
MAX_ROWS = 10000

REQUIRED_COLUMNS = {
    "id": {
        "chamado",
        "ndochamado",
        "nodochamado",
        "numerodochamado",
        "ticket",
        "ticketid",
        "ticketnumber",
        "id",
    },
    "description": {
        "descricao",
        "descricaodochamado",
        "descricaodasolicitacao",
        "description",
        "assunto",
        "tituloassunto",
    },
    "theme": {
        "tema",
        "theme",
        "area",
        "areafuncionalidade",
        "funcionalidade",
        "modulo",
    },
    "journey": {"jornada", "journey"},
    "date": {
        "data",
        "datadochamado",
        "dataabertura",
        "dataatendimento",
        "date",
        "openedat",
    },
}
DISPLAY_NAMES = {
    "id": "Chamado",
    "description": "Descrição",
    "theme": "Tema",
    "journey": "Jornada",
    "date": "Data",
}
XML_NS = {
    "main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "office_rel": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "package_rel": "http://schemas.openxmlformats.org/package/2006/relationships",
}


class ImportErrorMessage(ValueError):
    """Input validation error that is safe to show to the spreadsheet sender."""


def normalize_header(value):
    value = str(value).strip().lstrip("\ufeff")
    value = value.replace("º", "o").replace("°", "o")
    value = unicodedata.normalize("NFD", value)
    value = "".join(
        character
        for character in value
        if not unicodedata.category(character).startswith("M")
    )
    return re.sub(r"[^a-z0-9]", "", value.lower())


def normalize_date(value):
    if isinstance(value, dt.datetime):
        return value.date().isoformat()
    if isinstance(value, dt.date):
        return value.isoformat()

    text = str(value).strip()
    formats = ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y")
    for date_format in formats:
        try:
            return dt.datetime.strptime(text, date_format).date().isoformat()
        except ValueError:
            pass

    raise ImportErrorMessage(
        f'Data inválida "{text}". Use AAAA-MM-DD ou DD/MM/AAAA.'
    )


def week_start_for_date(value):
    date = dt.date.fromisoformat(value)
    return (date - dt.timedelta(days=date.weekday())).isoformat()


def _column_indexes(headers):
    normalized = [normalize_header(value) for value in headers]
    columns = {
        field: next(
            (index for index, header in enumerate(normalized) if header in aliases),
            None,
        )
        for field, aliases in REQUIRED_COLUMNS.items()
    }
    missing = [
        DISPLAY_NAMES[field]
        for field, index in columns.items()
        if index is None
    ]
    if missing:
        raise ImportErrorMessage(
            f"Faltam colunas obrigatórias: {', '.join(missing)}."
        )
    return columns


def _validate_rows(rows, first_data_row=2):
    if not rows:
        raise ImportErrorMessage(
            "A planilha precisa ter um cabeçalho e pelo menos um chamado."
        )

    columns = _column_indexes(rows[0])
    data_rows = rows[1:]
    if not data_rows:
        raise ImportErrorMessage(
            "A planilha precisa ter um cabeçalho e pelo menos um chamado."
        )
    if len(data_rows) > MAX_ROWS:
        raise ImportErrorMessage(
            f"O limite por planilha é de {MAX_ROWS} chamados."
        )

    records = []
    seen = set()
    for offset, row in enumerate(data_rows):
        row_number = first_data_row + offset

        def value(field):
            index = columns[field]
            return row[index].strip() if index < len(row) else ""

        ticket_id = value("id")
        description = value("description")
        theme = value("theme")
        journey = value("journey")
        raw_date = value("date")

        if not re.fullmatch(r"[0-9]+", ticket_id):
            raise ImportErrorMessage(
                f"Linha {row_number}: o número do chamado deve conter apenas dígitos."
            )
        if not description or not theme or not journey:
            raise ImportErrorMessage(
                f"Linha {row_number}: descrição, tema e jornada são obrigatórios."
            )

        try:
            opened_at = normalize_date(raw_date)
        except ImportErrorMessage as error:
            raise ImportErrorMessage(f"Linha {row_number}: {error}") from error

        week_start = week_start_for_date(opened_at)
        key = (ticket_id, week_start)
        if key in seen:
            raise ImportErrorMessage(
                f"Linha {row_number}: o chamado {ticket_id} está repetido na mesma semana."
            )
        seen.add(key)
        records.append(
            {
                "ticket_id": ticket_id,
                "description": description,
                "theme": theme,
                "journey": journey,
                "opened_at": opened_at,
                "week_start": week_start,
            }
        )

    return records


def parse_csv(content):
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise ImportErrorMessage(
            "Não foi possível ler o CSV. Salve-o em UTF-8 e tente novamente."
        ) from error

    first_line = text.splitlines()[0] if text.splitlines() else ""
    try:
        dialect = csv.Sniffer().sniff(first_line, delimiters=";,\t")
    except csv.Error:
        dialect = csv.excel

    try:
        rows = list(csv.reader(io.StringIO(text, newline=""), dialect))
    except csv.Error as error:
        raise ImportErrorMessage(f"CSV inválido: {error}") from error

    return _validate_rows(
        [row for row in rows if any(cell.strip() for cell in row)]
    )


def _xml_root(archive, member):
    if member not in archive.namelist():
        raise ImportErrorMessage("O arquivo Excel está incompleto ou inválido.")
    if archive.getinfo(member).file_size > MAX_ARCHIVE_BYTES:
        raise ImportErrorMessage("Uma aba da planilha ultrapassa o tamanho permitido.")
    content = archive.read(member)
    if b"<!DOCTYPE" in content.upper():
        raise ImportErrorMessage("A planilha contém XML não permitido.")
    try:
        return ElementTree.fromstring(content)
    except ElementTree.ParseError as error:
        raise ImportErrorMessage("O arquivo Excel contém XML inválido.") from error


def _column_number(reference):
    match = re.match(r"([A-Z]+)", reference or "")
    if not match:
        return None
    column = 0
    for character in match.group(1):
        column = column * 26 + ord(character) - ord("A") + 1
    return column - 1 if column <= 16384 else None


def _excel_date_styles(archive):
    member = "xl/styles.xml"
    if member not in archive.namelist():
        return set()

    root = _xml_root(archive, member)
    custom_formats = {}
    num_fmts = root.find("main:numFmts", XML_NS)
    if num_fmts is not None:
        for num_fmt in num_fmts.findall("main:numFmt", XML_NS):
            custom_formats[int(num_fmt.get("numFmtId", "0"))] = num_fmt.get(
                "formatCode", ""
            )

    date_styles = set()
    cell_xfs = root.find("main:cellXfs", XML_NS)
    if cell_xfs is None:
        return date_styles

    for index, xf in enumerate(cell_xfs.findall("main:xf", XML_NS)):
        num_fmt_id = int(xf.get("numFmtId", "0"))
        format_code = re.sub(
            r'"[^"]*"|\\\\.|\\[[^]]*\\]',
            "",
            custom_formats.get(num_fmt_id, ""),
        )
        if 14 <= num_fmt_id <= 22 or 45 <= num_fmt_id <= 47 or re.search(
            r"[yd]", format_code, re.IGNORECASE
        ):
            date_styles.add(index)
    return date_styles


def _workbook_sheet_path(archive, workbook):
    workbook_root = _xml_root(archive, workbook)
    relationship_file = posixpath.join(
        posixpath.dirname(workbook), "_rels",
        posixpath.basename(workbook) + ".rels",
    )
    relationships = _xml_root(archive, relationship_file)
    targets = {
        relationship.get("Id"): relationship.get("Target")
        for relationship in relationships.findall("package_rel:Relationship", XML_NS)
        if relationship.get("TargetMode") != "External"
    }
    sheets = workbook_root.find("main:sheets", XML_NS)
    if sheets is None:
        raise ImportErrorMessage("Nenhuma aba foi encontrada no arquivo Excel.")

    for sheet in sheets.findall("main:sheet", XML_NS):
        if sheet.get("state", "visible") != "visible":
            continue
        relationship_id = sheet.get(f"{{{XML_NS['office_rel']}}}id")
        target = targets.get(relationship_id)
        if not target:
            continue
        member = (
            target.lstrip("/")
            if target.startswith("/")
            else posixpath.normpath(posixpath.join(posixpath.dirname(workbook), target))
        )
        if member.startswith("xl/") and member in archive.namelist():
            return member

    raise ImportErrorMessage("Não foi encontrada uma aba visível no arquivo Excel.")


def _shared_strings(archive):
    member = "xl/sharedStrings.xml"
    if member not in archive.namelist():
        return []
    root = _xml_root(archive, member)
    return [
        "".join(node.text or "" for node in item.findall(".//main:t", XML_NS))
        for item in root.findall("main:si", XML_NS)
    ]


def _cell_value(cell, shared_strings, date_styles):
    cell_type = cell.get("t")
    if cell_type == "inlineStr":
        inline = cell.find("main:is", XML_NS)
        return (
            "".join(node.text or "" for node in inline.findall(".//main:t", XML_NS))
            if inline is not None
            else ""
        )

    value_node = cell.find("main:v", XML_NS)
    if value_node is None or value_node.text is None:
        return ""
    value = value_node.text

    if cell_type == "s":
        try:
            return shared_strings[int(value)]
        except (ValueError, IndexError) as error:
            raise ImportErrorMessage("A planilha contém um texto inválido.") from error
    if cell_type == "b":
        return "TRUE" if value == "1" else "FALSE"
    if cell_type in {"str", "e"}:
        return value

    style = int(cell.get("s", "0"))
    if style in date_styles:
        try:
            excel_date = dt.datetime(1899, 12, 30) + dt.timedelta(days=float(value))
            return excel_date.date().isoformat()
        except (ValueError, OverflowError) as error:
            raise ImportErrorMessage("A planilha contém uma data Excel inválida.") from error
    return value


def parse_xlsx(content):
    try:
        archive = zipfile.ZipFile(io.BytesIO(content))
    except (zipfile.BadZipFile, OSError) as error:
        raise ImportErrorMessage("O arquivo .xlsx está danificado ou inválido.") from error

    with archive:
        members = archive.infolist()
        if len(members) > MAX_ARCHIVE_FILES or sum(
            member.file_size for member in members
        ) > MAX_ARCHIVE_BYTES:
            raise ImportErrorMessage("A planilha Excel ultrapassa o tamanho permitido.")
        if "xl/workbook.xml" not in archive.namelist():
            raise ImportErrorMessage("O arquivo não é uma planilha Excel .xlsx válida.")

        sheet_path = _workbook_sheet_path(archive, "xl/workbook.xml")
        shared_strings = _shared_strings(archive)
        date_styles = _excel_date_styles(archive)
        sheet = _xml_root(archive, sheet_path)
        rows = []

        try:
            for row_node in sheet.findall(".//main:sheetData/main:row", XML_NS):
                cells = []
                for cell in row_node.findall("main:c", XML_NS):
                    column = _column_number(cell.get("r"))
                    if column is None:
                        continue
                    while len(cells) <= column:
                        cells.append("")
                    cells[column] = _cell_value(cell, shared_strings, date_styles)
                rows.append((int(row_node.get("r", str(len(rows) + 1))), cells))
        except (ValueError, TypeError, OverflowError) as error:
            raise ImportErrorMessage("O arquivo Excel contém células inválidas.") from error

    header_index = next(
        (
            index
            for index, (_, row) in enumerate(rows)
            if any(str(value).strip() for value in row)
        ),
        None,
    )
    if header_index is None:
        raise ImportErrorMessage(
            "A planilha precisa ter um cabeçalho e pelo menos um chamado."
        )
    header_row_number, _ = rows[header_index]
    return _validate_rows(
        [row for _, row in rows[header_index:]],
        first_data_row=header_row_number + 1,
    )


def parse_spreadsheet(filename, content):
    if not content:
        raise ImportErrorMessage("O arquivo está vazio.")
    if len(content) > MAX_FILE_BYTES:
        raise ImportErrorMessage("O limite por arquivo é de 10 MB.")

    extension = Path(filename).suffix.lower()
    if extension == ".csv":
        return parse_csv(content)
    if extension == ".xlsx":
        return parse_xlsx(content)
    raise ImportErrorMessage("Envie uma planilha .xlsx ou um arquivo .csv.")



def main():
    import argparse
    import sys

    argument_parser = argparse.ArgumentParser()
    argument_parser.add_argument("--json", action="store_true", required=True)
    argument_parser.add_argument("filename")
    arguments = argument_parser.parse_args()
    try:
        content = sys.stdin.buffer.read(MAX_FILE_BYTES + 1)
        records = parse_spreadsheet(arguments.filename, content)
    except ImportErrorMessage as error:
        print(str(error), file=sys.stderr)
        return 2
    except OSError as error:
        print(f"Falha ao ler a planilha: {error}", file=sys.stderr)
        return 2

    print(json.dumps(records, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
