import sys
import os

# Add project root to sys.path so we can import 'backend.app' or 'app'
# Depending on how the project is structured. 
# Usually 'app' is top-level within backend/
sys.path.append(os.getcwd())

from app.database import engine
from app.models.base import Base
# Import models to register them
from app.models.user import User
from app.models.inventory import InventoryItem
from app.models.transaction import Transaction
from app.models.invoice import Invoice
from app.models.subscription import Subscription

from sqlalchemy import text

def init_db():
    print("Connecting to DB...")
    # Check dialect
    if engine.dialect.name == "postgresql":
        with engine.connect() as conn:
            conn.execute(text("CREATE EXTENSION IF NOT EXISTS pgcrypto"))
            conn.commit()
    else:
        print(f"Skipping pgcrypto creation for dialect: {engine.dialect.name}")
    
    print("Creating tables...")
    Base.metadata.create_all(bind=engine)
    print("Tables created successfully.")

if __name__ == "__main__":
    init_db()
