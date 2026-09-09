import os
import tempfile
import unittest
from pathlib import Path

from flask import Flask

from modules.pending_records import routes
from modules.pending_records.services import RecordStore, ValidationError


def valid_payload(**overrides):
    payload = {
        "record_date": "2026-08-19",
        "shift": "甲班",
        "product": "娇子（清甜香）",
        "machines": ["3#", "1#"],
        "case_count": 2,
        "strip_count": 4,
        "custodian": "张三",
        "reasons": [
            {"type": "待关联", "detail": ""},
            {"type": "缺陷", "detail": "包装破损"},
        ],
    }
    payload.update(overrides)
    return payload


class PendingRecordStoreTest(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.store = RecordStore(
            Path(self.temporary_directory.name) / "pending_records.db"
        )

    def tearDown(self):
        self.temporary_directory.cleanup()

    def test_create_update_delete_and_monthly_number(self):
        created = self.store.create(valid_payload())
        self.assertEqual(created["record_no"], "202608-001")
        self.assertEqual(created["machines"], ["1#", "3#"])

        updated = self.store.update(created["id"], valid_payload(custodian="李四"))
        self.assertEqual(updated["custodian"], "李四")

        supplemented = self.store.add_quantity(
            created["id"], {"case_count": 1, "strip_count": 2, "note": "再次入库"}
        )
        self.assertEqual(supplemented["total_quantity"]["case_count"], 3)
        self.assertEqual(supplemented["total_quantity"]["strip_count"], 6)
        self.assertEqual(len(supplemented["quantity_additions"]), 1)

        first_disposition = self.store.add_disposition(
            created["id"],
            {
                "case_count": 1,
                "strip_count": 3,
                "disposition": "第一次处理",
                "disposer": "王五",
            },
        )
        self.assertEqual(first_disposition["remaining_quantity"]["case_count"], 2)
        self.assertEqual(first_disposition["remaining_quantity"]["strip_count"], 3)
        self.assertEqual(first_disposition["status"], "pending")

        completed = self.store.add_disposition(
            created["id"],
            {
                "case_count": 2,
                "strip_count": 3,
                "disposition": "全部处理完成",
                "disposer": "王五",
            },
        )
        self.assertEqual(completed["status"], "completed")
        self.assertEqual(len(completed["disposition_entries"]), 2)

        deleted = self.store.delete(created["id"])
        self.assertEqual(deleted["record_no"], "202608-001")
        with self.assertRaises(KeyError):
            self.store.get(created["id"])
        self.assertEqual(self.store.next_number("2026-08-20"), "202608-002")

    def test_validation_rejects_empty_quantity(self):
        with self.assertRaises(ValidationError):
            self.store.create(valid_payload(case_count=0, strip_count=0))

    def test_disposition_cannot_exceed_remaining_quantity(self):
        created = self.store.create(valid_payload(case_count=1, strip_count=2))
        with self.assertRaisesRegex(ValidationError, "剩余件数"):
            self.store.add_disposition(
                created["id"],
                {
                    "case_count": 2,
                    "strip_count": 0,
                    "disposition": "超量处理",
                    "disposer": "李四",
                },
            )

    def test_pending_summary_groups_shift_product_and_quantity(self):
        first = self.store.create(valid_payload(case_count=2, strip_count=3))
        self.store.add_quantity(
            first["id"], {"case_count": 1, "strip_count": 2}
        )
        self.store.add_disposition(
            first["id"],
            {
                "case_count": 1,
                "strip_count": 1,
                "disposition": "部分处理",
                "disposer": "李四",
            },
        )
        self.store.create(valid_payload(case_count=1, strip_count=4))
        self.store.create(
            valid_payload(
                shift="乙班",
                product="黄鹤楼（硬红）",
                case_count=5,
                strip_count=6,
            )
        )
        completed = self.store.create(
            valid_payload(
                shift="丙班",
                case_count=2,
                strip_count=4,
            )
        )
        self.store.add_disposition(
            completed["id"],
            {
                "case_count": 2,
                "strip_count": 4,
                "disposition": "已处理",
                "disposer": "李四",
            },
        )

        summary = {item["shift"]: item for item in self.store.pending_summary()}
        self.assertEqual(summary["甲班"]["record_count"], 2)
        self.assertEqual(summary["甲班"]["case_count"], 3)
        self.assertEqual(summary["甲班"]["strip_count"], 8)
        self.assertEqual(
            summary["甲班"]["products"][0]["product"], "娇子（清甜香）"
        )
        self.assertEqual(summary["乙班"]["case_count"], 5)
        self.assertEqual(summary["丙班"]["record_count"], 0)


class PendingRecordsRouteTest(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.original_store = routes.record_store
        routes.record_store = RecordStore(
            Path(self.temporary_directory.name) / "pending_records.db"
        )
        self.original_password = os.environ.get("PENDING_RECORD_DELETE_PASSWORD")
        os.environ["PENDING_RECORD_DELETE_PASSWORD"] = "test-delete-password"

        app = Flask(
            __name__,
            template_folder=str(Path(__file__).resolve().parents[1] / "templates"),
        )
        app.config.update(TESTING=True)
        app.add_url_rule("/", "index", lambda: "index")
        app.register_blueprint(routes.pending_records_bp)
        self.client = app.test_client()

    def tearDown(self):
        routes.record_store = self.original_store
        if self.original_password is None:
            os.environ.pop("PENDING_RECORD_DELETE_PASSWORD", None)
        else:
            os.environ["PENDING_RECORD_DELETE_PASSWORD"] = self.original_password
        self.temporary_directory.cleanup()

    def test_pages_config_and_password_protected_delete(self):
        pending_page = self.client.get("/pending_records/")
        self.assertEqual(pending_page.status_code, 200)
        self.assertIn(b'id="shiftSelect"', pending_page.data)
        self.assertIn(b'id="pendingSummaryView"', pending_page.data)
        self.assertNotIn(b'name="disposition"', pending_page.data)
        print_page = self.client.get("/pending_records/print")
        self.assertEqual(print_page.status_code, 200)
        self.assertIn(b"210mm 148mm", print_page.data)
        self.assertIn(b"size-a5", print_page.data)
        self.assertIn(b'data-field="shift_watermark"', print_page.data)
        self.assertIn(b'data-field="shift"', print_page.data)
        self.assertNotIn(b"PENDING PRODUCT RECORD", print_page.data)
        self.assertNotIn("纵向".encode("utf-8"), print_page.data)
        print_css_response = self.client.get(
            "/pending_records/static/print.css"
        )
        print_css = print_css_response.get_data(as_text=True)
        print_css_response.close()
        self.assertIn("width: 210mm; height: 148mm", print_css)
        self.assertNotIn("zoom: 1.8", print_css)
        self.assertIn("zoom: 1 !important", print_css)
        self.assertIn("color: #a6a6a6", print_css)

        config = self.client.get("/pending_records/api/config")
        self.assertEqual(config.status_code, 200)
        self.assertEqual(len(config.get_json()["machines"]), 12)
        self.assertEqual(config.get_json()["shifts"], ["甲班", "乙班", "丙班"])

        created_response = self.client.post(
            "/pending_records/api/records", json=valid_payload()
        )
        self.assertEqual(created_response.status_code, 201)
        record_id = created_response.get_json()["record"]["id"]

        addition = self.client.post(
            f"/pending_records/api/records/{record_id}/quantity-additions",
            json={"case_count": 1, "strip_count": 2, "note": "补充"},
        )
        self.assertEqual(addition.status_code, 201)
        self.assertEqual(addition.get_json()["record"]["total_quantity"]["case_count"], 3)

        disposition = self.client.post(
            f"/pending_records/api/records/{record_id}/dispositions",
            json={
                "case_count": 1,
                "strip_count": 3,
                "disposition": "部分处理",
                "disposer": "李四",
            },
        )
        self.assertEqual(disposition.status_code, 201)
        self.assertEqual(
            disposition.get_json()["record"]["remaining_quantity"]["strip_count"],
            3,
        )

        summary = self.client.get("/pending_records/api/pending-summary")
        self.assertEqual(summary.status_code, 200)
        self.assertEqual(summary.get_json()["summary"][0]["case_count"], 2)

        wrong_password = self.client.delete(
            f"/pending_records/api/records/{record_id}",
            json={"password": "wrong"},
        )
        self.assertEqual(wrong_password.status_code, 401)
        self.assertEqual(
            self.client.get(f"/pending_records/api/records/{record_id}").status_code,
            200,
        )

        deleted = self.client.delete(
            f"/pending_records/api/records/{record_id}",
            json={"password": "test-delete-password"},
        )
        self.assertEqual(deleted.status_code, 200)
        self.assertIn("已删除", deleted.get_json()["message"])
        self.assertEqual(
            self.client.get(f"/pending_records/api/records/{record_id}").status_code,
            404,
        )


if __name__ == "__main__":
    unittest.main()
