"""Auth endpoint tests for /api/v1/auth/*."""

from app.models.user import User
from app.services.auth import create_access_token, hash_password


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
        assert resp.status_code == 403  # HTTPBearer returns 403 when missing

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
