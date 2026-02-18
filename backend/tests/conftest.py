"""Test configuration and fixtures.

Uses a test database with per-test transaction rollback for isolation.
"""
import os
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker, Session

# Override settings before importing app
os.environ["DATABASE_URL"] = os.environ.get(
    "TEST_DATABASE_URL",
    "postgresql://vendora:vendora@localhost:5433/vendora_test",
)

from app.main import app
from app.database import get_db
from app.models.base import Base
from app.models.user import User
from app.models.transaction import Transaction  # noqa: F401
from app.models.invoice import Invoice, InvoiceItem  # noqa: F401
from app.models.subscription import Subscription, WebhookEvent  # noqa: F401
from app.services.auth import hash_password, create_access_token

TEST_DATABASE_URL = os.environ["DATABASE_URL"]

engine = create_engine(TEST_DATABASE_URL, pool_pre_ping=True)
TestSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


@pytest.fixture(scope="session", autouse=True)
def setup_database():
    """Create all tables once per test session, drop at end."""
    # Create pgcrypto extension and trigger function
    with engine.connect() as conn:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS pgcrypto"))
        conn.execute(text("""
            CREATE OR REPLACE FUNCTION update_updated_at_column()
            RETURNS TRIGGER AS $$
            BEGIN
                NEW.updated_at = NOW();
                RETURN NEW;
            END;
            $$ language 'plpgsql'
        """))
        conn.commit()

    Base.metadata.create_all(bind=engine)

    # Create triggers
    with engine.connect() as conn:
        for table_name in ["users", "inventory_items", "transactions", "invoices", "subscriptions", "webhook_events"]:
            conn.execute(text(f"""
                DO $$ BEGIN
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_trigger WHERE tgname = 'update_{table_name}_updated_at'
                    ) THEN
                        CREATE TRIGGER update_{table_name}_updated_at
                            BEFORE UPDATE ON {table_name}
                            FOR EACH ROW
                            EXECUTE FUNCTION update_updated_at_column();
                    END IF;
                END $$
            """))
        conn.commit()

    yield

    Base.metadata.drop_all(bind=engine)


@pytest.fixture()
def db():
    """Provide a transactional database session that rolls back after each test."""
    connection = engine.connect()
    transaction = connection.begin()
    session = TestSessionLocal(bind=connection)

    yield session

    session.close()
    transaction.rollback()
    connection.close()


@pytest.fixture()
def client(db: Session):
    """FastAPI test client with overridden DB dependency."""
    def _override_get_db():
        yield db

    app.dependency_overrides[get_db] = _override_get_db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture()
def test_user(db: Session) -> User:
    """Create a test user and return the User object."""
    user = User(
        email=f"test-{uuid.uuid4().hex[:8]}@vendora.test",
        password_hash=hash_password("TestPass123"),
        business_name="Test Business",
    )
    db.add(user)
    db.flush()
    return user


@pytest.fixture()
def auth_headers(test_user: User) -> dict:
    """Return Authorization headers with a valid JWT for test_user."""
    token = create_access_token(data={"sub": str(test_user.id)})
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture()
def second_user(db: Session) -> User:
    """Create a second test user for ownership enforcement tests."""
    user = User(
        email=f"other-{uuid.uuid4().hex[:8]}@vendora.test",
        password_hash=hash_password("OtherPass123"),
        business_name="Other Business",
    )
    db.add(user)
    db.flush()
    return user


@pytest.fixture()
def second_auth_headers(second_user: User) -> dict:
    """Return Authorization headers for the second user."""
    token = create_access_token(data={"sub": str(second_user.id)})
    return {"Authorization": f"Bearer {token}"}
