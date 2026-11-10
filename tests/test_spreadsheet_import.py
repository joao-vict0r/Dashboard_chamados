import sys
import unittest
import zipfile
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from spreadsheet_import import ImportErrorMessage, parse_csv, parse_xlsx


class SpreadsheetImportTests(unittest.TestCase):
    def test_parses_utf8_csv_with_semicolon_delimiter(self):
        content = (
            "Chamado;Descrição;Tema;Jornada;Data\n"
            "1234567;Dúvida de acesso;Acesso;Onboarding;01/09/2026\n"
        ).encode("utf-8")

        self.assertEqual(parse_csv(content), [{
            "ticket_id": "1234567",
            "description": "Dúvida de acesso",
            "theme": "Acesso",
            "journey": "Onboarding",
            "opened_at": "2026-09-01",
            "week_start": "2026-08-31",
        }])

    def test_rejects_duplicate_ticket_in_same_week(self):
        content = (
            "Chamado,Descrição,Tema,Jornada,Data\n"
            "1234567,Primeiro,Acesso,Onboarding,2026-09-01\n"
            "1234567,Segundo,Acesso,Onboarding,2026-09-02\n"
        ).encode("utf-8")

        with self.assertRaisesRegex(ImportErrorMessage, "repetido na mesma semana"):
            parse_csv(content)

    def test_rejects_missing_required_column(self):
        content = "Chamado,Descrição,Tema,Jornada\n1234567,Teste,Acesso,Onboarding\n".encode()

        with self.assertRaisesRegex(ImportErrorMessage, "Data"):
            parse_csv(content)

    def test_parses_first_visible_xlsx_sheet(self):
        workbook = BytesIO()
        with zipfile.ZipFile(workbook, "w") as archive:
            archive.writestr(
                "xl/workbook.xml",
                '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                '<sheets><sheet name="Chamados" sheetId="1" r:id="rId1"/></sheets></workbook>',
            )
            archive.writestr(
                "xl/_rels/workbook.xml.rels",
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>'
                '</Relationships>',
            )
            cells = [
                ["Chamado", "Descrição", "Tema", "Jornada", "Data"],
                ["1234567", "Dúvida", "Acesso", "Onboarding", "2026-09-01"],
            ]
            row_xml = []
            for row_number, values in enumerate(cells, start=1):
                cell_xml = []
                for column, value in enumerate(values, start=1):
                    reference = f"{chr(64 + column)}{row_number}"
                    cell_xml.append(
                        f'<c r="{reference}" t="inlineStr"><is><t>{value}</t></is></c>'
                    )
                row_xml.append(f'<row r="{row_number}">{"".join(cell_xml)}</row>')
            archive.writestr(
                "xl/worksheets/sheet1.xml",
                '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                f'<sheetData>{"".join(row_xml)}</sheetData></worksheet>',
            )

        records = parse_xlsx(workbook.getvalue())
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["week_start"], "2026-08-31")


if __name__ == "__main__":
    unittest.main()
