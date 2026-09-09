import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from flask import Flask


os.environ.pop("LIGHT_CONTROL_PASSWORD", None)
SERVICE_DIR = Path(__file__).resolve().parents[1]
if str(SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(SERVICE_DIR))

from modules.light_control.routes import light_control_bp, light_control_service


class LightControlRouteTests(unittest.TestCase):
    def setUp(self):
        app = Flask(
            __name__,
            template_folder=str(SERVICE_DIR / "templates"),
        )
        app.config.update(TESTING=True, SECRET_KEY="light-control-test-secret")
        app.register_blueprint(light_control_bp)
        self.client = app.test_client()
        light_control_service._config_cache = None
        light_control_service._config_cache_at = 0

    def test_original_page_and_copied_assets_are_served(self):
        response = self.client.get("/light_control/")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"light-control-auth.js", response.data)
        self.assertNotIn(b'data-view="modeling"', response.data)
        asset_response = self.client.get(
            "/light_control/assets/js/light-control-auth.js"
        )
        self.assertEqual(asset_response.status_code, 200)
        asset_response.close()
        library_response = self.client.get("/light_control/libs/babylon.js")
        self.assertEqual(library_response.status_code, 200)
        library_response.close()

    def test_control_is_rejected_before_password_unlock(self):
        response = self.client.post(
            "/api/light_control/toggle",
            json={"ip": "192.168.1.100", "channel": 0, "value": True},
        )
        self.assertEqual(response.status_code, 401)
        self.assertIn("请先输入密码", response.get_json()["error"])

    def test_correct_password_unlocks_control_and_lock_revokes_it(self):
        self.assertEqual(
            self.client.post(
                "/api/light_control/unlock", json={"password": "wrong"}
            ).status_code,
            401,
        )
        unlock = self.client.post(
            "/api/light_control/unlock", json={"password": "7887"}
        )
        self.assertEqual(unlock.status_code, 200)
        self.assertTrue(unlock.get_json()["unlocked"])

        with patch.object(light_control_service, "toggle", return_value={"ok": True}):
            control = self.client.post(
                "/api/light_control/toggle",
                json={"ip": "192.168.1.100", "channel": 0, "value": True},
            )
        self.assertEqual(control.status_code, 200)
        self.assertTrue(control.get_json()["ok"])

        self.client.post("/api/light_control/lock")
        locked_again = self.client.post(
            "/api/light_control/batch",
            json={"ip": "192.168.1.100", "start": 0, "end": 1, "value": False},
        )
        self.assertEqual(locked_again.status_code, 401)

    def test_configuration_writes_are_not_exposed(self):
        response = self.client.post("/api/light_control/config", json={})
        self.assertEqual(response.status_code, 405)

    def test_connect_uses_saved_upstream_device_instead_of_browser_fields(self):
        saved_device = {
            "name": "主控器",
            "ip": "192.168.1.100",
            "port": 502,
            "protocol": "modbus_tcp",
            "unit_id": 254,
            "channel_count": 32,
        }
        with patch.object(
            light_control_service,
            "get_config",
            return_value={"devices": [saved_device]},
        ), patch.object(
            light_control_service,
            "request_json",
            return_value={"ok": True, "relay_states": [False] * 32},
        ) as request_json:
            response = self.client.post(
                "/api/light_control/connect",
                json={"ip": "192.168.1.100", "port": 1, "unit_id": 1},
            )

        self.assertEqual(response.status_code, 200)
        request_json.assert_called_once_with(
            "/api/connect", method="POST", payload=saved_device
        )


if __name__ == "__main__":
    unittest.main()
