"""Auth endpoint tests for /api/v1/auth/*."""

from datetime import datetime, timedelta, timezone

import pytest

from app.models.user import User
from app.models.auth_session import AuthSession
from app.services.auth import (
    create_access_token,
    hash_password,
    hash_password_reset_token,
)
from app.services.email import EmailDeliveryError
from app.schemas.user import _validate_profile_picture


class TestRegister:
    def test_register_success(self, client):
        resp = client.post("/api/v1/auth/register", json={
            "email": "new@vendora.test",
            "password": "SecurePass1",
            "business_name": "My Shop",
        })
        assert resp.status_code == 201
        data = resp.json()
        assert data["email"] == "new@vendora.test"
        assert data["business_name"] == "My Shop"
        assert data["subscription_tier"] == "free"
        assert data["is_partner"] is False
        assert "id" in data

    def test_register_duplicate_email(self, client):
        payload = {"email": "dup@vendora.test", "password": "SecurePass1"}
        client.post("/api/v1/auth/register", json=payload)
        resp = client.post("/api/v1/auth/register", json=payload)
        assert resp.status_code == 409

    def test_register_normalizes_email_and_blocks_case_variant(self, client):
        payload = {"email": "  MixedCase@Vendora.Test ", "password": "SecurePass1"}
        created = client.post("/api/v1/auth/register", json=payload)
        duplicate = client.post(
            "/api/v1/auth/register",
            json={"email": "mixedcase@vendora.test", "password": "SecurePass1"},
        )

        assert created.status_code == 201
        assert created.json()["email"] == "mixedcase@vendora.test"
        assert duplicate.status_code == 409

    def test_register_rejects_invalid_email(self, client):
        resp = client.post(
            "/api/v1/auth/register",
            json={"email": "not-an-email", "password": "SecurePass1"},
        )
        assert resp.status_code == 422


    def test_register_missing_fields(self, client):
        resp = client.post("/api/v1/auth/register", json={"email": "x@y.com"})
        assert resp.status_code == 422

    def test_register_short_password(self, client):
        resp = client.post("/api/v1/auth/register", json={
            "email": "short@vendora.test",
            "password": "abc",
        })
        assert resp.status_code == 422

    def test_register_allowlisted_tester_gets_highest_access(self, client):
        resp = client.post("/api/v1/auth/register", json={
            "email": "management.donxera@gmail.com",
            "password": "SecurePass1",
            "business_name": "QA Ops",
        })
        assert resp.status_code == 201
        data = resp.json()
        assert data["subscription_tier"] == "pro"
        assert data["is_partner"] is True


class TestLogin:
    def test_login_success(self, client):
        client.post("/api/v1/auth/register", json={
            "email": "login@vendora.test",
            "password": "SecurePass1",
        })
        resp = client.post("/api/v1/auth/login", json={
            "email": "login@vendora.test",
            "password": "SecurePass1",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert "access_token" in data
        assert data["token_type"] == "bearer"

    def test_login_normalizes_email(self, client):
        client.post(
            "/api/v1/auth/register",
            json={"email": "normalized@vendora.test", "password": "SecurePass1"},
        )
        resp = client.post(
            "/api/v1/auth/login",
            json={"email": " NORMALIZED@VENDORA.TEST ", "password": "SecurePass1"},
        )
        assert resp.status_code == 200


    def test_login_wrong_password(self, client):
        client.post("/api/v1/auth/register", json={
            "email": "wrong@vendora.test",
            "password": "SecurePass1",
        })
        resp = client.post("/api/v1/auth/login", json={
            "email": "wrong@vendora.test",
            "password": "WrongPassword",
        })
        assert resp.status_code == 401

    def test_login_nonexistent_user(self, client):
        resp = client.post("/api/v1/auth/login", json={
            "email": "ghost@vendora.test",
            "password": "SomePass123",
        })
        assert resp.status_code == 401

    def test_login_upgrades_existing_allowlisted_tester(self, client, db):
        user = User(
            email="management.donxera@gmail.com",
            password_hash=hash_password("SecurePass1"),
            subscription_tier="free",
            is_partner=False,
        )
        db.add(user)
        db.commit()

        resp = client.post("/api/v1/auth/login", json={
            "email": "management.donxera@gmail.com",
            "password": "SecurePass1",
        })
        assert resp.status_code == 200

        db.refresh(user)
        assert user.subscription_tier == "pro"
        assert user.is_partner is True


class TestPasswordReset:
    def test_forgot_password_masks_email_delivery_failure(self, client, db, monkeypatch):
        user = User(email="delivery@vendora.test", password_hash=hash_password("OldPassword1"))
        db.add(user)
        db.commit()

        def fail(*args):
            raise EmailDeliveryError("provider unavailable")

        monkeypatch.setattr("app.routers.auth.send_password_reset_email", fail)
        response = client.post("/api/v1/auth/forgot-password", json={"email": user.email})
        assert response.status_code == 202
        assert response.json()["message"].startswith("If an account exists")
    def test_forgot_password_is_generic_and_stores_only_hash(
        self, client, db, monkeypatch
    ):
        user = User(
            email="reset@vendora.test",
            password_hash=hash_password("OldPassword1"),
        )
        db.add(user)
        db.commit()
        delivered = {}

        def fake_send(email, token):
            delivered["email"] = email
            delivered["token"] = token

        monkeypatch.setattr(
            "app.routers.auth.send_password_reset_email", fake_send
        )
        resp = client.post(
            "/api/v1/auth/forgot-password",
            json={"email": " RESET@VENDORA.TEST "},
        )

        assert resp.status_code == 202
        assert resp.json()["message"].startswith("If an account exists")
        db.refresh(user)
        assert delivered["email"] == user.email
        assert user.password_reset_token_hash == hash_password_reset_token(
            delivered["token"]
        )
        assert delivered["token"] != user.password_reset_token_hash
        assert user.password_reset_expires_at is not None

    def test_forgot_password_unknown_email_has_same_response(
        self, client, monkeypatch
    ):
        delivered = []
        monkeypatch.setattr(
            "app.routers.auth.send_password_reset_email",
            lambda email, token: delivered.append((email, token)),
        )

        resp = client.post(
            "/api/v1/auth/forgot-password",
            json={"email": "missing@vendora.test"},
        )

        assert resp.status_code == 202
        assert resp.json()["message"].startswith("If an account exists")
        assert delivered == []

    def test_reset_password_changes_login_and_consumes_token(
        self, client, db, monkeypatch
    ):
        user = User(
            email="consume@vendora.test",
            password_hash=hash_password("OldPassword1"),
        )
        db.add(user)
        db.commit()
        delivered = {}
        monkeypatch.setattr(
            "app.routers.auth.send_password_reset_email",
            lambda email, token: delivered.update(token=token),
        )
        client.post(
            "/api/v1/auth/forgot-password",
            json={"email": user.email},
        )

        resp = client.post(
            "/api/v1/auth/reset-password",
            json={"token": delivered["token"], "password": "NewPassword2"},
        )
        assert resp.status_code == 200
        assert client.post(
            "/api/v1/auth/login",
            json={"email": user.email, "password": "NewPassword2"},
        ).status_code == 200
        assert client.post(
            "/api/v1/auth/login",
            json={"email": user.email, "password": "OldPassword1"},
        ).status_code == 401

        reused = client.post(
            "/api/v1/auth/reset-password",
            json={"token": delivered["token"], "password": "AnotherPass3"},
        )
        assert reused.status_code == 400

    def test_reset_password_rejects_expired_token(self, client, db):
        token = "expired-token-that-is-long-enough-for-validation"
        user = User(
            email="expired@vendora.test",
            password_hash=hash_password("OldPassword1"),
            password_reset_token_hash=hash_password_reset_token(token),
            password_reset_expires_at=datetime.now(timezone.utc)
            - timedelta(minutes=1),
        )
        db.add(user)
        db.commit()

        resp = client.post(
            "/api/v1/auth/reset-password",
            json={"token": token, "password": "NewPassword2"},
        )
        assert resp.status_code == 400


class TestMe:
    def test_get_me(self, client, auth_headers, test_user):
        resp = client.get("/api/v1/auth/me", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["email"] == test_user.email
        assert data["subscription_tier"] == "free"

    def test_get_me_invalid_token(self, client):
        resp = client.get("/api/v1/auth/me", headers={
            "Authorization": "Bearer invalid.token.here"
        })
        assert resp.status_code == 401

    def test_get_me_no_token(self, client):
        resp = client.get("/api/v1/auth/me")
        assert resp.status_code == 401

    def test_get_me_upgrades_existing_allowlisted_tester(self, client, db):
        user = User(
            email="management.donxera@gmail.com",
            password_hash=hash_password("SecurePass1"),
            subscription_tier="free",
            is_partner=False,
        )
        db.add(user)
        db.commit()
        db.refresh(user)

        token = create_access_token(data={"sub": str(user.id)})
        resp = client.get("/api/v1/auth/me", headers={
            "Authorization": f"Bearer {token}"
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["subscription_tier"] == "pro"
        assert data["is_partner"] is True


class TestProfileValidation:
    def test_profile_business_name_only_and_none_helper(self, client, auth_headers):
        response = client.patch(
            "/api/v1/auth/profile",
            json={"business_name": "Updated Shop"},
            headers=auth_headers,
        )
        assert response.status_code == 200
        assert response.json()["business_name"] == "Updated Shop"
        assert _validate_profile_picture(None) is None

    def test_profile_picture_rejects_bad_padding(self, client, auth_headers):
        response = client.patch(
            "/api/v1/auth/profile",
            json={"profile_picture": "data:image/png;base64,a"},
            headers=auth_headers,
        )
        assert response.status_code == 422
    def test_profile_picture_accepts_supported_data_url(self, client, auth_headers):
        response = client.patch(
            "/api/v1/auth/profile",
            json={"profile_picture": "data:image/png;base64,aGVsbG8="},
            headers=auth_headers,
        )
        assert response.status_code == 200
        assert response.json()["profile_picture"].startswith("data:image/png;base64,")

    @pytest.mark.parametrize(
        "picture",
        [
            "https://example.com/avatar.png",
            "data:image/svg+xml;base64,PHN2Zz4=",
            "data:image/png;base64,not-valid!",
        ],
    )
    def test_profile_picture_rejects_unsafe_or_invalid_data(self, client, auth_headers, picture):
        response = client.patch(
            "/api/v1/auth/profile",
            json={"profile_picture": picture},
            headers=auth_headers,
        )
        assert response.status_code == 422


class TestSessionsAndAccountLifecycle:
    def test_login_issues_refresh_token_and_refresh_rotates_it(self, client, test_user, db):
        login = client.post(
            "/api/v1/auth/login",
            json={"email": test_user.email, "password": "TestPass123"},
        )
        assert login.status_code == 200
        original = login.json()
        assert original["refresh_token"]
        assert db.query(AuthSession).filter(AuthSession.user_id == test_user.id).count() == 1

        refreshed = client.post(
            "/api/v1/auth/refresh",
            json={"refresh_token": original["refresh_token"]},
        )
        assert refreshed.status_code == 200
        replacement = refreshed.json()
        assert replacement["refresh_token"] != original["refresh_token"]
        assert client.get(
            "/api/v1/auth/me",
            headers={"Authorization": f"Bearer {replacement['access_token']}"},
        ).status_code == 200
        assert client.post(
            "/api/v1/auth/refresh",
            json={"refresh_token": original["refresh_token"]},
        ).status_code == 401

    def test_logout_revokes_the_access_session(self, client, test_user):
        session = client.post(
            "/api/v1/auth/login",
            json={"email": test_user.email, "password": "TestPass123"},
        ).json()
        assert client.post(
            "/api/v1/auth/logout",
            json={"refresh_token": session["refresh_token"]},
        ).status_code == 200
        response = client.get(
            "/api/v1/auth/me",
            headers={"Authorization": f"Bearer {session['access_token']}"},
        )
        assert response.status_code == 401
        assert response.json()["detail"] == "Session has expired or been revoked."
        assert client.post(
            "/api/v1/auth/logout",
            json={"refresh_token": session["refresh_token"]},
        ).status_code == 200

    def test_account_deletion_requires_password_and_confirmation(self, client, auth_headers):
        assert client.request(
            "DELETE",
            "/api/v1/auth/account",
            json={"password": "wrong-password", "confirmation": "DELETE"},
            headers=auth_headers,
        ).status_code == 401
        assert client.request(
            "DELETE",
            "/api/v1/auth/account",
            json={"password": "TestPass123", "confirmation": "delete"},
            headers=auth_headers,
        ).status_code == 422

    def test_account_deletion_removes_user(self, client, auth_headers, test_user, db):
        user_id = test_user.id
        response = client.request(
            "DELETE",
            "/api/v1/auth/account",
            json={"password": "TestPass123", "confirmation": "DELETE"},
            headers=auth_headers,
        )
        assert response.status_code == 200
        db.expire_all()
        assert db.get(User, user_id) is None

    def test_profile_picture_rejects_more_than_five_megabytes(self, client, auth_headers):
        import base64

        picture = "data:image/jpeg;base64," + base64.b64encode(b"x" * (5 * 1024 * 1024 + 1)).decode()
        response = client.patch(
            "/api/v1/auth/profile",
            json={"profile_picture": picture},
            headers=auth_headers,
        )
        assert response.status_code == 422
