import sys
import os

# Add backend to path
sys.path.append(os.path.join(os.getcwd(), 'backend'))

from app.database import SessionLocal
from app.models.user import User
from app.services.auth import hash_password

def create_test_user():
    db = SessionLocal()
    email = "thegamermasterninja@gmail.com"
    password = "Alexander1221"
    
    # Check if exists
    existing = db.query(User).filter(User.email == email).first()
    if existing:
        print(f"User {email} already exists. resetting password.")
        existing.password_hash = hash_password(password)
        db.commit()
        print("Password updated.")
        return

    # Create new
    user = User(
        email=email,
        password_hash=hash_password(password),
        business_name="Ninja Resale",
        subscription_tier="pro" # Giving you Pro permissions for testing
    )
    db.add(user)
    db.commit()
    print(f"User {email} created successfully with Pro tier.")
    db.close()

if __name__ == "__main__":
    create_test_user()
