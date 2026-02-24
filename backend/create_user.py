import sys
import os
from dotenv import load_dotenv

# Ensure we're running from backend root context
sys.path.append(os.getcwd())

load_dotenv()  # Load .env variables

from app.database import SessionLocal
from app.models.user import User
from app.services.auth import hash_password

def create_test_user():
    db = SessionLocal()
    email = "thegamermasterninja@gmail.com"
    password = "Alexander1221"
    
    print(f"Checking user: {email}...")

    try:
        existing = db.query(User).filter(User.email == email).first()
        if existing:
            print(f"User {email} already exists. Upgrade/Reset password.")
            existing.password_hash = hash_password(password)
            existing.subscription_tier = "pro"
            existing.is_partner = True # Testing partner features too
            db.commit()
            print("Password updated & Partner status granted.")
        else:
            print(f"Creating new user: {email}...")
            user = User(
                email=email,
                password_hash=hash_password(password),
                business_name="Ninja Resale",
                subscription_tier="pro",
                is_partner=True
            )
            db.add(user)
            db.commit()
            print(f"User {email} created successfully with Pro tier.")
    except Exception as e:
        print(f"Error creating user: {e}")
        db.rollback()
    finally:
        db.close()

if __name__ == "__main__":
    create_test_user()
