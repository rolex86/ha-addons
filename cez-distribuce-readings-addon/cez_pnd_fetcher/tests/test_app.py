from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
import urllib.parse
from pathlib import Path
from typing import Any


APP_PATH = Path(__file__).parents[1] / "app.py"
SPEC = importlib.util.spec_from_file_location("cez_pnd_fetcher_app", APP_PATH)
assert SPEC and SPEC.loader
app = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = app
SPEC.loader.exec_module(app)


def response(
    status: int,
    body: str,
    *,
    url: str = "https://mepas.cez.cz/cas/login",
    content_type: str = "text/html;charset=UTF-8",
    request_headers: dict[str, str] | None = None,
    response_headers: dict[str, str] | None = None,
) -> Any:
    prepared_request = app.curl_requests.models.Request(
        url=url,
        headers=app.curl_requests.Headers(request_headers or {}),
        method="GET",
    )
    result = app.curl_requests.Response(request=prepared_request)
    result.status_code = status
    result.url = url
    result.headers = app.curl_requests.Headers({"Content-Type": content_type})
    result.headers.update(response_headers or {})
    result.encoding = "utf-8"
    result.content = body.encode()
    result.history = []
    return result


class FakeSession:
    def __init__(self, responses: list[Any]) -> None:
        self.responses = responses
        self.calls = 0
        self.seen: list[tuple[str, str, dict[str, Any]]] = []

    def request(self, method: str, url: str, **kwargs: Any) -> Any:
        self.seen.append((method, url, kwargs))
        item = self.responses[self.calls]
        self.calls += 1
        return item


class AuthUrlTests(unittest.TestCase):
    def test_auth_urls_match_current_portal_parameters(self) -> None:
        service_url, login_url, authorize_url = app.build_auth_urls()

        login_query = urllib.parse.parse_qs(urllib.parse.urlparse(login_url).query)
        self.assertEqual(login_query["service"], [service_url])
        self.assertEqual(
            urllib.parse.urlparse(service_url).path,
            "/cas/oauth2.0/callbackAuthorize",
        )
        self.assertEqual(
            urllib.parse.parse_qs(urllib.parse.urlparse(service_url).query),
            {
                "client_id": ["emiCuDBbivwYxraX.dip.dip.ext.zak.prod.v1"],
                "scope": ["openid"],
                "redirect_uri": ["https://dip.cezdistribuce.cz/irj/portal"],
                "response_type": ["code"],
                "client_name": ["CasOAuthClient"],
            },
        )
        self.assertEqual(
            urllib.parse.urlparse(authorize_url).path,
            "/cas/oidc/oidcAuthorize",
        )

    def test_browser_headers_match_impersonation_and_step_context(self) -> None:
        self.assertEqual(app.IMPERSONATE_TARGET, "chrome146")
        self.assertIn("Chrome/146.0.0.0", app.SESSION_HEADERS["User-Agent"])
        self.assertNotIn("Origin", app.NAVIGATION_HEADERS)
        self.assertNotIn("Origin", app.AUTHORIZE_HEADERS)
        self.assertNotIn("Origin", app.TOKEN_HEADERS)
        self.assertNotIn("Origin", app.WARMUP_HEADERS)
        self.assertEqual(app.FORM_HEADERS["Origin"], "https://mepas.cez.cz")
        self.assertEqual(
            app.DATA_HEADERS["Origin"],
            "https://pnd.cezdistribuce.cz",
        )
        self.assertEqual(app.TOKEN_HEADERS["Sec-Fetch-Mode"], "cors")
        self.assertEqual(app.NAVIGATION_HEADERS["Sec-Fetch-Mode"], "navigate")

    def test_sanitize_url_masks_nested_oauth_values(self) -> None:
        value = (
            "https://mepas.cez.cz/cas/login?service="
            + urllib.parse.quote(
                "https://mepas.cez.cz/callback?code=oauth-secret&ticket=ST-secret"
            )
        )
        sanitized = app.sanitize_url(value)
        self.assertNotIn("oauth-secret", sanitized)
        self.assertNotIn("ST-secret", sanitized)
        service = urllib.parse.parse_qs(
            urllib.parse.urlparse(sanitized).query
        )["service"][0]
        nested = urllib.parse.parse_qs(urllib.parse.urlparse(service).query)
        self.assertEqual(nested["code"], ["***"])
        self.assertEqual(nested["ticket"], ["***"])


class CasValidationTests(unittest.TestCase):
    LOGIN_FORM = """
        <html><form method="post">
        <input name="username"><input name="password">
        <input type="hidden" name="execution" value="e1s1">
        </form></html>
    """

    def test_valid_login_form_is_accepted(self) -> None:
        app.validate_cas_login_page(response(200, self.LOGIN_FORM))

    def test_legacy_403_is_classified_as_obsolete_endpoint(self) -> None:
        item = response(
            403,
            "<html><title>CAS - Central Authentication Service</title></html>",
            url="https://cas.cez.cz/cas/login?service=old",
        )
        with self.assertRaises(app.CasAccessBlockedError) as caught:
            app.validate_cas_login_page(item)
        self.assertEqual(caught.exception.reason, "obsolete_cas_endpoint")

    def test_html_without_execution_has_specific_error(self) -> None:
        with self.assertRaisesRegex(
            app.CasLoginPageChangedError,
            "expected execution token",
        ):
            app.validate_cas_login_page(response(200, "<html>No form</html>"))


class DiagnosticTests(unittest.TestCase):
    def test_dump_redacts_all_authentication_material(self) -> None:
        username = "alice@example.test"
        password = "correct horse battery staple"
        token = "secret-request-token"
        item = response(
            403,
            json.dumps(
                {
                    "username": username,
                    "password": password,
                    "token": token,
                    "next": (
                        "https://example.test/callback?"
                        "code=oauth-secret&ticket=ST-cas-secret"
                    ),
                    "form": (
                        '<input name="execution" value="execution-secret">'
                        '<input value="hidden-code" name="code">'
                    ),
                }
            ),
            content_type="application/json",
            request_headers={
                "Cookie": "session=private-cookie",
                "X-Request-Token": token,
            },
            response_headers={"Set-Cookie": "session=response-cookie"},
        )

        with tempfile.TemporaryDirectory() as temp_dir:
            target = Path(temp_dir)
            app.dump_response(
                target,
                "01_cas_login",
                item,
                secrets=(username, password, token),
            )
            combined = "\n".join(
                path.read_text(encoding="utf-8") for path in target.iterdir()
            )

        for secret in (
            username,
            password,
            token,
            "oauth-secret",
            "ST-cas-secret",
            "execution-secret",
            "hidden-code",
            "private-cookie",
            "response-cookie",
        ):
            self.assertNotIn(secret, combined)
        self.assertIn('"body_sanitized": true', combined)

    def test_failure_diagnostic_does_not_modify_last_good_exports(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            export_path = root / "pnd_export_device.json"
            backup_path = root / "pnd_export_device.last_good.json"
            export_path.write_text("main-good", encoding="utf-8")
            backup_path.write_text("backup-good", encoding="utf-8")
            diagnostic_path = root / "pnd_fetch_device.last_failure.json"

            app.save_failure_diagnostic(
                diagnostic_path,
                stage="cas_login",
                error=app.CasAccessBlockedError(
                    403,
                    "obsolete_cas_endpoint",
                    "legacy_cas_host",
                ),
                debug_dir=root / "run",
                export_path=export_path,
                backup_path=backup_path,
                homeassistant_config_dir=root,
                secrets=("user", "password"),
            )

            self.assertEqual(export_path.read_text(encoding="utf-8"), "main-good")
            self.assertEqual(backup_path.read_text(encoding="utf-8"), "backup-good")
            diagnostic = json.loads(diagnostic_path.read_text(encoding="utf-8"))
            self.assertEqual(diagnostic["stage"], "cas_login")
            self.assertEqual(diagnostic["status_code"], 403)
            self.assertTrue(diagnostic["last_good_export_preserved"])


class RetryTests(unittest.TestCase):
    def test_redirect_history_and_post_to_get_are_preserved(self) -> None:
        redirect = response(
            302,
            "",
            url="https://mepas.cez.cz/cas/login",
            response_headers={
                "Location": "https://dip.cezdistribuce.cz/irj/portal?code=secret"
            },
        )
        final = response(
            200,
            "portal",
            url="https://dip.cezdistribuce.cz/irj/portal?code=secret",
        )
        session = FakeSession([redirect, final])

        result = app.request_with_history(
            session,
            "POST",
            redirect.url,
            headers={
                "Origin": "https://mepas.cez.cz",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            data={"username": "not-logged"},
        )

        self.assertEqual(result.history, [redirect])
        self.assertEqual([call[0] for call in session.seen], ["POST", "GET"])
        redirected_headers = session.seen[1][2]["headers"]
        self.assertNotIn("Origin", redirected_headers)
        self.assertNotIn("Content-Type", redirected_headers)
        self.assertEqual(redirected_headers["Sec-Fetch-Site"], "cross-site")
        self.assertNotIn("data", session.seen[1][2])

    def test_403_is_never_retried(self) -> None:
        session = FakeSession([response(403, "denied")])
        sleeps: list[int] = []
        result = app.request_with_backoff(
            session,
            "GET",
            "https://example.test",
            sleep=sleeps.append,
        )
        self.assertEqual(result.status_code, 403)
        self.assertEqual(session.calls, 1)
        self.assertEqual(sleeps, [])

    def test_5xx_uses_bounded_exponential_backoff(self) -> None:
        session = FakeSession(
            [
                response(500, "error"),
                response(502, "error"),
                response(200, "ok"),
            ]
        )
        sleeps: list[int] = []
        result = app.request_with_backoff(
            session,
            "GET",
            "https://example.test",
            sleep=sleeps.append,
        )
        self.assertEqual(result.status_code, 200)
        self.assertEqual(session.calls, 3)
        self.assertEqual(sleeps, [2, 4])


if __name__ == "__main__":
    unittest.main()
